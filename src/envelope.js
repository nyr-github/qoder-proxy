// Response unwrapping for the *encrypted* inference endpoint.
//
// `agent_chat_generation` answers SSE, but every frame carries one extra
// envelope around the real payload:
//
//   data:{"headers":{...},"body":"{\"choices\":[{\"delta\":{\"content\":\"Q\"}}]}",
//        "statusCodeValue":200,"statusCode":"OK"}
//                          ↑ the standard OpenAI chunk lives here, as a JSON string
//
// Only the *request* body is encrypted — the inner body is plain JSON, so this
// module just strips the envelope, it never decrypts anything.
//
// Frames are classified by JSON structure, never by substring sniffing. The
// sniffing version of this rule (dsh's first attempt) had two bugs pointing in
// opposite directions: `body: null` keep-alive frames were read as business
// errors (the model finishes answering and the caller still reports failure),
// and error text that happened to contain `"choices"` was passed through as if
// it were content. Heartbeats must be dropped outright — forwarding them yields
// `data: null`, which downstream becomes an unwrapped TypeError and bypasses
// every error classification.
//
// Error frames keep `code` as its own field and leave `message` untouched. The
// queue signal (10605) is only recognisable downstream through that field, and
// clients parse `retryAfterSeconds` out of the message body; appending the code
// to the message text breaks both, and the caller then retries with a 500ms…8s
// backoff while the server asked for 30s — i.e. it never gets through.

// Inner payload of an envelope frame, or null when the frame is not an envelope
// (then it already is a standard OpenAI frame and passes through unchanged).
function innerTextOf(payload) {
    try {
        const envelope = JSON.parse(payload);
        if (!envelope || typeof envelope !== 'object' || envelope.body === undefined) return null;
        return typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body);
    } catch {
        return null;
    }
}

// 'chunk' | 'error' | 'heartbeat'
function classifyInner(inner) {
    const trimmed = inner.trim();
    if (trimmed.length === 0) return 'heartbeat';
    if (trimmed === '[DONE]') return 'chunk';
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        // Unparseable text: treat as an error body (upstream returns plain
        // textual failures for some routes).
        return 'error';
    }
    // `typeof null === 'object'` — null and arrays and `{}` must not reach the
    // field checks below, they carry nothing to consume.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'heartbeat';
    // `choices: []` is a real chunk (the usage-only final frame emitted when
    // `stream_options.include_usage` is set).
    if (Array.isArray(parsed.choices) || parsed.usage !== undefined) return 'chunk';
    if (parsed.code !== undefined || parsed.message !== undefined || parsed.error !== undefined
        || parsed.statusCodeValue !== undefined || parsed.type !== undefined) return 'error';
    return 'heartbeat';
}

// Business error carried by the stream (HTTP status was 200).
function errorFrameOf(inner) {
    let code;
    let message = inner;
    try {
        const parsed = JSON.parse(inner);
        if (parsed && typeof parsed === 'object') {
            if (parsed.code !== undefined) code = parsed.code;
            else if (parsed.error && parsed.error.code !== undefined) code = parsed.error.code;
            if (typeof parsed.message === 'string') message = parsed.message;
            else if (parsed.error && typeof parsed.error.message === 'string') message = parsed.error.message;
        }
    } catch { /* keep the raw text as the message */ }
    return { code, message, type: 'model_error' };
}

// Queue / quota signals the upstream pushes mid-stream. Both are "this account
// cannot serve this model right now", so the pool records them and routes bare
// model names to another account meanwhile.
const WAIT_CODES = new Set(['10605', '110', '429', 'rate_limit', 'overloaded']);

function waitInfoOf(error) {
    if (error === null || error === undefined) return null;
    const code = String(error.code === undefined ? '' : error.code);
    if (!WAIT_CODES.has(code)) return null;
    const message = String(error.message || '');
    // The server puts the real wait into the message, sometimes as a JSON
    // object and sometimes as prose like "please retry in 60s". Both are read
    // so a caller can back off for the actual duration instead of guessing.
    const named = /"?retryAfterSeconds"?\s*[:=]\s*(\d+)/i.exec(message);
    const prose = /(\d+)\s*(?:s\b|秒|seconds?)/i.exec(message);
    const seconds = named ? parseInt(named[1], 10) : (prose ? parseInt(prose[1], 10) : 30);
    return { code, retryAfterMs: Math.min(Math.max(seconds || 30, 1), 3600) * 1000 };
}

// Strip the envelope off an SSE body and yield the standard frames inside.
// Yields { kind: 'chunk', data } / { kind: 'error', error } / { kind: 'done' }.
async function* unwrapStream(body) {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let sawDone = false;

    const processLine = function* (line) {
        if (line.length === 0) return;
        if (!line.startsWith('data:')) return; // `event:`/`:comment` lines carry nothing we must forward
        const payload = line.slice(5).trim();
        if (payload.length === 0) return;
        if (payload === '[DONE]') { sawDone = true; yield { kind: 'done' }; return; }

        const inner = innerTextOf(payload);
        const frame = inner === null ? payload : inner;
        const kind = inner === null ? classifyInner(payload) : classifyInner(frame);
        if (kind === 'heartbeat') return;
        if (kind === 'error') { yield { kind: 'error', error: errorFrameOf(frame) }; return; }
        if (frame.trim() === '[DONE]') { sawDone = true; yield { kind: 'done' }; return; }
        yield { kind: 'chunk', data: frame };
    };

    for await (const bytes of body) {
        buffer += decoder.decode(bytes, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            yield* processLine(line);
        }
    }
    const rest = buffer.trim();
    if (rest.length > 0) yield* processLine(rest);
    if (!sawDone) yield { kind: 'done' };
}

// Merge deltas back into a single `chat.completion`. The encrypted endpoint is
// SSE-only (`stream` is hardcoded true in the request body), so a non-stream
// caller has to be served from what the stream carried.
async function collectCompletion(body, model) {
    const out = {
        id: `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [],
    };
    const toolCalls = []; // by delta `index`
    let content = '';
    let reasoning = '';
    let finish = null;
    let usage = null;
    let error = null;

    for await (const frame of unwrapStream(body)) {
        if (frame.kind === 'error') { error = frame.error; continue; }
        if (frame.kind === 'done') continue;
        let chunk;
        try { chunk = JSON.parse(frame.data); } catch { continue; }
        if (chunk.id) out.id = chunk.id;
        if (chunk.model) out.model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        for (const choice of chunk.choices || []) {
            const delta = choice.delta || {};
            if (typeof delta.content === 'string') content += delta.content;
            if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
            if (choice.finish_reason) finish = choice.finish_reason;
            for (const call of delta.tool_calls || []) {
                const slot = toolCalls[call.index === undefined ? toolCalls.length : call.index];
                if (!slot) {
                    toolCalls[call.index === undefined ? toolCalls.length : call.index] = {
                        id: call.id || '', type: 'function',
                        function: { name: (call.function && call.function.name) || '', arguments: (call.function && call.function.arguments) || '' },
                    };
                } else {
                    if (call.id) slot.id = call.id;
                    if (call.function) {
                        if (call.function.name) slot.function.name += call.function.name;
                        if (call.function.arguments) slot.function.arguments += call.function.arguments;
                    }
                }
            }
        }
    }

    const failed = content.length === 0 && toolCalls.filter(Boolean).length === 0 && error !== null;
    if (failed) return { error };

    const message = { role: 'assistant', content: content.length > 0 ? content : (reasoning.length > 0 ? '' : null) };
    if (reasoning.length > 0) message.reasoning_content = reasoning;
    if (toolCalls.some(Boolean)) message.tool_calls = toolCalls.filter(Boolean);

    out.choices = [{ index: 0, finish_reason: finish || (content.length ? 'stop' : 'length'), message }];
    if (usage) out.usage = usage;
    return { completion: out, partialError: error || undefined };
}

module.exports = {
    innerTextOf,
    classifyInner,
    errorFrameOf,
    waitInfoOf,
    unwrapStream,
    collectCompletion,
};
