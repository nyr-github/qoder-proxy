// npm run check: verify qodercli exists and is logged in.
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
    console.log(`qoder-proxy check\n`);

    const binary = await findBinary();
    if (!binary) {
        console.error(`[1/2] qodercli NOT FOUND (resolved to: "${cliPath}")`);
        console.error(`      Install qodercli or set QODER_CLI_PATH to the binary path.`);
        process.exit(1);
    }
    console.log(`[1/2] qodercli found: ${binary}`);

    let result;
    try {
        result = await run(['status', '-o', 'json']);
    } catch (e) {
        console.error(`[2/2] Failed to run "qodercli status": ${e.message}`);
        process.exit(1);
    }
    const status = parseLoggedIn(result);
    if (!status.ok) {
        console.error(`[2/2] NOT LOGGED IN (${status.reason})`);
        console.error(`      Run: ${binary} login`);
        process.exit(1);
    }
    console.log(`[2/2] logged in`);
    if (status.data) console.log(`      ${JSON.stringify(status.data)}`);

    console.log(`\nOK. Start the proxy with: npm start`);
}

main();
