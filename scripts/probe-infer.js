// Probe: reachability of the encrypted inference endpoints (intl + CN),
// using a real WASM-signed request built from placeholder credentials.
// Any structured upstream answer (403 / auth error / model error) proves the
// route exists; a transport reset or 404 means we cannot use that host.
const wasm = require('../src/qoder-wasm');

const HOSTS = [
    ['intl', 'https://api2.qoder.sh'],
    ['cn', 'https://gateway.qoder.com.cn'],
];

async function probe(label, host) {
    const user = { uid: 'probe-uid-0001', securityOauthToken: 'probe-token-abc' };
    let req;
    try {
        const client = await wasm.EncryptedInfer.create({
            user,
            machineId: 'probe-machine-id',
            metadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
            host,
        });
        req = client.prepareInfer({ modelKey: 'qfmodel', userText: 'hi', business: { type: 'agent' } });
    } catch (e) {
        console.log(`[${label}] wasm failed: ${e.message}`);
        return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
        const res = await fetch(req.url, {
            method: 'POST',
            headers: req.headers,
            body: req.body,
            signal: controller.signal,
        });
        const text = await res.text();
        console.log(`[${label}] http=${res.status} body=${text.slice(0, 220).replace(/\n/g, ' ')}`);
    } catch (e) {
        console.log(`[${label}] NETWORK ERROR: ${e.name}: ${e.message}${e.cause ? ` (cause: ${e.cause.code || e.cause.message})` : ''}`);
    } finally {
        clearTimeout(timer);
    }
}

(async () => {
    for (const [label, host] of HOSTS) await probe(label, host);
})();
