const { spawn } = require('child_process');
const readline = require('readline');
const { cliPath } = require('./config');

function cliEnv() {
  const env = { ...process.env };
  // Unset SDK entrypoint so CLI runs in normal mode
  delete env.QODER_AGENT_SDK_ENTRYPOINT;
  return env;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { env: cliEnv() });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `qodercli exited with code ${code}`));
      else resolve(stdout);
    });
  });
}

async function listModels() {
  const out = await run(['--list-models']);

  // Try JSON array first
  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) {
      return parsed.map(m => (typeof m === 'string' ? { id: m } : { id: m.id || m.name || m.model, ...m }));
    }
  } catch { }

  // Fall back to line-by-line text parsing
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !/^(available|models|usage|error)/i.test(l))
    .map(l => {
      const id = l.split(/\s+/)[0].replace(/[*•\-]\s*/, '');
      return id ? { id, name: l } : null;
    })
    .filter(Boolean);
}

function messagesToPrompt(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => contentToText(m.content)).join('\n');
  const turns = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${contentToText(m.content)}`)
    .join('\n\n');
  return { system: system || undefined, prompt: turns };
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : part.text || ''))
      .join('');
  }
  return String(content ?? '');
}

// --- Warm process pool (Option A) ------------------------------------------
// Spawning qodercli costs ~1.3s of Node/CLI boot before the first turn is even
// accepted. We keep a few pre-booted, NEVER-USED processes per model so a
// request can write its message to an already-warm stdin immediately. Each
// process is SINGLE-USE: after one turn its session state is dirty, so we
// retire (kill) it and pre-boot a replacement in the background to keep the
// pool warm. This drops per-request latency from ~3.4s to ~2.1s while keeping
// the stateless OpenAI semantics (no cross-request context bleed).
const POOL_SIZE = parseInt(process.env.QODER_POOL_SIZE || '2', 10);
const pools = new Map(); // model -> WarmProc[]

class WarmProc {
  constructor(model) {
    this.model = model;
    this.bornAt = Date.now();
    this.dead = false;
    this.child = spawn(cliPath, [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--no-session-persistence', '-m', model,
    ], { env: cliEnv() });
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.lineHandlers = new Set();
    this.errHandlers = new Set();
    this.closeHandlers = new Set();
    this.rl.on('line', l => { for (const h of [...this.lineHandlers]) h(l); });
    this.child.stderr.on('data', d => { for (const h of [...this.errHandlers]) h(d); });
    const markDead = () => { this.dead = true; for (const h of [...this.closeHandlers]) h(); };
    this.child.on('close', markDead);
    this.child.on('error', markDead);
  }
  onLine(h) { this.lineHandlers.add(h); return () => this.lineHandlers.delete(h); }
  onErr(h) { this.errHandlers.add(h); return () => this.errHandlers.delete(h); }
  onClose(h) { this.closeHandlers.add(h); return () => this.closeHandlers.delete(h); }
  sendUser(text) {
    this.child.stdin.write(JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n');
  }
  kill() { this.dead = true; try { this.rl.close(); } catch { } try { this.child.kill(); } catch { } }
}

// Top the idle pool back up to POOL_SIZE (spawns replacements in background).
function ensureIdle(model) {
  const alive = (pools.get(model) || []).filter(p => !p.dead);
  for (let i = alive.length; i < POOL_SIZE; i++) alive.push(new WarmProc(model));
  pools.set(model, alive);
}

function acquire(model) {
  const alive = (pools.get(model) || []).filter(p => !p.dead);
  let proc = alive.shift(); // take one idle (already-booted) process, if any
  pools.set(model, alive);
  ensureIdle(model); // refill for subsequent requests
  if (!proc) proc = new WarmProc(model); // first-ever request to this model pays boot
  return proc;
}

function chatStream(model, messages, onEvent) {
  const { system, prompt } = messagesToPrompt(messages);
  // Warm procs are pre-spawned before we know the request, so --system-prompt
  // can't be baked into launch args; fold it into the first user turn instead.
  const fullText = system ? `${system}\n\n${prompt}` : prompt;

  const proc = acquire(model);
  const tSend = Date.now();
  let prevText = '';
  let usage = null;
  let finalized = false;

  const offLine = proc.onLine(line => {
    line = line.trim();
    if (!line) return;

    let event;
    try { event = JSON.parse(line); } catch { return; }

    // Cumulative assistant message
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (block.text.length > prevText.length) {
            const delta = block.text.slice(prevText.length);
            prevText = block.text;
            onEvent({ type: 'delta', text: delta });
          }
        }
      }
    }

    // Anthropic-style delta events
    if (event.type === 'content_block_delta' && event.delta?.text) {
      onEvent({ type: 'delta', text: event.delta.text });
      prevText += event.delta.text;
    }

    if (event.type === 'result') {
      usage = event.usage || null;
      onEvent({ type: 'done', usage });
      finalize();
    }
  });

  const offErr = proc.onErr(d => {
    const msg = d.toString().trim();
    if (msg) onEvent({ type: 'error', message: msg });
  });

  // Fallback finalize if the process dies without emitting a result (crash).
  const offClose = proc.onClose(() => finalize());

  function finalize() {
    if (finalized) return;
    finalized = true;
    offLine(); offErr(); offClose();
    const preage = tSend - proc.bornAt;
    const label = preage > 200 ? `warm(idle ${preage}ms)` : 'cold';
    console.log(`[perf] model=${model} ${label} turn=${Date.now() - tSend}ms`);
    proc.kill(); // single-use: retire the now-dirty session
    onEvent({ type: 'close', text: prevText, usage });
  }

  proc.sendUser(fullText);

  // index.js uses the returned object only to .kill() on client disconnect.
  return { kill: () => finalize() };
}

function chatComplete(model, messages) {
  return new Promise((resolve, reject) => {
    let text = '', usage = null, errMsg = null;

    chatStream(model, messages, event => {
      if (event.type === 'delta') text += event.text;
      if (event.type === 'done') usage = event.usage;
      if (event.type === 'error') errMsg = event.message;
      if (event.type === 'close') {
        if (errMsg && !text) reject(new Error(errMsg));
        else resolve({ text, usage });
      }
    });
  });
}

async function getStatus() {
  const out = await run(['status', '-o', 'json']);
  try {
    return JSON.parse(out);
  } catch {
    return { raw: out.trim() };
  }
}

module.exports = { listModels, chatStream, chatComplete, getStatus };
