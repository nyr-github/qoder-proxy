// pnpm run check: verify the /v1 direct-HTTP auth pool is ready (primary
// transport); the CLI subprocess transport (/v0) is only checked when re-enabled
// via QODER_ENABLE_CLI=1, since it is hidden by default.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { cliPath } = require('../src/config');

function env() {
    const e = { ...process.env };
    delete e.QODER_AGENT_SDK_ENTRYPOINT;
    return e;
}

function run(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cliPath, args, { env: env() });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => (stdout += d));
        child.stderr.on('data', d => (stderr += d));
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

// Binary is found if it resolved to a real file, or a bare name exists in PATH.
async function findBinary() {
    if (path.isAbsolute(cliPath)) {
        if (fs.existsSync(cliPath)) return cliPath;
        return null;
    }
    const checker = process.platform === 'win32' ? 'where' : 'which';
    return new Promise(resolve => {
        const child = spawn(checker, [cliPath], { env: env() });
        let out = '';
        child.stdout.on('data', d => (out += d));
        child.on('close', code => resolve(code === 0 && out.trim() ? out.trim().split(/\r?\n/)[0] : null));
        child.on('error', () => resolve(null));
    });
}

// `status -o json` works both logged-in and logged-out; judge by output content.
function parseLoggedIn(result) {
    if (result.code !== 0) return { ok: false, reason: (result.stderr || result.stdout).trim() };
    let data = null;
    try { data = JSON.parse(result.stdout); } catch { }
    const loggedOut = data && (
        data.logged_in === false || data.isLoggedIn === false || data.authenticated === false ||
        /not\s+logged\s+in|unauthenticated|please\s+login|未登录/i.test(JSON.stringify(data))
    );
    if (loggedOut) return { ok: false, reason: 'not logged in' };
    if (!data && /not\s+logged\s+in|please\s+login|未登录/i.test(result.stdout)) {
        return { ok: false, reason: 'not logged in' };
    }
    return { ok: true, data };
}

async function main() {
    console.log(`qoder-proxy check (pnpm run check)\n`);

    // [1] /v1 account pool — the primary transport. Both product lines can be
    // logged in at once; each login is addressed by its model-name suffix.
    const status = require('../src/qoder-auth').authStatus();
    const wasmReady = fs.existsSync(require('../src/qoder-wasm').WASM_PATH);
    if (status.configured) {
        console.log(`[1/2] /v1 pool: ${status.accounts.length} account(s)`);
        for (const a of status.accounts) {
            const flags = [];
            if (!a.enabled) flags.push('disabled');
            if (a.expired) flags.push('token expired (auto-renews)');
            if (!a.refreshable && !a.transient) flags.push('NOT refreshable — will need re-login');
            if (a.rate_limited_models.length) flags.push(`queued: ${a.rate_limited_models.join(',')}`);
            if (a.transient) flags.push('from QODER_ACCESS_TOKEN');
            console.log(`      ${a.alias}  ${a.product}  ${a.nickname || '(no name)'}${a.uid ? '' : '  [no uid — encrypted models will fail]'}${flags.length ? `  — ${flags.join(', ')}` : ''}`);
        }
        for (const flow of status.login) {
            if (flow.state === 'pending') console.log(`      pending ${flow.product} login: ${flow.login_url}`);
        }
        console.log(wasmReady
            ? `      wasm signer present (catalog models by name or short key + Qoder CN usable)`
            : `      WARNING: vendor/qoder-auth-wasm.wasm missing — catalog models (Qwen3.8-Flash / qfmodel, ...) and every CN model cannot be served`);
    } else {
        console.error(`[1/2] /v1 pool is EMPTY — the proxy cannot serve any request without a login.`);
        console.error(`      Run: pnpm run login                 (Qoder international)`);
        console.error(`           pnpm run login --product qodercn   (Qoder 中国版)`);
        process.exit(1);
    }

    // [2] CLI transport (/v0) — hidden by default; only verify when enabled.
    if (process.env.QODER_ENABLE_CLI === '1') {
        const binary = await findBinary();
        if (!binary) {
            console.error(`[2/2] qodercli NOT FOUND (resolved to: "${cliPath}")`);
            console.error(`      Install qodercli or set QODER_CLI_PATH to the binary path.`);
            process.exit(1);
        }
        console.log(`[2/2] qodercli found: ${binary}`);
        let result;
        try {
            result = await run(['status', '-o', 'json']);
        } catch (e) {
            console.error(`      Failed to run "qodercli status": ${e.message}`);
            process.exit(1);
        }
        const status = parseLoggedIn(result);
        if (!status.ok) {
            console.error(`[2/2] qodercli NOT LOGGED IN (${status.reason})`);
            console.error(`      Run: ${binary} login`);
            process.exit(1);
        }
        console.log(`[2/2] qodercli logged in (/v0 enabled)`);
    } else {
        console.log(`[2/2] CLI transport /v0 hidden (default). Set QODER_ENABLE_CLI=1 to re-enable.`);
    }

    console.log(`\nOK. Start the proxy with: pnpm start`);
}

main();
