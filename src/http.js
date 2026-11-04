// Inference transport dispatch for /v1.
//
// Two upstream routes exist and they do not accept the same model names:
//
//   public     {apiBase}/model/v1/chat/completions      Bearer device token,
//            plain OpenAI. Only generic names (`qwen-flash`...); catalog keys
//            come back "Unsupported model". The China product has none at all
//            (measured 404), so this route is international-only.
//   encrypted  {encryptedApiBase}/algo/.../agent_chat_generation?Encode=1
//            WASM-signed request + SSE frames wrapped in an envelope. This is
//            the only route that accepts catalog keys, and the only route the
//            China product offers.
//
// `accounts.resolveTarget()` decides which one a request body means from the
// model string alone (`qfmodel@a1`, `dmodel@c1`, bare `qfmodel`), which is what
// lets one proxy serve several logins and both product lines without teaching
// clients any custom headers.
//
// For unpinned (bare) model names, a 403/429 or a queue frame recorded against
// the account that just served it moves the request to the next account that
// knows the model — the pool behaviour the CLI transport never had. Pinned
// names never fail over: the caller asked for that account by name, so its
// error is returned as-is.
const crypto = require('crypto');
const config = require('./config');
const accounts = require('./accounts');
const products = require('./products');
const encrypted = require('./encrypted');
const envelope = require('./envelope');

// Upstream may answer an SSE body under an `application/json` Content-Type
// header when loaded; for stream requests we always advertise
// text/event-stream ourselves.
function publicHeaders(token, stream) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: stream ? 'text/event-stream' : 'application/json',
        'Content-Type': 'application/json',
        'X-Request-ID': crypto.randomUUID(),
        'X-Session-ID': crypto.randomUUID(),
        'User-Agent': config.userAgent,
    };
}

async function openPublic(target, body, stream) {
    const { account, product } = target;
    if (product.id !== 'qoder') {
        throw Object.assign(
            new Error(`product ${product.id} exposes no public OpenAI endpoint — use a catalog model name from GET ${`/v1/models`} (e.g. qfmodel@${account.alias})`),
            { status: 404 },
        );
    }
    const url = `${product.apiBase}${products.CHAT_PATH}`;
    const send = async token => fetch(url, {
        method: 'POST',
        headers: publicHeaders(token, stream),
        body: JSON.stringify({ ...body, model: target.name }),
    });
    let response = await send(await accounts.accessToken(account));
    if (response.status === 401) {
        try { await response.body?.cancel(); } catch { }
        response = await send(await accounts.accessToken(account, { forceRefresh: true }));
    }
    return response;
}

function openUpstream(target, body, stream) {
    return target.transport === 'encrypted'
        ? encrypted.openChatCompletion(target, body)
        : openPublic(target, body, stream);
}

// --- stream writing ----------------------------------------------------------

function writeSseHead(res) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
}

// Queue/quota frames carry the only signal that lets the pool skip an account
// for a while; `retryAfterSeconds` is not in the frame, so a fixed window is
// used (long enough to be worth skipping, short enough to come back).
function noteWait(target, info) {
    accounts.markRateLimited(target.account.id, target.modelKey, Date.now() + Math.min(info.retryAfterMs, 120_000));
}

// Encrypted responses need the envelope stripped before anything is
// client-parseable, so the SSE head is written on the first real frame: a
// failure that arrives before any content can still be answered as JSON, or
// retried against another account.
async function pipeEncryptedStream(response, target, res) {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    let headSent = false;
    let emitted = false;
    let waitInfo = null;
    let sawDone = false;

    const head = () => { if (!headSent) { headSent = true; writeSseHead(res); } };

    try {
        for await (const frame of envelope.unwrapStream(response.body)) {
            if (abort.signal.aborted) break;
            if (frame.kind === 'error') {
                waitInfo = envelope.waitInfoOf(frame.error) || waitInfo;
                if (!emitted) continue; // answered below (retry or JSON error)
                head();
                res.write(`data: ${JSON.stringify(frame.error)}\n\n`);
                continue;
            }
            if (frame.kind === 'done') { sawDone = true; if (emitted) { head(); res.write('data: [DONE]\n\n'); } continue; }
            head();
            res.write(`data: ${frame.data}\n\n`);
            emitted = true;
        }
        // Upstream can end without its own terminator; clients otherwise sit on
        // an SSE stream that never closes.
        if (emitted && !sawDone && !abort.signal.aborted) res.write('data: [DONE]\n\n');
    } catch (e) {
        if (!abort.signal.aborted && emitted) {
            res.write(`data: ${JSON.stringify({ message: `upstream stream interrupted: ${e.message}`, type: 'model_error' })}\n\n`);
            res.write('data: [DONE]\n\n');
        } else if (!emitted) {
            throw e;
        }
    } finally {
        // The SSE head is only ever written once content starts flowing, so the
        // response is closable only in that case; the no-content path below
        // still owes the caller a JSON answer instead.
        if (headSent && !res.writableEnded) res.end();
    }

    if (!emitted && !abort.signal.aborted) {
        // Nothing came out but frames were consumed — report why.
        if (waitInfo) noteWait(target, waitInfo);
        const body = waitInfo
            ? { ...waitInfoBody(waitInfo), code: waitInfo.code }
            : { message: 'upstream returned no usable content', type: 'model_error' };
        return { failed: true, status: waitInfo ? (waitInfo.code === '10605' ? 429 : 503) : 502, body };
    }
    return { failed: false, emitted, waitInfo };
}

function waitInfoBody(info) {
    return {
        message: `qoder is queueing this model, retry in ~${Math.round(info.retryAfterMs / 1000)}s`,
        type: 'rate_limit_error',
        retry_after_seconds: Math.round(info.retryAfterMs / 1000),
    };
}

// Public responses are already standard OpenAI SSE: forward bytes untouched so
// structured error frames (queue 10605, billing) keep reaching the caller's own
// retry policy intact. Sniffing the same codes for the pool is done on a
// bounded tail copy, never by rewriting what goes out.
async function pipePublicStream(response, target, res) {
    res.status(response.status);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    const decoder = new TextDecoder();
    let tail = '';
    try {
        for await (const chunk of response.body) {
            if (abort.signal.aborted) break;
            res.write(chunk);
            const text = decoder.decode(chunk, { stream: true });
            tail = (tail + text).slice(-4096);
            const hit = /"code"\s*:\s*"?(10605|110|429)"?/.exec(tail);
            if (hit) { noteWait(target, { code: hit[1], retryAfterMs: 30_000 }); tail = ''; }
        }
    } catch (e) {
        if (!abort.signal.aborted) {
            res.write(`data: ${JSON.stringify({ error: { message: `upstream stream interrupted: ${e.message}`, type: 'server_error' } })}\n\n`);
            res.write('data: [DONE]\n\n');
        }
    } finally {
        res.end();
    }
    return { failed: false, emitted: true, waitInfo: null };
}

// --- candidate selection -----------------------------------------------------

function candidates(model) {
    return accounts.candidateTargets(model);
}

// --- entry point -------------------------------------------------------------

async function chatCompletion(body, res) {
    const stream = body.stream === true;
    const targets = candidates(body.model);
    let lastError = null;

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const canFailOver = targets.length > 1 && i + 1 < targets.length;
        try {
            const upstream = await openUpstream(target, body, stream);

            if (!upstream.ok) {
                const text = await upstream.text().catch(() => '');
                // 403 signature/permission, 429 queue, 402 "quota exceeded" (the
                // public endpoint answers this one per account) all mean *this*
                // account cannot serve the model right now, so a bare model name
                // is worth retrying against the next one. Pinned names answer as-is.
                const swappable = upstream.status === 403 || upstream.status === 429 || upstream.status === 402;
                if (canFailOver && swappable) {
                    accounts.markRateLimited(target.account.id, target.modelKey, Date.now() + 30_000);
                    lastError = Object.assign(new Error(`qoder HTTP ${upstream.status}: ${text.slice(0, 300)}`), { status: upstream.status });
                    continue;
                }
                if (!stream && !text) throw Object.assign(new Error(`qoder HTTP ${upstream.status}`), { status: upstream.status });
                res.status(upstream.status);
                res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                return res.send(text);
            }

            if (!stream && target.transport === 'public') {
                const text = await upstream.text();
                res.status(upstream.status);
                res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
                return res.send(text);
            }

            if (stream && target.transport === 'public') {
                await pipePublicStream(upstream, target, res);
                return;
            }

            if (stream) {
                const outcome = await pipeEncryptedStream(upstream, target, res);
                if (outcome.failed) {
                    if (canFailOver && outcome.body.code) continue;
                    if (!res.headersSent) return res.status(outcome.status).json({ error: outcome.body });
                }
                return;
            }

            // Encrypted is SSE-only: aggregate the unwrapped frames back into a
            // single completion for callers that did not ask for a stream.
            const result = await envelope.collectCompletion(upstream.body, target.name);
            if (result.error) {
                if (canFailOver) {
                    noteWait(target, envelope.waitInfoOf(result.error) || { code: '500', retryAfterMs: 30_000 });
                    lastError = Object.assign(new Error(result.error.message), { status: 502, code: result.error.code });
                    continue;
                }
                const status = envelope.waitInfoOf(result.error) ? 429 : 502;
                return res.status(status).json({ error: result.error });
            }
            res.status(200).json(result.completion);
            return;
        } catch (e) {
            lastError = e;
            const retryable = e.status === 403 || e.status === 429 || e.status === 502;
            if (canFailOver && retryable) {
                accounts.markRateLimited(target.account.id, target.modelKey, Date.now() + 30_000);
                continue;
            }
            throw e;
        }
    }

    if (lastError) throw lastError;
}

module.exports = { chatCompletion };
