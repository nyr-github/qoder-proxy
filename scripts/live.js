// Optional end-to-end smoke test against the real upstream: it spends quota on
// whatever account is in the pool, so it is never run by `selftest` and is only
// invoked manually (`pnpm run live [model ...]`).
//
// Models default to one account from each product line found in the pool, plus a
// public-endpoint name when the international product is logged in.
const { spawn } = require('child_process');
const accounts = require('../src/accounts');

const PORT = Number(process.env.LIVE_PORT || 8796);
const base = `http://127.0.0.1:${PORT}/v1`;
const PROMPT = '只回复两个字母：OK';

const server = spawn(process.execPath, ['src/index.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', d => process.stderr.write(`[srv] ${d}`));
server.stderr.on('data', d => process.stderr.write(`[srv!] ${d}`));

async function call(label, body, stream) {
    const started = Date.now();
    const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!stream) {
        const text = await res.text();
        console.log(`\n### ${label} -> ${res.status} (${Date.now() - started}ms)\n${text.slice(0, 300)}`);
        return;
    }
    let out = '';
    let frames = 0;
    let done = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (; ;) {
        const { value, done: closed } = await reader.read();
        if (closed) break;
        const chunk = decoder.decode(value, { stream: true });
        frames += (chunk.match(/data:/g) || []).length;
        for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload.length === 0) continue;
            if (payload === '[DONE]') { done = true; continue; }
            try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                if (delta && typeof delta.content === 'string') out += delta.content;
            } catch { /* partial line */ }
        }
    }
    // A stream that ends without [DONE] is the bug this check exists for: the
    // caller would otherwise wait on a half-open connection forever.
    const verdict = done ? 'terminated' : 'MISSING [DONE]';
    console.log(`\n### ${label} -> ${res.status} (${Date.now() - started}ms) frames=${frames} ${verdict}\n${out.slice(0, 200)}`);
}

function defaults() {
    const list = accounts.list().filter(a => a.enabled !== false);
    if (!list.length) return [];
    // 默认用例按真实模型名取名（短名仍然可用，末尾留一条做回归）。
    const out = list.map(a => ({ model: `Qwen3.8-Flash-${a.product}@${a.alias}`, label: `encrypted Qwen3.8-Flash-${a.product}@${a.alias}`, stream: false }));
    out.push({ model: `Qwen3.8-Flash-${list[0].product}@${list[0].alias}`, label: `encrypted stream by listed id`, stream: true });
    if (list.some(a => a.product === 'qoder')) {
        out.push({ model: 'qwen-flash-qoder@a1', label: 'public endpoint by listed id', stream: false });
    }
    out.push({ model: 'Qwen3.8-Flash', label: 'bare display name (auto account)', stream: false });
    out.push({ model: 'qfmodel', label: 'bare short key qfmodel (still accepted)', stream: false });
    return out;
}

(async () => {
    await new Promise(r => setTimeout(r, 900));
    const args = process.argv.slice(2);
    const cases = args.length
        ? args.flatMap(m => [
            { model: m, label: `${m} (non-stream)`, stream: false },
            { model: m, label: `${m} (stream)`, stream: true },
        ])
        : defaults();
    if (!cases.length) {
        console.log('no enabled account in the pool — run `pnpm run login` first');
    }
    for (const c of cases) await call(c.label, { model: c.model, stream: c.stream, messages: [{ role: 'user', content: PROMPT }] }, c.stream);
    server.kill();
    process.exit(0);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
