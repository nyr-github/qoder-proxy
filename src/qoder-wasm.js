// wasm-bindgen bridge for Qoder's embedded `qoder_auth_wasm` module.
//
// Why this exists: the client's real inference does NOT go through the public
// OpenAI-compatible endpoint. It posts an *encrypted* body to
//   POST {encryptedInferBase}/algo/api/v2/service/pro/sse/agent_chat_generation
//        ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
// and that endpoint is the only one that accepts catalog model keys
// (`qfmodel`, `dmodel`, ...). The public endpoint knows a handful of generic
// names only.
//
// This is not cryptanalysis: the WASM ships matching encode/decode exports, so
// we are using the client's own keys for the client's own protocol.
//
// Three quirks that cost upstream a debugging session each (do not "clean up"):
//   1. the two `getRandomValues` imports have OPPOSITE signatures —
//      `_d49329ff89a07af1` writes wasm memory, `_c44a50d8cfdaebeb` calls a JS
//      object. Swap them and Rust panics with `unreachable`.
//   2. two different return layouts: string-ish functions are
//      `ptr/len/valIdx/isErr`, while `qodercontext_new` / `prepareInferRequest`
//      are `ptr/errIdx/isErr`. Mixing them gives "null pointer passed to rust".
//   3. `requestresult_url(stackPtr, ptr)` takes the stack pointer FIRST.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Node 18 does not guarantee a global Web Crypto object, but the wasm module
// asks for getRandomValues through it.
const randomValues = target => {
    const c = globalThis.crypto && globalThis.crypto.getRandomValues
        ? globalThis.crypto
        : (crypto.webcrypto || crypto);
    return c.getRandomValues(target);
};

const WASM_PATH = path.join(__dirname, '..', 'vendor', 'qoder-auth-wasm.wasm');

// Name baked into the wasm binary; must match exactly or instantiate fails.
const IMPORT_MODULE = './qoder_auth_wasm_bg.js';

// Client version reported through Cosy-Version and folded into the signature.
const COSY_VERSION = '1.1.49';

let gluePromise = null;

function buildGlue() {
    const bytes = fs.readFileSync(WASM_PATH);
    return WebAssembly.compile(bytes).then(module => {
        let exports = {};

        let cachedHeap = null;
        let cachedView = null;
        const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        const encoder = new TextEncoder();

        const heap = () => {
            if (cachedHeap === null || cachedHeap.byteLength === 0) {
                cachedHeap = new Uint8Array(exports.memory.buffer);
            }
            return cachedHeap;
        };
        const view = () => {
            if (cachedView === null || cachedView.buffer !== exports.memory.buffer) {
                cachedView = new DataView(exports.memory.buffer);
            }
            return cachedView;
        };
        const readString = (ptr, len) => decoder.decode(heap().subarray(ptr >>> 0, (ptr >>> 0) + len));

        // Object heap, mirrors wasm-bindgen's `wW`: 1024 undefined slots plus
        // four sentinels (undefined/null/true/false) that must never be recycled.
        const objects = new Array(1024).fill(undefined);
        objects.push(undefined, null, true, false);
        let firstFree = objects.length;
        const heapObject = index => objects[index];
        const pushObject = value => {
            if (firstFree === objects.length) objects.push(objects.length + 1);
            const index = firstFree;
            firstFree = objects[index];
            objects[index] = value;
            return index;
        };
        const takeObject = index => {
            const value = heapObject(index);
            if (index >= 1028) {
                objects[index] = firstFree;
                firstFree = index;
            }
            return value;
        };

        let lastLength = 0;
        const writeString = text => {
            const encoded = encoder.encode(text);
            const ptr = exports.__wbindgen_export2(encoded.length, 1) >>> 0;
            heap().subarray(ptr, ptr + encoded.length).set(encoded);
            lastLength = encoded.length;
            return ptr;
        };

        // Call a wasm function that returns a string through the stack.
        const callString = invoke => {
            let ptr = 0;
            let len = 0;
            const stack = exports.__wbindgen_add_to_stack_pointer(-16);
            try {
                invoke(stack);
                const v = view();
                ptr = v.getInt32(stack + 0, true);
                len = v.getInt32(stack + 4, true);
                const valIdx = v.getInt32(stack + 8, true);
                const isError = v.getInt32(stack + 12, true);
                if (isError) throw takeObject(valIdx);
                return readString(ptr, len);
            } finally {
                exports.__wbindgen_add_to_stack_pointer(16);
                if (ptr) exports.__wbindgen_export4(ptr, len, 1);
            }
        };

        // Call a wasm function that returns an opaque pointer (ptr/errIdx/isErr).
        const callPointer = invoke => {
            const stack = exports.__wbindgen_add_to_stack_pointer(-16);
            try {
                invoke(stack);
                const v = view();
                const ptr = v.getInt32(stack + 0, true);
                const errIdx = v.getInt32(stack + 4, true);
                const isError = v.getInt32(stack + 8, true);
                if (isError) throw takeObject(errIdx);
                return ptr;
            } finally {
                exports.__wbindgen_add_to_stack_pointer(16);
            }
        };

        const guard = (fn, args) => {
            try {
                fn(...args);
            } catch (error) {
                exports.__wbindgen_export(pushObject(error));
            }
        };

        const imports = {
            __wbindgen_object_drop_ref: a => takeObject(a),
            __wbindgen_object_clone_ref: a => pushObject(heapObject(a)),
            __wbindgen_cast_0000000000000001: (a, e) => pushObject(heap().subarray(a >>> 0, (a >>> 0) + e)),
            __wbindgen_cast_0000000000000002: (a, e) => pushObject(readString(a, e)),
            __wbg_set_08463b1df38a7e29: (a, e, t) =>
                pushObject(heapObject(a).set(heapObject(e), heapObject(t))),
            __wbg_getRandomValues_d49329ff89a07af1: (...a) =>
                guard((x, y) => { randomValues(heap().subarray(x >>> 0, (x >>> 0) + y)); }, a),
            __wbg_getRandomValues_c44a50d8cfdaebeb: (...a) =>
                guard((x, y) => { heapObject(x).getRandomValues(heapObject(y)); }, a),
            __wbg_crypto_38df2bab126b63dc: a => pushObject(heapObject(a).crypto),
            __wbg_process_44c7a14e11e9f69e: a => pushObject(heapObject(a).process),
            __wbg_versions_276b2795b1c6a219: a => pushObject(heapObject(a).versions),
            __wbg_node_84ea875411254db1: a => pushObject(heapObject(a).node),
            __wbg_require_b4edbdcf3e2a1ef0: (...a) => guard(() => pushObject(module), a),
            __wbg_msCrypto_bd5a034af96bcba6: a => pushObject(heapObject(a).msCrypto),
            __wbg_randomFillSync_6c25eac9869eb53c: (...a) =>
                guard((x, y) => { heapObject(x).randomFillSync(takeObject(y)); }, a),
            __wbg_call_d578befcc3145dee: (...a) =>
                guard((fn, self, arg) => { pushObject(fn.call(self, arg)); }, a),
            __wbg_new_with_length_9cedd08484b73942: a => pushObject(new Uint8Array(a >>> 0)),
            __wbg_length_0c32cb8543c8e4c8: a => heapObject(a).length,
            __wbg_prototypesetcall_3e05eb9545565046: (a, e, t) => {
                Uint8Array.prototype.set.call(heap().subarray(a >>> 0, (a >>> 0) + e), heapObject(t));
            },
            __wbg_subarray_0f98d3fb634508ad: (a, e, t) => pushObject(heapObject(a).subarray(e >>> 0, t >>> 0)),
            __wbg_new_99cabae501c0a8a0: () => pushObject(new Map()),
            __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
            __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => pushObject(globalThis),
            __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => pushObject(globalThis),
            __wbg_static_accessor_SELF_24f78b6d23f286ea: () =>
                (globalThis.self === undefined ? 0 : pushObject(globalThis.self)),
            __wbg_static_accessor_WINDOW_59fd959c540fe405: () =>
                (globalThis.window === undefined ? 0 : pushObject(globalThis.window)),
            __wbg___wbindgen_throw_81fc77679af83bc6: (p, l) => { throw new Error(readString(p, l)); },
            __wbg_Error_2e59b1b37a9a34c3: (p, l) => pushObject(new Error(readString(p, l))),
            __wbg___wbindgen_is_object_40c5a80572e8f9d3: id => {
                const v = heapObject(id);
                return typeof v === 'object' && v !== null;
            },
            __wbg___wbindgen_is_string_b29b5c5a8065ba1a: id => typeof heapObject(id) === 'string',
            __wbg___wbindgen_is_function_49868bde5eb1e745: id => typeof heapObject(id) === 'function',
            __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: id => heapObject(id) === undefined,
        };

        return WebAssembly.instantiate(module, { [IMPORT_MODULE]: imports }).then(instance => {
            exports = instance.exports;
            return {
                exports, heap, view, readString, writeString,
                lastLength: () => lastLength,
                heapObject, pushObject, takeObject,
                callString, callPointer,
            };
        });
    });
}

function getGlue() {
    if (!gluePromise) gluePromise = buildGlue();
    return gluePromise;
}

// encrypt_user_info / key: what the server uses to identify the caller inside
// the encrypted envelope.
async function generateRuntimeAuthFields(user) {
    const g = await getGlue();
    const payload = JSON.stringify({
        uid: user.uid,
        security_oauth_token: user.securityOauthToken,
        organization_id: user.organizationId || '',
        organization_tags: user.organizationTags || [],
        data_policy_agreed: user.dataPolicyAgreed || false,
    });
    const raw = g.callString(stack => {
        const a = g.writeString(payload);
        g.exports.generate_runtime_auth_fields(stack, a, g.lastLength());
    });
    return JSON.parse(raw);
}

// Read a locally cached, WASM-encrypted model catalog (~/.qoder*/.models/<uid>/catalog-v6).
// machine_id is a real second argument: omitting it surfaces as
// "AES-GCM decrypt failed: aead::Error", which looks like corrupt input.
async function decryptModelCatalog(encrypted, machineId) {
    const g = await getGlue();
    const raw = g.callString(stack => {
        const a = g.writeString(encrypted); const aLen = g.lastLength();
        const b = g.writeString(machineId); const bLen = g.lastLength();
        g.exports.model_cache_decrypt(stack, a, aLen, b, bLen);
    });
    return JSON.parse(raw);
}

// Plaintext body for agent_chat_generation, replicating the client's envelope
// structure. Two fields are load-bearing and easy to break:
//   - `business` decides the server-side routing pool. Without it, `qfmodel`
//     lands on a broken node and returns "[FAIL]node:... Execution failed",
//     which reads like "this model is down" while the IDE works fine.
//   - `chat_context` must not be an empty object.
// The endpoint is SSE-only (stream is hardcoded true); non-stream callers get
// an accumulated completion built from the unwrapped frames.
function buildInferPayload(ask, requestId = crypto.randomUUID()) {
    const isReasoning = ask.isReasoning || false;
    const text = ask.userText;

    const parameters = {};
    if (ask.maxTokens !== undefined) parameters.max_tokens = ask.maxTokens;
    if (ask.reasoningEffort !== undefined) {
        parameters.reasoning_effort = ask.reasoningEffort;
        parameters.enable_thinking = ask.reasoningEffort !== 'none';
    }
    if (ask.contextWindow !== undefined) parameters.context_length = ask.contextWindow;

    const messages = [];
    for (const m of ask.history || []) {
        // Field-by-field copy: only the three keys the protocol knows about.
        // Passing caller-internal fields upstream has bitten upstream before.
        messages.push({
            role: m.role,
            content: m.content,
            ...(m.tool_calls === undefined ? {} : { tool_calls: m.tool_calls }),
            ...(m.tool_call_id === undefined ? {} : { tool_call_id: m.tool_call_id }),
        });
    }
    if (messages.length === 0) messages.push({ role: 'user', content: text });

    return {
        request_id: requestId,
        request_set_id: requestId,
        chat_record_id: requestId,
        session_id: crypto.randomUUID(),
        stream: true,
        chat_task: 'FREE_INPUT',
        chat_context: {
            text,
            features: [],
            extra: {
                context: [],
                modelConfig: { key: ask.modelKey, is_reasoning: isReasoning },
                originalContent: text,
            },
            chatPrompt: '',
            imageUrls: null,
        },
        is_reply: true,
        is_retry: false,
        source: 1,
        version: '3',
        agent_id: 'agent_common',
        task_id: 'common',
        // intl CLI is `qodercli`; the CN build reports `qoder_work`.
        session_type: ask.sessionType || 'qodercli',
        aliyun_user_type: '',
        model_config: {
            key: ask.modelKey,
            display_name: ask.displayName || '',
            model: '',
            format: ask.format || 'openai',
            is_vl: ask.isVl === undefined ? true : ask.isVl,
            is_reasoning: isReasoning,
            api_key: '',
            url: '',
            source: ask.source || 'system',
            max_input_tokens: ask.maxInputTokens || ask.contextWindow || 200_000,
        },
        custom_model: null,
        system: ask.systemText ? [{ type: 'text', text: ask.systemText }] : [],
        messages,
        // Tools belong at the top level and the key is always present (empty
        // array when none): hardcoding [] earlier made the model invent XML
        // tool calls in prose because it never saw a function schema.
        tools: ask.tools || [],
        parameters,
        ...(ask.business === undefined ? {} : { business: ask.business }),
    };
}

// One encrypted-inference client per account (the wasm context is stateful).
class EncryptedInfer {
    constructor(g, context, host) {
        this.g = g;
        this.context = context;
        this.host = host;
    }

    static async create({ user, machineId, metadata, host, clientVersion }) {
        const g = await getGlue();
        const fields = await generateRuntimeAuthFields(user);
        const version = clientVersion || COSY_VERSION;

        const userInfoJson = JSON.stringify({
            uid: user.uid,
            encrypt_user_info: fields.encrypt_user_info,
            key: fields.key,
            organization_id: user.organizationId || '',
            organization_tags: user.organizationTags || [],
            data_policy_agreed: user.dataPolicyAgreed || false,
        });

        const context = g.callPointer(stack => {
            const machine = g.writeString(machineId); const machineLen = g.lastLength();
            const ver = g.writeString(version); const verLen = g.lastLength();
            const info = g.writeString(userInfoJson); const infoLen = g.lastLength();
            const meta = g.writeString(JSON.stringify(metadata)); const metaLen = g.lastLength();
            g.exports.qodercontext_new(stack, machine, machineLen, ver, verLen, info, infoLen, meta, metaLen);
        });

        return new EncryptedInfer(g, context, host);
    }

    // Returns { url, headers, body }. The headers must be forwarded verbatim:
    // Authorization is a wasm-signed `Bearer COSY.<payload>.<sig>`; replacing
    // it with a plain bearer token yields 403 Signature invalid.
    prepareInfer(ask) {
        const g = this.g;
        const payload = buildInferPayload(ask);

        const result = g.callPointer(stack => {
            const host = g.writeString(this.host); const hostLen = g.lastLength();
            const body = g.writeString(JSON.stringify(payload)); const bodyLen = g.lastLength();
            const key = g.writeString(ask.modelKey); const keyLen = g.lastLength();
            const source = g.writeString(ask.source || 'system'); const sourceLen = g.lastLength();
            g.exports.qodercontext_prepareInferRequest(
                stack, this.context, host, hostLen, body, bodyLen, key, keyLen, source, sourceLen,
            );
        });

        const headerMap = g.takeObject(g.exports.requestresult_headers(result));
        const headers = {};
        if (headerMap instanceof Map) {
            for (const [k, v] of headerMap) headers[String(k)] = String(v);
        }

        const readResultString = invoke => {
            const v = g.view();
            const stack = g.exports.__wbindgen_add_to_stack_pointer(-16);
            try {
                invoke(stack, result);
                const ptr = v.getInt32(stack + 0, true);
                const len = v.getInt32(stack + 4, true);
                return ptr ? g.readString(ptr, len) : '';
            } finally {
                g.exports.__wbindgen_add_to_stack_pointer(16);
            }
        };

        return {
            url: readResultString((stack, ptr) => g.exports.requestresult_url(stack, ptr)),
            headers,
            body: readResultString((stack, ptr) => g.exports.requestresult_body(stack, ptr)),
        };
    }
}

module.exports = {
    WASM_PATH,
    COSY_VERSION,
    generateRuntimeAuthFields,
    decryptModelCatalog,
    buildInferPayload,
    EncryptedInfer,
};
