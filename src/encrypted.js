// Encrypted inference transport: OpenAI request body -> the client's signed
// `agent_chat_generation` ask, built and authorised by the bundled WASM.
//
// Why this path exists at all: the public OpenAI-compatible endpoint only
// accepts generic model names and answers catalog keys with "Unsupported
// model", and the China product has no public endpoint whatsoever (measured:
// 404). Catalog keys — `qfmodel`, `dmodel`, the 1M-context roster — are only
// reachable here.
//
// Two hard constraints coming from the request signing:
//   - the account must carry a `uid`; without it WASM still produces a request,
//     and the server answers `Signature invalid (101)`. Fetch userinfo to fill
//     it in rather than failing the user's prompt.
//   - headers returned by WASM must be forwarded verbatim. `Authorization` is a
//     signed `Bearer COSY.<payload>.<sig>`; overwriting it with the plain
//     device token yields 403 Signature invalid.
const products = require('./products');
const accounts = require('./accounts');
const wasm = require('./qoder-wasm');

const CLIENT_CACHE_LIMIT = 32;
const clientCache = new Map(); // `${accountId}:${token}` -> EncryptedInfer

// The WASM context is stateful and costs a few signed calls to build; one per
// account+token is enough (a refresh changes the key, so renewal rebuilds).
async function clientFor(account, token, product) {
    const key = `${account.id}:${token}`;
    const cached = clientCache.get(key);
    if (cached) return cached;
    const client = await wasm.EncryptedInfer.create({
        user: { uid: account.uid, securityOauthToken: token },
        machineId: account.machine_id,
        metadata: { ...product.clientMetadata },
        host: product.encryptedApiBase,
    });
    if (clientCache.size >= CLIENT_CACHE_LIMIT) {
        clientCache.delete(clientCache.keys().next().value);
    }
    clientCache.set(key, client);
    return client;
}

// --- OpenAI request -> ask --------------------------------------------------

function contentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(block => block && block.type === 'text')
        .map(block => String(block.text === undefined ? '' : block.text))
        .join('');
}

// Content blocks keep their array form when a message carries images: the
// endpoint needs `image_url` parts, and flattening them to text would hand the
// model "an image with no caption".
function contentForWire(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content === null || content === undefined ? '' : content;
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') parts.push({ type: 'text', text: String(block.text === undefined ? '' : block.text) });
        else if (block.type === 'image_url') {
            const url = block.image_url && (block.image_url.url || block.image_url);
            if (typeof url === 'string') parts.push({ type: 'image_url', image_url: { url } });
        }
    }
    return parts.length > 0 ? parts : contentToText(content);
}

// `system`/`developer` turns go to the envelope's top-level `system` array, the
// rest is history, and the last user turn is this round's question — the shape
// the client itself sends.
function splitMessages(messages) {
    const systemParts = [];
    const history = [];
    for (const m of messages) {
        if (!m || typeof m.role !== 'string') continue;
        if (m.role === 'system' || m.role === 'developer') {
            const text = contentToText(m.content);
            if (text.length > 0) systemParts.push(text);
            continue;
        }
        const entry = { role: m.role, content: contentForWire(m.content) };
        // Dropping these two fields breaks multi-step tool loops entirely: the
        // model never sees what it called or what came back, and starts
        // inventing calls in prose instead.
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) entry.tool_calls = m.tool_calls;
        if (typeof m.tool_call_id === 'string') entry.tool_call_id = m.tool_call_id;
        const empty = typeof entry.content === 'string'
            ? entry.content.length === 0
            : (!Array.isArray(entry.content) || entry.content.length === 0);
        if (empty && entry.tool_calls === undefined && entry.tool_call_id === undefined) continue;
        history.push(entry);
    }
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    const userText = lastUser === undefined ? '' : contentToText(lastUser.content);
    return { systemText: systemParts.join('\n\n'), history, userText };
}

// Accept both the OpenAI `{type:'function',function:{...}}` shape and the flat
// Anthropic-ish `{name,description,parameters}` one some clients send.
function normalizeTools(tools) {
    if (!Array.isArray(tools)) return [];
    const out = [];
    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        const fn = tool.function || tool;
        const name = typeof fn.name === 'string' ? fn.name : undefined;
        if (!name) continue;
        out.push({
            type: 'function',
            function: {
                name,
                ...(typeof fn.description === 'string' && fn.description.length > 0 ? { description: fn.description } : {}),
                ...(fn.parameters === undefined ? {} : { parameters: fn.parameters }),
            },
        });
    }
    return out;
}

function buildAsk(body, product, model) {
    const { systemText, history, userText } = splitMessages(body.messages || []);
    const effort = body.reasoning_effort !== undefined ? body.reasoning_effort
        : (body.reasoning && body.reasoning.effort);

    // `reasoning_effort: 'none'` only means something when the catalog offers a
    // disabled branch; otherwise thinking stays on its default tier.
    let reasoningEffort;
    if (effort !== undefined && effort !== null) {
        const value = String(effort);
        if (value === 'none' && model && model.canDisable) reasoningEffort = 'none';
        else if (value !== 'none' && (!model || !model.efforts || model.efforts.includes(value))) reasoningEffort = value;
        else if (value !== 'none') reasoningEffort = value; // let upstream decide for unknown tiers
    }

    const ask = {
        modelKey: model ? model.key : body.model,
        userText,
        systemText,
        history,
        tools: normalizeTools(body.tools),
        isReasoning: model ? model.reason === true : false,
        // `agent` picks the healthy routing pool. Without the field the server
        // takes a broken branch and every request fails with
        // `[FAIL]node:... Execution failed` — which looks exactly like "this
        // model is down" while the IDE runs it fine.
        business: { type: 'agent' },
        sessionType: product.sessionType,
        displayName: model ? model.name : body.model,
        isVl: model ? model.vision !== false : true,
        maxInputTokens: model ? model.context : undefined,
        contextWindow: body.max_context_length === undefined ? undefined : body.max_context_length,
    };
    if (body.max_tokens !== undefined) ask.maxTokens = body.max_tokens;
    if (body.max_completion_tokens !== undefined) ask.maxTokens = body.max_completion_tokens;
    if (reasoningEffort !== undefined) ask.reasoningEffort = reasoningEffort;
    return ask;
}

// --- sending ----------------------------------------------------------------

function describeError(text, status) {
    const trimmed = String(text || '').trim();
    const oneLine = trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
    return `qoder encrypted endpoint HTTP ${status}: ${oneLine || '(empty body)'}`;
}

async function postOnce(account, product, ask) {
    const token = await accounts.accessToken(account);
    const client = await clientFor(account, token, product);
    const request = client.prepareInfer(ask);
    const headers = { ...request.headers, Accept: 'text/event-stream' };
    return { response: await fetch(request.url, { method: 'POST', headers, body: request.body }), token };
}

// Opens the SSE response for a catalog-key model. Throws with `.status` set so
// the route can answer sensibly; records queue windows on the account so
// bare-name routing can skip it.
async function openChatCompletion(target, body) {
    const { account, product, model } = target;
    if (!account.uid || !account.machine_id) {
        // Older credential files predate `uid`; fill it in once, from userinfo.
        await accounts.ensureUid(account);
    }
    if (!account.uid) {
        throw Object.assign(new Error(
            `account ${account.alias} has no uid, the encrypted endpoint cannot sign a request for it — re-login with \`pnpm run login --product ${account.product}\``),
            { status: 401 });
    }

    const ask = buildAsk(body, product, model);
    let { response, token } = await postOnce(account, product, ask);

    if ((response.status === 401 || response.status === 403) ) {
        try { await response.body?.cancel(); } catch { }
        try { token = await accounts.accessToken(account, { forceRefresh: true }); } catch (e) {
            throw Object.assign(new Error(`${e.message} (account ${account.alias})`), { status: 401 });
        }
        ({ response } = await postOnce(account, product, ask));
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 403 || response.status === 429) {
            accounts.markRateLimited(account.id, ask.modelKey, Date.now() + 30_000);
        }
        throw Object.assign(new Error(describeError(text, response.status)), { status: response.status });
    }
    return response;
}

module.exports = {
    buildAsk,
    splitMessages,
    normalizeTools,
    contentToText,
    openChatCompletion,
    ENCRYPTED_CHAT_PATH: products.ENCRYPTED_CHAT_PATH,
};
