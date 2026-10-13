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

function chatStream(model, messages, onEvent) {
  const { system, prompt } = messagesToPrompt(messages);

  const args = ['--print', '--output-format', 'stream-json', '-m', model];
  if (system) args.push('--system-prompt', system);
  args.push(prompt);

  const child = spawn(cliPath, args, { env: cliEnv() });

  const rl = readline.createInterface({ input: child.stdout });
  let prevText = '';
  let usage = null;

  rl.on('line', line => {
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
    }
  });

  child.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) onEvent({ type: 'error', message: msg });
  });

  child.on('error', err => onEvent({ type: 'error', message: err.message }));
  child.on('close', () => onEvent({ type: 'close', text: prevText, usage }));

  return child;
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
