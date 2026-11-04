// Probe: instantiate the vendored Qoder WASM and build a real encrypted
// inference request, offline, with placeholder credentials. Verifies the
// wasm-bindgen bridge works under this Node version.
const wasm = require('../src/qoder-wasm');

async function main() {
    const user = { uid: 'probe-uid-0001', securityOauthToken: 'probe-token-abc' };
    const machineId = 'probe-machine-id';

    const fields = await wasm.generateRuntimeAuthFields(user);
    console.log('authFields:', Object.keys(fields), 'encrypt_user_info.len=', fields.encrypt_user_info.length, 'key.len=', fields.key.length);

    const client = await wasm.EncryptedInfer.create({
        user,
        machineId,
        metadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
        host: 'https://api2.qoder.sh',
    });
    console.log('context created OK');

    const req = client.prepareInfer({
        modelKey: 'qfmodel',
        userText: 'hello probe',
        isReasoning: true,
        business: { type: 'agent' },
    });
    console.log('url           =', req.url);
    console.log('header keys   =', Object.keys(req.headers).join(', '));
    console.log('authorization =', String(req.headers.Authorization || req.headers.authorization || '').slice(0, 60) + '...');
    console.log('body length   =', req.body.length, '(encrypted, not JSON)');
    console.log('body head     =', req.body.slice(0, 48));
}

main().catch(e => { console.error('PROBE FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
