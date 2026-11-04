// /v1 — direct-HTTP API surface (primary transport), mounted also as /v2 for
// compatibility. Independent of the qodercli subprocess pool behind /v0, which
// is hidden by default now. Talks to Qoder with its own device-flow OAuth (the
// CLI's on-disk credentials are encrypted and unusable here, hence these
// auth/* entries), and serves a *pool* of logins across both product lines.
//
// Account selection is done through the model name — `Qwen3.8-Flash-qoder@a1`
// (first international login), `GLM-5.2-qodercn@c1` (first China login), and
// either segment may be dropped (`Qwen3.8-Flash` picks the first account that
// knows the model and is not queued). GET /v1/models lists exactly one row per
// account x model in that shape. The short catalog keys (`qfmodel`, `dmodel`)
// still work as identifiers; whatever the caller types, the upstream request
// carries the real key. Clients
// only ever see the standard OpenAI surface, no custom headers.
const express = require('express');
const auth = require('./qoder-auth');
const accounts = require('./accounts');
const products = require('./products');
const http = require('./http');

const router = express.Router();

function fail(res, err) {
    const status = err && err.status ? err.status : (err instanceof auth.AuthError ? err.status : 502);
    const message = err && err.message ? err.message : String(err);
    if (res.headersSent) return res.end();
    const type = status === 401 ? 'auth_required'
        : status === 404 ? 'invalid_request'
            : status === 400 ? 'invalid_request'
                : status === 403 ? 'permission_denied'
                    : status === 429 ? 'rate_limit_error'
                        : 'server_error';
    res.status(status).json({ error: { message, type } });
}

// --- auth entries -------------------------------------------------------------

// POST/GET /v1/auth/login — start a device flow for one product line. Returns
// the authorization URL immediately and polls for the token in the background;
// opens the system browser unless {"open": false}. Every login appends a new
// account to the pool (`--product qodercn` for the China version), so calling
// this repeatedly is how you add accounts. Re-call to resume, /v1/auth/status
// to watch.
function login(req, res) {
    try {
        const body = req.body || {};
        const product = body.product || req.query.product || process.env.QODER_PRODUCT || 'qoder';
        const open = !(body.open === false) && !(req.query.open === '0');
        const { loginUrl, reused, product: id } = auth.startLogin({ product, open });
        console.log(`[v1] ${id} login flow ${reused ? 'resumed' : 'started'}: ${loginUrl}`);
        res.json({ status: 'pending', reused, product: id, login_url: loginUrl });
    } catch (e) {
        fail(res, e);
    }
}
router.post('/auth/login', login);
router.get('/auth/login', login);

// GET /v1/auth/status — every account in the pool + pending login flows.
router.get('/auth/status', (_req, res) => {
    res.json(auth.authStatus());
});

// POST /v1/auth/logout — drop one account ({"alias": "c1"}) or all of them.
// Cancels any pending device flow first so a stale login cannot re-add it.
router.post('/auth/logout', (req, res) => {
    auth.cancelLogin();
    const alias = (req.body && req.body.alias) || req.query.alias;
    if (alias) {
        const removed = accounts.remove(alias);
        if (!removed) return res.status(404).json({ error: { message: `no account ${alias}`, type: 'invalid_request' } });
        return res.json({ status: 'ok', removed: alias });
    }
    const removed = accounts.list().filter(a => !a.transient).map(a => a.alias);
    accounts.removeAll();
    res.json({ status: 'ok', removed });
});

// --- account pool -------------------------------------------------------------

// GET /v1/accounts — the pool without any token material. `models` lists only
// the rows still ticked on for that account, so it matches what /v1/models
// offers and what inference will accept.
router.get('/accounts', (_req, res) => {
    res.json({
        object: 'list',
        data: accounts.list().map(a => ({
            ...accounts.publicView(a),
            product_name: products.PRODUCTS[a.product].displayName,
            models: accounts.servedModelKeys(a).map(k => `${k}@${a.alias}`),
        })),
    });
});

// GET /v1/accounts/:alias/models — the full roster for one account, including
// the unchecked rows /v1/models hides, so the console can tick them back on.
router.get('/accounts/:alias/models', (req, res) => {
    const view = accounts.accountModels(req.params.alias);
    if (!view) {
        return res.status(404).json({ error: { message: `no account ${req.params.alias}`, type: 'invalid_request' } });
    }
    res.json({ object: 'list', account: view.account, data: view.data });
});

// PUT /v1/accounts/:alias/models — replace the unchecked rows for one account.
// The body carries the deny list ({"models_disabled": ["auto", ...]}) rather
// than the picked set, so a missing or empty field means the safe default: this
// account offers its whole catalog. Unknown keys are rejected outright.
router.put('/accounts/:alias/models', (req, res) => {
    try {
        const keys = req.body && req.body.models_disabled;
        if (keys === undefined) {
            return res.status(400).json({ error: { message: 'models_disabled (array of catalog keys) is required', type: 'invalid_request' } });
        }
        res.json(accounts.publicView(accounts.setModelsDisabled(req.params.alias, keys)));
    } catch (e) {
        fail(res, e);
    }
});

// PATCH /v1/accounts/:alias — enable/disable an account, or rename its alias.
router.patch('/accounts/:alias', (req, res) => {
    try {
        const patch = {};
        if (req.body && req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
        if (req.body && typeof req.body.alias === 'string') patch.alias = req.body.alias;
        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: { message: 'nothing to change (accepted: enabled, alias)', type: 'invalid_request' } });
        }
        res.json(accounts.publicView(accounts.update(req.params.alias, patch)));
    } catch (e) {
        fail(res, e);
    }
});

// DELETE /v1/accounts/:alias — forget this login.
router.delete('/accounts/:alias', (req, res) => {
    if (!accounts.remove(req.params.alias)) {
        return res.status(404).json({ error: { message: `no account ${req.params.alias}`, type: 'invalid_request' } });
    }
    res.json({ status: 'ok', removed: req.params.alias });
});

// POST /v1/accounts/:alias/refresh — force a silent token renewal.
router.post('/accounts/:alias/refresh', async (req, res) => {
    try {
        const account = accounts.get(req.params.alias);
        if (!account) return res.status(404).json({ error: { message: `no account ${req.params.alias}`, type: 'invalid_request' } });
        const next = await accounts.refresh(account);
        res.json({ status: 'ok', alias: next.alias, expires_at: next.expire_time });
    } catch (e) {
        fail(res, e);
    }
});

// POST /v1/accounts/:alias/clear-limit — forget recorded queue windows.
router.post('/accounts/:alias/clear-limit', (req, res) => {
    if (!accounts.clearRateLimits(req.params.alias)) {
        return res.status(404).json({ error: { message: `no account ${req.params.alias}`, type: 'invalid_request' } });
    }
    res.json({ status: 'ok', alias: req.params.alias });
});

// --- model catalog -------------------------------------------------------------

// GET /v1/models — exactly one entry per (account × model), id shaped as
// `<ModelName>-<product>@<alias>`. Nothing else is listed: the caller picks a
// row and the proxy maps it to that login and its transport. Models the
// console has unticked for an account are not listed and will not be served.
router.get('/models', (_req, res) => {
    res.json({ object: 'list', data: accounts.modelNameCatalog() });
});

// --- inference -----------------------------------------------------------------

// POST /v1/chat/completions — OpenAI-compatible front end. The model string
// chooses the account and the upstream route (catalog models -> the WASM-signed
// encrypted endpoint, generic names -> the public one). Display names and short
// keys are both accepted; the key is what is sent upstream.
router.post('/chat/completions', async (req, res) => {
    const { model, messages } = req.body || {};
    if (!model || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: { message: 'model and messages are required', type: 'invalid_request' } });
    }
    try {
        await http.chatCompletion(req.body, res);
    } catch (e) {
        fail(res, e);
    }
});

module.exports = router;
