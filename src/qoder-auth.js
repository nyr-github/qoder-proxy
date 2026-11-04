// Qoder device-flow OAuth (PKCE) for the /v1 direct-HTTP transport.
//
// This module only *logs people in*; token storage, refresh and routing live in
// `accounts.js` (one pool entry per login, both product lines side by side).
//
// Protocol details mirror what the official client does (studied via the
// dsh-our-free-model project). Non-obvious quirks that are load-bearing:
//   - challenge must be base64url WITHOUT padding ("=" breaks server validation)
//   - the poll endpoint lives on openApiBase, NOT authBase (authBase 401s it)
//   - HTTP 404 from poll means "user has not authorized yet", keep polling
//   - client_id must be the PROD one and is product-specific (a wrong one is
//     accepted by the authorize page and rejected after the callback, which
//     reads as "invalid parameters, please login from the IDE client")
//   - refresh body is {refresh_token, machine_id}; machine_id must be persisted
//   - uid (user_id) is required by the encrypted inference path — a request
//     signed without it surfaces as `Signature invalid (101)`, so we keep it
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./config');
const products = require('./products');
const accounts = require('./accounts');

const REQUEST_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 300_000;   // 5 minutes, same as the client
const POLL_INTERVAL_MS = 1_000;
const POLL_MAX_FAILURES = 5;        // consecutive network failures tolerated

const DEVICE_SELECT_PATH = '/device/selectAccounts';
const POLL_PATH = '/api/v1/deviceToken/poll';

// RFC 7636 unreserved set (66 chars), same alphabet the client uses.
const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

class AuthError extends Error {
    constructor(message, status = 401) {
        super(message);
        this.name = 'AuthError';
        this.status = status;
    }
}

function createPkce() {
    const length = 43 + Math.floor(86 * Math.random());
    const bytes = crypto.randomBytes(length);
    let verifier = '';
    for (let i = 0; i < length; i++) {
        verifier += PKCE_ALPHABET[bytes[i] % PKCE_ALPHABET.length];
    }
    const challenge = crypto.createHash('sha256').update(verifier).digest()
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return { verifier, challenge };
}

// Stable per-install device id: reused across re-logins so the server sees the
// same "machine" (it participates in the device binding on refresh).
function getMachineId() {
    try {
        const saved = fs.readFileSync(config.machineIdFile, 'utf8').trim();
        if (saved) return saved;
    } catch { }
    return crypto.randomUUID();
}

function buildAuthUrl(session) {
    const query = new URLSearchParams({
        challenge: session.pkce.challenge,
        challenge_method: 'S256',
        nonce: session.nonce,
        machine_id: session.machineId,
        client_id: session.product.clientId,
    });
    return `${session.product.authBase}${DEVICE_SELECT_PATH}?${query.toString()}`;
}

function buildPollUrl(session) {
    const query = new URLSearchParams({
        nonce: session.nonce,
        verifier: session.pkce.verifier,
        challenge_method: 'S256',
    });
    return `${session.product.openApiBase}${POLL_PATH}?${query.toString()}`;
}

// Accepts both the login response ("token") and the refresh response
// ("device_token"); timestamps may be ISO strings, seconds or milliseconds.
function parseTokenPayload(body) {
    if (typeof body !== 'object' || body === null) return { accessToken: '' };
    const str = keys => {
        for (const k of keys) {
            const v = body[k];
            if (typeof v === 'string' && v.length > 0) return v;
        }
        return undefined;
    };
    const ts = value => {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
        }
        if (typeof value === 'string' && value.length > 0) {
            const parsed = Date.parse(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
    };
    return {
        accessToken: str(['token', 'device_token', 'access_token']) ?? '',
        refreshToken: str(['refresh_token', 'refreshToken']),
        expiresAt: ts(body.expires_at ?? body.expiresAt),
        refreshTokenExpiresAt: ts(body.refresh_token_expires_at ?? body.refreshTokenExpiresAt),
        uid: str(['user_id', 'userId']),
        userName: str(['user_name', 'userName']),
    };
}

// security_oauth_token and access_token are written with the same value:
// the client reads `security_oauth_token ?? access_token`, dual-write covers both.
function buildCredential(payload, extra) {
    return {
        security_oauth_token: payload.accessToken,
        access_token: payload.accessToken,
        refresh_token: payload.refreshToken,
        expire_time: payload.expiresAt,
        refresh_token_expire_time: payload.refreshTokenExpiresAt,
        machine_id: extra.machineId,
        uid: payload.uid,
        nickname: payload.userName,
    };
}

// --- interactive login (device flow) ----------------------------------------

// One pending flow per product, so an international login does not silently
// swallow a China-version login started moments later (and vice versa).
const activeLogins = new Map(); // productId -> flow

function openBrowser(url) {
    try {
        const opts = { stdio: 'ignore', detached: true };
        let child;
        if (process.platform === 'win32') {
            // cmd /c start cuts the URL at the first unquoted `&` (our query
            // string is full of them) — pass it explicitly double-quoted.
            child = spawn('cmd', ['/c', 'start', '""', `"${url}"`], { ...opts, windowsVerbatimArguments: true });
        } else if (process.platform === 'darwin') {
            child = spawn('open', [url], opts);
        } else {
            child = spawn('xdg-open', [url], opts);
        }
        child.unref();
    } catch { }
}

function defaultProductId() {
    return (products.resolveProduct(process.env.QODER_PRODUCT) || products.PRODUCTS.qoder).id;
}

function startLogin({ product, open = true } = {}) {
    const preset = products.resolveProduct(product || defaultProductId());
    if (!preset) {
        throw new AuthError(`unknown product "${product}" (expected one of: ${products.productIds().join(', ')})`, 400);
    }
    const existing = activeLogins.get(preset.id);
    if (existing && existing.state === 'pending') {
        return { loginUrl: existing.loginUrl, reused: true, product: preset.id };
    }

    const session = {
        product: preset,
        pkce: createPkce(),
        nonce: crypto.randomUUID(),
        machineId: getMachineId(),
    };
    const loginUrl = buildAuthUrl(session);
    const controller = new AbortController();
    const flow = { product: preset.id, loginUrl, state: 'pending', error: undefined, account: undefined, startedAt: Date.now(), controller, done: null };
    activeLogins.set(preset.id, flow);

    const done = (async () => {
        const deadline = Date.now() + LOGIN_TIMEOUT_MS;
        let failures = 0;
        const sleep = ms => new Promise((r, rej) => {
            const t = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); r(); }, ms);
            const onAbort = () => { clearTimeout(t); rej(new Error('login cancelled')); };
            controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        while (Date.now() < deadline) {
            let res;
            try {
                res = await fetch(buildPollUrl(session), {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                    signal: controller.signal,
                });
                failures = 0;
            } catch (e) {
                if (controller.signal.aborted) throw e;
                if (++failures >= POLL_MAX_FAILURES) throw new Error(`cannot reach Qoder login service (${failures} consecutive failures): ${e.message}`);
                await sleep(POLL_INTERVAL_MS);
                continue;
            }
            if (res.status === 404) { await sleep(POLL_INTERVAL_MS); continue; } // not authorized yet
            if (!res.ok) throw new Error(`login service returned HTTP ${res.status}`);
            const payload = parseTokenPayload(await res.json());
            if (!payload.accessToken) { await sleep(POLL_INTERVAL_MS); continue; }
            const cred = buildCredential(payload, { machineId: session.machineId });
            // The device-token poll response has no user_name; userinfo is the only
            // reliable source for a display name, and failure there must not break login.
            try {
                const ures = await fetch(`${preset.openApiBase}/api/v1/userinfo`, {
                    headers: { Accept: 'application/json', Authorization: `Bearer ${cred.security_oauth_token}` },
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
                if (ures.ok) {
                    const u = await ures.json();
                    if (typeof u.name === 'string' && u.name.trim()) cred.nickname = u.name.trim();
                    if (!cred.uid) cred.uid = u.user_id || u.userId || undefined;
                }
            } catch { }
            return accounts.upsert(cred, preset.id);
        }
        throw Object.assign(new Error('login wait timed out, start it again'), { code: 'TIMEOUT' });
    })().then(account => {
        flow.state = 'authorized';
        flow.account = account;
        return account;
    }).catch(e => {
        // fetch aborts surface as "This operation was aborted"; report the
        // user-facing reason instead when we cancelled the flow ourselves.
        const cancelled = controller.signal.aborted;
        flow.state = cancelled ? 'failed' : (e.code === 'TIMEOUT' ? 'expired' : 'failed');
        flow.error = cancelled ? 'cancelled' : e.message;
        throw e;
    });
    // The flow may reject long before anyone awaits it (HTTP login path);
    // swallow here so Node does not report an unhandled rejection. Late
    // consumers get the reason back via state/error in waitForLogin below.
    done.catch(() => { });
    flow.done = done;

    if (open) openBrowser(loginUrl);
    return { loginUrl, reused: false, product: preset.id };
}

function cancelLogin(product) {
    const flows = product ? [activeLogins.get(products.resolveProduct(product)?.id)] : [...activeLogins.values()];
    for (const flow of flows) {
        if (flow && flow.state === 'pending') {
            flow.controller.abort();
            flow.state = 'failed';
            flow.error = 'cancelled';
        }
    }
}

// Await the in-flight (or just finished) device flow; resolves with the new
// pool entry. Used by the standalone `pnpm run login` CLI; the HTTP /v1 login
// entry keeps polling in the background and never needs this.
async function waitForLogin(product) {
    const id = product ? (products.resolveProduct(product) || {}).id : defaultProductId();
    const flow = activeLogins.get(id);
    if (!flow) throw new Error('no active login flow: call startLogin() first');
    if (flow.state === 'authorized') return flow.account;
    if (flow.state !== 'pending') {
        throw Object.assign(new Error(flow.error || `login ${flow.state}`), { code: flow.state.toUpperCase() });
    }
    return flow.done;
}

function pendingFlows() {
    const out = [];
    for (const flow of activeLogins.values()) {
        out.push({
            product: flow.product,
            state: flow.state,
            login_url: flow.state === 'pending' ? flow.loginUrl : undefined,
            error: flow.error,
        });
    }
    return out;
}

// GET /v1/auth/status — the whole pool, plus any pending device flow.
function authStatus() {
    const list = accounts.list();
    return {
        configured: list.length > 0,
        accounts: list.map(a => ({
            alias: a.alias,
            product: a.product,
            nickname: a.nickname || null,
            uid: a.uid || null,
            enabled: a.enabled,
            transient: a.transient === true,
            expires_at: a.expire_time || null,
            expired: accounts.isExpired(a),
            refreshable: accounts.isRefreshable(a),
            rate_limited_models: Object.keys(a.model_rate_limits || {})
                .filter(k => accounts.limitedUntil(a, k) > 0),
        })),
        login: pendingFlows(),
    };
}

module.exports = {
    AuthError,
    startLogin,
    cancelLogin,
    waitForLogin,
    openBrowser,
    authStatus,
    defaultProductId,
    parseTokenPayload,
};
