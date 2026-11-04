// Multi-account pool, product-aware.
//
// Routing model chosen for this proxy: the *model name selects the account*.
// Every account gets its own namespace of model ids carrying a short alias
// suffix (`qfmodel@a1` for international account #1, `qfmodel@c1` for a
// China-version account), so one running proxy can serve several logins and
// both product lines at once, and a client switches account by changing the
// model string — no custom headers, works in any OpenAI-compatible client.
//
// A bare catalog key (`qfmodel`) still resolves, to the first enabled account
// of the default product whose that model is not inside a recorded rate-limit
// window — same "manual order + rate-limit exemption" rule dsh uses.
//
// Storage: ~/.qoder-proxy/accounts.json, 0600 off Windows. The single-account
// credentials.json written by earlier versions migrates on first load.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const products = require('./products');
const config = require('./config');

const REQUEST_TIMEOUT_MS = 30_000;
const ALIAS_SEP = '@';

// --- low level io -----------------------------------------------------------

function readRaw() {
    try {
        const doc = JSON.parse(fs.readFileSync(products.accountsFile, 'utf8'));
        return Array.isArray(doc.accounts) ? doc.accounts : [];
    } catch {
        return [];
    }
}

function writeRaw(accounts, opts = {}) {
    const file = products.accountsFile;
    // A dropped login is unrecoverable (the token only ever lives here), and an
    // empty list is what a failed concurrent read looks like to the caller. So
    // only a deliberate wipe -- logout, `pnpm run clear`, or removing the last
    // account -- is allowed to overwrite a non-empty pool with an empty one.
    if (accounts.length === 0 && !opts.allowEmpty && readRaw().length > 0) {
        console.warn(`[accounts] refused to overwrite the pool with an empty list (pass allowEmpty for a deliberate wipe)`);
        return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ accounts, updated_at: new Date().toISOString() }, null, 2));
    if (process.platform !== 'win32') {
        try { fs.chmodSync(file, 0o600); } catch { }
    }
    try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, JSON.stringify({ accounts }, null, 2)); }
}

// One-shot migration of the pre-multi-account single credential file.
//
// Runs only when the pool file does not exist yet — an existing pool, even an
// empty one left behind by logging out, must not resurrect the old credential.
// The `.migrated` name is also accepted because earlier builds renamed the file
// without persisting the pool, which would otherwise drop a real login.
function migrateLegacy(accounts) {
    const legacyFile = process.env.QODER_PROXY_CRED_FILE
        || path.join(os.homedir(), '.qoder-proxy', 'credentials.json');
    const source = [legacyFile, `${legacyFile}.migrated`].find(f => fs.existsSync(f));
    if (!source) return accounts;
    let legacy = null;
    try {
        legacy = JSON.parse(fs.readFileSync(source, 'utf8'));
    } catch {
        return accounts;
    }
    if (!legacy || !legacy.access_token) return accounts;
    const product = products.resolveProduct(process.env.QODER_PRODUCT) || products.PRODUCTS.qoder;
    const entry = normalize({
        ...legacy,
        // Same id shape `upsert` writes, so a migrated login and a freshly
        // logged-in one are addressed identically by the pool helpers. A missing
        // uid stays missing: inventing one would sign encrypted requests with a
        // bogus identity (and `ensureUid` would then never fix it).
        id: `${product.tag}:${legacy.uid || crypto.randomUUID()}`,
        alias: allocateAlias(product, accounts),
        uid: legacy.uid || null,
        product: product.id,
        nickname: legacy.nickname || legacy.user_name,
    }, accounts.length + 1);
    accounts = accounts.filter(a => a.id !== entry.id);
    accounts.push(entry);
    try {
        fs.renameSync(legacyFile, `${legacyFile}.migrated`);
    } catch { }
    writeRaw(accounts);
    console.log(`[accounts] migrated legacy single credential (${entry.alias}) to accounts.json`);
    return accounts;
}

// --- entries --------------------------------------------------------------

function normalize(entry, seq) {
    const product = products.resolveProduct(entry.product) || products.PRODUCTS.qoder;
    const alias = entry.alias || nextAlias(product, seq);
    return {
        id: entry.id || `${product.tag}:${entry.uid || crypto.randomUUID()}`,
        alias,
        product: product.id,
        nickname: entry.nickname || null,
        uid: entry.uid || null,
        machine_id: entry.machine_id || null,
        security_oauth_token: entry.security_oauth_token || entry.access_token || null,
        access_token: entry.access_token || entry.security_oauth_token || null,
        refresh_token: entry.refresh_token || null,
        expire_time: entry.expire_time || null,
        refresh_token_expire_time: entry.refresh_token_expire_time || null,
        enabled: entry.enabled !== false,
        // Injected from QODER_ACCESS_TOKEN: never written to disk, cannot be
        // refreshed, and carries no machine binding.
        transient: entry.transient === true,
        // modelKey -> ms epoch until which the account is known to be queued.
        model_rate_limits: entry.model_rate_limits || {},
        // Catalog keys the operator ticked off in the console. Kept as a deny
        // list rather than an allow list so a model added to the catalog later
        // is offered (checked) without any migration, and so an unreadable
        // value degrades to “everything enabled” instead of hiding the roster.
        models_disabled: Array.isArray(entry.models_disabled)
            ? [...new Set(entry.models_disabled.filter(k => typeof k === 'string' && k.length > 0))]
            : [],
        added_at: entry.added_at || new Date().toISOString(),
    };
}

function nextAlias(product, seq) {
    return `${product.tag}${seq}`;
}

// Aliases are numbered per product line (`a1, a2…` international, `c1, c2…`
// China), so adding a CN login must not push the next international one from
// a2 to a3 just because it sits third in the file.
function allocateAlias(product, all) {
    const used = new Set(all.filter(a => a.product === product.id).map(a => a.alias));
    let n = 1;
    while (used.has(nextAlias(product, n))) n++;
    return nextAlias(product, n);
}

// A hand-supplied token (QODER_ACCESS_TOKEN) joins the pool as a read-only
// entry, so the env-var workflow keeps working now that routing is per-account.
function envAccount() {
    const token = process.env.QODER_ACCESS_TOKEN;
    if (!token) return null;
    const product = products.resolveProduct(process.env.QODER_PRODUCT) || products.PRODUCTS.qoder;
    return normalize({
        id: `env:${product.id}`,
        alias: 'env',
        product: product.id,
        access_token: token,
        security_oauth_token: token,
        uid: process.env.QODER_UID || null,
        machine_id: null,
        transient: true,
    }, 1);
}

function loadAll() {
    let accounts = fs.existsSync(products.accountsFile) ? readRaw() : migrateLegacy([]);
    accounts = accounts.map((a, i) => normalize(a, i + 1));
    const env = envAccount();
    return env ? [env, ...accounts.filter(a => a.id !== env.id)] : accounts;
}

function saveAll(accounts, opts = {}) {
    writeRaw(accounts.filter(a => !a.transient).map((a, i) => normalize(a, i + 1)), opts);
}

// What may leave the process over HTTP: tokens and machine ids are the pool's
// secrets, and aliases are stable identifiers clients address accounts by.
function publicView(account) {
    return {
        id: account.id,
        alias: account.alias,
        product: account.product,
        nickname: account.nickname || null,
        uid: account.uid || null,
        enabled: account.enabled,
        readonly: account.transient === true,
        added_at: account.added_at || null,
        expires_at: account.expire_time || null,
        expired: isExpired(account),
        refreshable: isRefreshable(account),
        models_off: (account.models_disabled || []).slice(),
        models_queued: Object.keys(account.model_rate_limits || {})
            .filter(k => limitedUntil(account, k) > 0),
    };
}

function list() {
    return loadAll();
}

function get(idOrAlias) {
    const all = loadAll();
    return all.find(a => a.id === idOrAlias || a.alias === idOrAlias) || null;
}

function enabled() {
    return loadAll().filter(a => a.enabled);
}

// Upsert after a successful device-flow login. Same uid on the same product
// replaces its tokens rather than piling up duplicates.
function upsert(cred, productId) {
    const product = products.resolveProduct(productId) || products.PRODUCTS.qoder;
    const all = loadAll();
    const id = `${product.tag}:${cred.uid || crypto.randomUUID()}`;
    const existing = all.find(a => a.id === id);
    const seq = existing ? all.indexOf(existing) + 1 : all.length + 1;
    const entry = normalize({
        ...(existing || {}),
        ...cred,
        id,
        alias: (existing && existing.alias) || allocateAlias(product, all),
        product: product.id,
    }, seq);
    if (existing) all[all.indexOf(existing)] = entry;
    else all.push(entry);
    saveAll(all);
    return entry;
}

function update(id, patch) {
    const all = loadAll();
    const idx = all.findIndex(a => a.id === id || a.alias === id);
    if (idx === -1) throw new Error(`account ${id} not found`);
    if (all[idx].transient) {
        throw Object.assign(new Error(`account ${id} comes from QODER_ACCESS_TOKEN and cannot be modified`), { status: 400 });
    }
    if (patch.alias !== undefined) {
        const next = String(patch.alias).trim();
        if (!/^[a-zA-Z0-9_-]{1,16}$/.test(next)) {
            throw Object.assign(new Error('alias must be 1-16 chars of [A-Za-z0-9_-]'), { status: 400 });
        }
        if (all.some((a, i) => i !== idx && a.alias === next)) {
            throw Object.assign(new Error(`alias ${next} is already taken`), { status: 409 });
        }
    }
    all[idx] = normalize({ ...all[idx], ...patch }, idx + 1);
    saveAll(all);
    return all[idx];
}

function remove(id) {
    const all = loadAll();
    const idx = all.findIndex(a => a.id === id || a.alias === id);
    if (idx === -1) return false;
    all.splice(idx, 1);
    // Deleting the last login legitimately empties the pool.
    saveAll(all, { allowEmpty: true });
    return true;
}

function removeAll() {
    writeRaw([], { allowEmpty: true });
    return true;
}

// --- token helpers --------------------------------------------------------

function bearer(account) {
    return account.security_oauth_token || account.access_token || '';
}

function isExpired(account, now = Date.now()) {
    return typeof account.expire_time === 'number' && account.expire_time > 0 && account.expire_time <= now;
}

function isRefreshable(account) {
    return typeof account.refresh_token === 'string' && account.refresh_token.length > 0;
}

function productOf(account) {
    return products.resolveProduct(account.product) || products.PRODUCTS.qoder;
}

const refreshing = new Map(); // accountId -> in-flight promise

// Silent refresh, de-duped per account (concurrent requests must not both
// burn the refresh token).
async function refresh(account) {
    const key = `${account.product}:${account.uid || account.alias}`;
    if (refreshing.has(key)) return refreshing.get(key);
    const product = productOf(account);
    const task = (async () => {
        const res = await fetch(`${product.openApiBase}/api/v1/deviceToken/refresh`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': 'qoder/1.0.0',
            },
            body: JSON.stringify({
                refresh_token: account.refresh_token || '',
                machine_id: account.machine_id || '',
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }).catch(e => { throw new Error(`Qoder refresh network error (${account.alias}): ${e.message}`); });

        if (res.status === 401 || res.status === 403) {
            throw Object.assign(
                new Error(`Qoder refresh rejected (HTTP ${res.status}) for ${account.alias}, re-login required`),
                { status: 401 },
            );
        }
        let body;
        try { body = await res.json(); } catch {
            throw Object.assign(new Error(`Qoder refresh returned non-JSON (HTTP ${res.status})`), { status: 502 });
        }
        if (!res.ok) throw Object.assign(new Error(`Qoder refresh failed (HTTP ${res.status})`), { status: 502 });

        const token = body.token || body.device_token || body.access_token;
        if (!token) throw Object.assign(new Error(`Qoder refresh response missing token (${account.alias})`), { status: 502 });

        const all = loadAll();
        const idx = all.findIndex(a => a.id === account.id);
        if (idx === -1) throw new Error(`account ${account.alias} disappeared during refresh`);
        const next = normalize({
            ...all[idx],
            security_oauth_token: token,
            access_token: token,
            // Refresh responses omit these; losing machine_id breaks the next
            // refresh and losing uid breaks the encrypted inference path.
            refresh_token: body.refresh_token || all[idx].refresh_token,
            uid: body.user_id || body.userId || all[idx].uid,
            nickname: body.user_name || body.userName || all[idx].nickname,
            expire_time: coerceTime(body.expires_at, all[idx].expire_time),
            refresh_token_expire_time: coerceTime(body.refresh_token_expires_at, all[idx].refresh_token_expire_time),
        }, idx + 1);
        all[idx] = next;
        saveAll(all);
        return next;
    })().finally(() => refreshing.delete(key));
    refreshing.set(key, task);
    return task;
}

function coerceTime(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value === 'string' && value.length > 0) {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

// Credential files written before `uid` was stored leave the encrypted path
// unable to sign (the server answers `Signature invalid (101)`), so fetch it
// from userinfo once and persist it. Failure is not fatal here — the caller
// decides what to do with an account that still has no uid.
async function ensureUid(account) {
    if (account.uid) return account;
    const product = productOf(account);
    try {
        const res = await fetch(`${product.openApiBase}/api/v1/userinfo`, {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${bearer(account)}`,
                'User-Agent': 'qoder/1.0.0',
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) return account;
        const u = await res.json();
        const uid = u.user_id || u.userId || u.id;
        if (typeof uid !== 'string' || uid.length === 0) return account;
        const patch = { uid };
        if (typeof u.name === 'string' && u.name.trim() && !account.nickname) patch.nickname = u.name.trim();
        return update(account.id, patch);
    } catch {
        return account;
    }
}

// A live bearer token for one account, refreshing when needed.
async function accessToken(account, { forceRefresh = false } = {}) {
    if (forceRefresh || isExpired(account)) {
        if (!isRefreshable(account)) {
            throw Object.assign(
                new Error(`account ${account.alias} token expired and not refreshable, re-login required`),
                { status: 401 },
            );
        }
        const next = await refresh(account);
        return bearer(next);
    }
    return bearer(account);
}

// --- rate-limit bookkeeping ----------------------------------------------

// Only ever extends a window: a short fallback value must not overwrite a
// real server-provided reset time.
function markRateLimited(accountId, modelKey, resetAtMs) {
    if (!Number.isFinite(resetAtMs)) return;
    const all = loadAll();
    const idx = all.findIndex(a => a.id === accountId || a.alias === accountId);
    if (idx === -1) return;
    const limits = { ...all[idx].model_rate_limits };
    if (Number.isFinite(limits[modelKey]) && limits[modelKey] >= resetAtMs) return;
    limits[modelKey] = resetAtMs;
    all[idx] = normalize({ ...all[idx], model_rate_limits: limits }, idx + 1);
    saveAll(all);
}

function clearRateLimits(accountId) {
    const all = loadAll();
    const idx = all.findIndex(a => a.id === accountId || a.alias === accountId);
    if (idx === -1) return false;
    all[idx] = normalize({ ...all[idx], model_rate_limits: {} }, idx + 1);
    saveAll(all);
    return true;
}

function limitedUntil(account, modelKey, now = Date.now()) {
    const value = account.model_rate_limits && account.model_rate_limits[modelKey];
    return typeof value === 'number' && value > now ? value : 0;
}

// --- per-account model selection ------------------------------------------

// A model the operator unticked is not offered by this account at all: hidden
// from /v1/models and refused at routing time, so the checkbox is the actual
// support boundary rather than a UI preference.
function modelDisabled(account, key) {
    return Array.isArray(account.models_disabled) && account.models_disabled.includes(key);
}

// Every key this account would serve right now — its product catalog minus the
// unchecked rows.
function servedModelKeys(account) {
    return allModelKeys(account).filter(k => !modelDisabled(account, k));
}

function allModelKeys(account) {
    return [
        ...products.catalogFor(account.product).map(m => m.key),
        ...genericModelsFor(account.product),
    ];
}

// Store the unchecked rows for one account. Keys are validated against the
// account's own product line, so a stale entry from a renamed catalog model
// cannot linger as a hidden deny.
function setModelsDisabled(idOrAlias, keys) {
    const all = loadAll();
    const idx = all.findIndex(a => a.id === idOrAlias || a.alias === idOrAlias);
    if (idx === -1) {
        throw Object.assign(new Error(`account ${idOrAlias} not found`), { status: 404 });
    }
    if (all[idx].transient) {
        throw Object.assign(
            new Error(`account ${idOrAlias} comes from QODER_ACCESS_TOKEN and cannot be modified`),
            { status: 400 },
        );
    }
    if (!Array.isArray(keys)) {
        throw Object.assign(new Error('models_disabled must be an array of catalog keys'), { status: 400 });
    }
    const wanted = [...new Set(keys.map(k => String(k).trim()).filter(Boolean))];
    const known = new Set(allModelKeys(all[idx]));
    const unknown = wanted.filter(k => !known.has(k));
    if (unknown.length > 0) {
        throw Object.assign(
            new Error(`model keys unknown to product ${all[idx].product}: ${unknown.join(', ')}`),
            { status: 400 },
        );
    }
    all[idx] = normalize({ ...all[idx], models_disabled: wanted }, idx + 1);
    saveAll(all);
    return all[idx];
}

// --- model-name routing ---------------------------------------------------

// The full form is `<ModelName>-<product>@<alias>`: the real model name, the
// product line it belongs to, and the login that serves it. The product
// segment and the `@alias` are both optional — `Qwen3.8-Flash-qodercn`,
// `Qwen3.8-Flash@a1` and the short key `qfmodel` all parse. Without a suffix
// the caller did not choose an account, so we pick the first enabled one that
// knows the model and is not inside a rate-limit window for it.
function parseModelName(model) {
    const raw = String(model || '');
    const at = raw.lastIndexOf(ALIAS_SEP);
    let name = at === -1 ? raw : raw.slice(0, at);
    const alias = at === -1 || !raw.slice(at + 1).trim() ? null : raw.slice(at + 1).trim();
    // Model names contain dashes themselves (`GLM-5.3-Flash`), so a trailing
    // segment only counts as a product line when it really resolves to one.
    let product = null;
    const dash = name.lastIndexOf('-');
    if (dash > 0) {
        const known = products.resolveProduct(name.slice(dash + 1));
        if (known) {
            product = known.id;
            name = name.slice(0, dash);
        }
    }
    return { name, product, alias, pinned: !!alias };
}

// A generic public-endpoint name (qwen-flash...) rather than a catalog key.
function isGenericModel(name) {
    return config.v2Models.includes(name);
}

// Public-route names, and only for the product that actually has a public
// endpoint (the China version answers 404 there — measured).
function genericModelsFor(productId) {
    return productId === 'qoder' ? config.v2Models : [];
}

function modelNameCatalog() {
    const out = [];
    for (const account of loadAll()) {
        for (const m of products.catalogFor(account.product)) {
            if (modelDisabled(account, m.key)) continue;
            out.push({
                // `<Name>-<product>@<alias>`: one entry per model per login, no
                // separate bare list. `model_key` keeps Qoder's short key, which
                // is still accepted as input and is what actually goes upstream.
                id: `${m.name}-${account.product}${ALIAS_SEP}${account.alias}`,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: `qoder:${account.alias}`,
                // Non-standard extras: handy for a picking UI, ignored by SDKs.
                account_alias: account.alias,
                account_nickname: account.nickname || null,
                product: account.product,
                model_key: m.key,
                model_name: m.name,
                display_name: m.name,
                context_window: m.context,
                free: m.free === true,
                price_factor: m.price === undefined ? null : m.price,
                efforts: m.efforts || null,
            });
        }
        for (const g of genericModelsFor(account.product)) {
            if (modelDisabled(account, g)) continue;
            out.push({
                id: `${g}-${account.product}${ALIAS_SEP}${account.alias}`,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: `qoder:${account.alias}`,
                account_alias: account.alias,
                account_nickname: account.nickname || null,
                product: account.product,
                model_key: g,
                model_name: `${g} (public endpoint)`,
                display_name: g,
                transport: 'public',
            });
        }
    }
    return out;
}

// What one typed name means for one account: which catalog entry (or public
// generic name) it resolves to, and whether that row is currently unchecked.
// Returns null when this product line does not offer the name at all.
function locateModel(account, name) {
    const catalogModel = products.resolveModel(account.product, name);
    if (catalogModel) {
        return {
            model: catalogModel,
            key: catalogModel.key,
            transport: 'encrypted',
            off: modelDisabled(account, catalogModel.key),
        };
    }
    if (genericModelsFor(account.product).includes(name)) {
        return { model: null, key: name, transport: 'public', off: modelDisabled(account, name) };
    }
    return null;
}

// The picker view: every model the account's product line offers, checked or
// not. /v1/models hides the unchecked rows; the console needs to see them to
// tick one back on.
function accountModels(idOrAlias) {
    const account = get(idOrAlias);
    if (!account) return null;
    const rows = products.catalogFor(account.product).map(m => ({
        key: m.key,
        name: m.name,
        id: `${m.name}-${account.product}${ALIAS_SEP}${account.alias}`,
        context_window: m.context,
        free: m.free === true,
        price_factor: m.price === undefined ? null : m.price,
        vision: m.vision === true,
        reasoning: m.reason === true,
        transport: 'encrypted',
        enabled: !modelDisabled(account, m.key),
    }));
    for (const g of genericModelsFor(account.product)) {
        rows.push({
            key: g,
            name: `${g} (public endpoint)`,
            id: `${g}-${account.product}${ALIAS_SEP}${account.alias}`,
            context_window: null,
            free: false,
            price_factor: null,
            vision: false,
            reasoning: false,
            transport: 'public',
            enabled: !modelDisabled(account, g),
        });
    }
    return { account: publicView(account), data: rows };
}

// Rate-limit windows are stored under the catalog key, so calling a model by
// its short key or by its display name shares one cooldown instead of two.
function canonicalModelKey(name) {
    const prefer = process.env.QODER_PRODUCT || 'qoder';
    for (const id of [prefer, ...products.productIds().filter(x => x !== prefer)]) {
        const found = products.resolveModel(id, name);
        if (found) return found.key;
    }
    return String(name === undefined || name === null ? '' : name);
}

// Everything the caller needs for one upstream request, per candidate account.
// With a `@alias` suffix the caller chose the account, so there is exactly one
// candidate and every failure is reported back instead of failing over. A `-qoder`
// / `-qodercn` segment narrows the request to that product line. Without either
// the name expands to every enabled account that knows the model, ordered so
// that accounts not sitting inside a recorded rate-limit window come first
// (user list order still decides among equals — same rule dsh's pool uses).
function candidateTargets(model, limit = 4) {
    const { name, product, alias, pinned } = parseModelName(model);
    const modelKey = canonicalModelKey(name);
    const all = loadAll();
    if (all.length === 0) {
        throw Object.assign(new Error('no account logged in yet: run `pnpm run login`'), { status: 401 });
    }
    if (product && !products.PRODUCTS[product]) {
        throw Object.assign(new Error(`unknown product line "${product}" (expected qoder or qodercn)`), { status: 404 });
    }

    let pool = [];
    if (pinned) {
        // The alias is the stable handle; a nickname is accepted too so the UI
        // can show either, but renaming an account must not break a client.
        const wanted = alias.toLowerCase();
        const account = all.find(a => a.alias === alias)
            || all.find(a => String(a.nickname || '').trim().toLowerCase() === wanted);
        if (!account) {
            throw Object.assign(
                new Error(`unknown account alias "${alias}" (known: ${all.map(a => a.alias).join(', ')})`),
                { status: 404 },
            );
        }
        if (!account.enabled) {
            throw Object.assign(new Error(`account ${alias} is disabled`), { status: 403 });
        }
        if (product && account.product !== product) {
            throw Object.assign(
                new Error(`account ${account.alias} belongs to ${account.product}, not ${product}`),
                { status: 404 },
            );
        }
        pool = [account];
    } else {
        const prefer = product || process.env.QODER_PRODUCT || 'qoder';
        const known = a => {
            const located = locateModel(a, name);
            return !!located && !located.off;
        };
        const ordered = all.filter(a => a.enabled)
            .filter(a => !product || a.product === product)
            .sort((a, b) => (a.product === prefer ? 0 : 1) - (b.product === prefer ? 0 : 1));
        pool = ordered.filter(known);
        if (pool.length === 0) {
            if (ordered.length === 0) {
                throw Object.assign(new Error('no enabled account: re-enable one via POST /v1/accounts'), { status: 401 });
            }
            // Distinguish “nobody knows this model” from “everybody has it
            // unticked” — the second one is a console setting, not a typo.
            const off = ordered.filter(a => {
                const located = locateModel(a, name);
                return !!located && located.off;
            });
            if (off.length > 0) {
                throw Object.assign(
                    new Error(`model "${name}" is unchecked for ${off.map(a => a.alias).join(', ')} — tick it back on the 账号和模型 page`),
                    { status: 404 },
                );
            }
            throw Object.assign(
                new Error(`model "${name}" is not in any logged-in account's catalog — pick an id from GET /v1/models (add @alias to pin one account, e.g. "Qwen3.8-Flash@c1")`),
                { status: 404 },
            );
        }
        pool = pool.filter(a => !limitedUntil(a, modelKey)).concat(pool.filter(a => limitedUntil(a, modelKey)));
    }

    const targets = [];
    for (const account of pool.slice(0, limit)) {
        // Either spelling works on the caller side; `catalogModel.key` is what
        // the encrypted endpoint actually expects, so it travels separately.
        const located = locateModel(account, name);
        if (!located) {
            throw Object.assign(
                new Error(`model "${name}" cannot be served by product ${account.product} (catalog names and keys need the encrypted route, generic names the public one)`),
                { status: 404 },
            );
        }
        if (located.off) {
            // A pinned `@alias` never fails over to another account, so the
            // unchecked row answers as the operator left it: refused, named.
            throw Object.assign(
                new Error(`model "${name}" is unchecked for account ${account.alias} — tick it on the 账号和模型 page, or pick another account`),
                { status: 404 },
            );
        }
        // Catalog models only exist on the encrypted endpoint — the public one
        // answers "Unsupported model" for them, so never route one there.
        targets.push({
            account,
            product: productOf(account),
            model: located.model,
            name,
            modelKey: located.key,
            transport: located.transport,
            pinned,
        });
    }
    return targets;
}

// Resolves what a request actually needs: which account, which transport.
// Throws with `.status` set so the route layer can answer 404/400 sensibly.
function resolveTarget(model) {
    return candidateTargets(model)[0];
}

module.exports = {
    ALIAS_SEP,
    list,
    get,
    enabled,
    upsert,
    update,
    remove,
    removeAll,
    saveAll,
    bearer,
    publicView,
    accessToken,
    refresh,
    ensureUid,
    isExpired,
    isRefreshable,
    productOf,
    markRateLimited,
    clearRateLimits,
    limitedUntil,
    modelDisabled,
    servedModelKeys,
    setModelsDisabled,
    accountModels,
    locateModel,
    parseModelName,
    canonicalModelKey,
    isGenericModel,
    modelNameCatalog,
    candidateTargets,
    resolveTarget,
};
