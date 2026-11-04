// Product presets: qoder (international) and qodercn (China).
//
// The two share one protocol implementation — every difference lives here
// (endpoint hosts, OAuth client ids, model catalogs). A wrong client_id does
// not fail at the login page: the authorize screen renders fine and the
// server rejects only after the user clicks authorize, which reads as
// "invalid parameters, please login from the IDE client".
//
// Model catalogs are transcribed from dsh-our-free-model's reverse-engineered
// catalog-v6 dumps (2026-09 measurements), not guessed.
const os = require('os');
const path = require('path');

const PRODUCTS = {
    qoder: {
        id: 'qoder',
        displayName: 'Qoder',
        tag: 'a',                     // short label used in per-account model names
        authBase: 'https://qoder.com',
        openApiBase: 'https://openapi.qoder.sh',
        // Public OpenAI-compatible endpoint: Bearer auth, but only accepts
        // generic names (qwen-flash...), never catalog keys.
        apiBase: 'https://api2-v2.qoder.sh',
        // Encrypted endpoint host — a DIFFERENT host from apiBase; using the
        // public one here 404s. This is the only route that accepts catalog
        // keys and the full 1M-context roster.
        encryptedApiBase: 'https://api2.qoder.sh',
        clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
        // intl CLI reports session_type=qodercli
        sessionType: 'qodercli',
        // Identity inside the encrypted request envelope. client_type '5' +
        // business_product 'cli' is what the CLI itself sends; the desktop app
        // uses 10/'app' and is only right for the /sash/ usage endpoints.
        clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
    },
    qodercn: {
        id: 'qodercn',
        displayName: 'Qoder (中国版)',
        tag: 'c',
        authBase: 'https://qoder.cn',
        openApiBase: 'https://openapi.qoder.com.cn',
        // Measured again on 2026-11-04: 404 on both CN gateway/openapi hosts
        // (dsh saw 503 earlier). CN has no public OpenAI-compatible route at
        // all — keep the value for env override experiments, never rely on it.
        apiBase: 'https://gateway.qoder.com.cn',
        encryptedApiBase: 'https://gateway.qoder.com.cn',
        clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
        // The CN build reports qoder_work instead.
        sessionType: 'qoder_work',
        // CN's own desktop client sends 10/'app'; the CLI identity is reused
        // here because it is what the international path is measured to accept.
        clientMetadata: { client_type: '5', business_product: 'cli', business_type: 'agent', scene: 'assistant' },
    },
};

const CHAT_PATH = '/model/v1/chat/completions';
const ENCRYPTED_CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

// Catalog entry:
//   key            catalog key, the `model` value for the encrypted endpoint
//   name           display name from the catalog
//   context        context window (max tier of the official tier table, NOT
//                  max_input_tokens — the two disagree and the client follows
//                  the tier table)
//   vision/reason  is_vl / is_reasoning
//   free           is_free (quota-free models)
//   price          price_factor at collection time (0 is a real price: free)
//   efforts        thinking tiers, catalog order; no `none` — disabling is
//                  carried by `canDisable`
//   effort         default tier (the one flagged is_default)
//   canDisable     catalog exposes a `disabled` branch, thinking can be off
const QODER_MODELS = [
    { key: 'auto', name: 'Auto', context: 200_000, vision: true },
    { key: 'ultimate', name: 'Ultimate', context: 1_000_000, vision: true, reason: true, price: 2, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], effort: 'high', canDisable: true },
    { key: 'performance', name: 'Performance', context: 1_000_000, vision: true, price: 1.1, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], effort: 'medium', canDisable: true },
    { key: 'efficient', name: 'Efficient', context: 1_000_000, vision: true, price: 0.3 },
    { key: 'smodel', name: 'Sonus', context: 1_000_000, vision: true, reason: true, price: 8, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], effort: 'high' },
    { key: 'cmodel', name: 'Cantus', context: 1_000_000, vision: true, reason: true, price: 4, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], effort: 'high' },
    { key: 'qmodel_38max', name: 'Qwen3.8-Max', context: 1_000_000, vision: true, reason: true, price: 0.2, efforts: ['xhigh', 'low', 'medium'], effort: 'xhigh', canDisable: true },
    { key: 'qfmodel', name: 'Qwen3.8-Flash', context: 1_000_000, vision: true, reason: true, free: true, price: 0, efforts: ['xhigh', 'low', 'medium'], effort: 'medium', canDisable: true },
    { key: 'qmodel_latest', name: 'Qwen3.7-Max', context: 1_000_000, vision: true, price: 0.1, canDisable: true },
    { key: 'qmodel', name: 'Qwen3.7-Plus', context: 1_000_000, vision: true, price: 0.04, canDisable: true },
    { key: 'kmodel_latest', name: 'Kimi-K3', context: 1_000_000, vision: true, price: 1.4, efforts: ['high', 'low', 'max'], effort: 'max' },
    { key: 'kmodel', name: 'Kimi-K2.8-Preview', context: 1_000_000, vision: true, price: 0.8, efforts: ['high', 'low', 'max'], effort: 'max' },
    { key: 'gmodel', name: 'GLM-5.3', context: 1_000_000, vision: true, reason: true, price: 0.8, efforts: ['high', 'low', 'max'], effort: 'max' },
    { key: 'gfmodel', name: 'GLM-5.3-Flash', context: 1_000_000, vision: true, reason: true, price: 0.1, efforts: ['high', 'max'], effort: 'max' },
    { key: 'dmodel', name: 'DeepSeek-V4-Pro', context: 1_000_000, vision: true, reason: true, price: 0.5, efforts: ['high', 'max'], effort: 'max', canDisable: true },
    { key: 'dfmodel', name: 'DeepSeek-Flash', context: 1_000_000, vision: true, reason: true, price: 0.1, efforts: ['high', 'max', 'low'], effort: 'max', canDisable: true },
    { key: 'mmodel', name: 'MiniMax-M3', context: 1_000_000, vision: true, price: 0.2 },
];

// CN is NOT the international list: it adds q37fmodel/gm51model, drops
// ultimate/performance/efficient/smodel/cmodel, ships MiniMax-M2.7 instead of
// M3, and differs on thinking/vision flags for several entries. Reusing the
// international table would offer five models the CN gateway rejects outright.
const QODERCN_MODELS = [
    { key: 'auto', name: 'Auto', context: 200_000, vision: true, reason: true },
    { key: 'qmodel_38max', name: 'Qwen3.8-Max', context: 1_000_000, vision: true, reason: true, price: 0.2, efforts: ['xhigh', 'low', 'medium'], effort: 'medium', canDisable: true },
    { key: 'qfmodel', name: 'Qwen3.8-Flash', context: 1_000_000, vision: true, reason: true, free: true, price: 0, efforts: ['xhigh', 'low', 'medium'], effort: 'medium', canDisable: true },
    { key: 'qmodel_latest', name: 'Qwen3.7-Max', context: 1_000_000, vision: true, reason: true, price: 0.1, canDisable: true },
    { key: 'qmodel', name: 'Qwen3.7-Plus', context: 1_000_000, vision: true, reason: true, price: 0.04, canDisable: true },
    { key: 'q37fmodel', name: 'Qwen3.7-Flash', context: 1_000_000, vision: true, reason: true, price: 0.1 },
    { key: 'dmodel', name: 'DeepSeek-V4-Pro', context: 1_000_000, vision: true, reason: true, price: 0.5, efforts: ['high', 'max'], effort: 'max', canDisable: true },
    { key: 'dfmodel', name: 'DeepSeek-Flash', context: 1_000_000, vision: true, price: 0.1, efforts: ['high', 'max', 'low'], effort: 'max', canDisable: true },
    { key: 'gmodel', name: 'GLM-5.3', context: 1_000_000, vision: true, reason: true, price: 0.8, efforts: ['high', 'low', 'max'], effort: 'max' },
    { key: 'gfmodel', name: 'GLM-5.3-Flash', context: 1_000_000, vision: true, reason: true, price: 0.1, efforts: ['high', 'max'], effort: 'max' },
    { key: 'gm51model', name: 'GLM-5.2', context: 1_000_000, vision: true, reason: true, price: 0.6, efforts: ['high', 'max'], effort: 'max', canDisable: true },
    { key: 'kmodel_latest', name: 'Kimi-K3', context: 1_000_000, vision: true, price: 1.4, efforts: ['high', 'low', 'max'], effort: 'max' },
    { key: 'kmodel', name: 'Kimi-K2.8-Preview', context: 1_000_000, vision: true, reason: true, price: 0.8, efforts: ['high', 'low', 'max'], effort: 'max' },
    // CN is_vl is false here and the tier table only offers 200K — the one
    // CN entry that must not be bumped to 1M.
    { key: 'mmodel', name: 'MiniMax-M2.7', context: 200_000, price: 0.2 },
];

const catalogs = { qoder: QODER_MODELS, qodercn: QODERCN_MODELS };

// Env overrides apply to the product the process is configured for, so a
// single-account setup can retune endpoints without touching code (and a
// multi-account pool is not silently rewritten through the wrong product).
(function applyEnvOverrides() {
    const target = resolveProduct(process.env.QODER_PRODUCT) || PRODUCTS.qoder;
    const assign = (key, value) => { if (value) target[key] = value.replace(/\/+$/, ''); };
    assign('authBase', process.env.QODER_AUTH_BASE);
    assign('openApiBase', process.env.QODER_OPENAPI_BASE);
    assign('apiBase', process.env.QODER_API_BASE);
    assign('encryptedApiBase', process.env.QODER_ENCRYPTED_API_BASE);
    if (process.env.QODER_CLIENT_ID) target.clientId = process.env.QODER_CLIENT_ID;
})();

function productIds() {
    return Object.keys(PRODUCTS);
}

// Accepts 'qoder' / 'qodercn' and the casual spellings users type in a CLI.
function resolveProduct(input) {
    if (!input) return null;
    const key = String(input).trim().toLowerCase().replace(/[^\w]/g, '');
    if (key === 'qoder') return PRODUCTS.qoder;
    if (key === 'qodercn' || key === 'qoder_cn' || key === 'qoder-cn' || key === 'cn') return PRODUCTS.qodercn;
    return null;
}

function catalogFor(id) {
    return catalogs[id] || [];
}

function findModel(id, key) {
    return catalogFor(id).find(m => m.key === key) || null;
}

// Model identifiers people actually type are the catalog key (`qfmodel`) or the
// display name (`Qwen3.8-Flash`). Names carry dots, dashes and spaces, so
// comparison keeps only letters and digits: `glm-5.3`, `GLM 5.3` and `GLM53`
// then all mean the same entry.
function normalizeModelName(input) {
    return String(input === undefined || input === null ? '' : input).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Resolve one token of one product line to a catalog entry. The exact key wins,
// then the display name, then a normalised key (so `QFModel` still lands).
// Returns null when this product simply does not offer it.
function resolveModel(id, token) {
    const raw = String(token === undefined || token === null ? '' : token).trim();
    if (!raw) return null;
    const catalog = catalogFor(id);
    return catalog.find(m => m.key === raw)
        || catalog.find(m => normalizeModelName(m.name) === normalizeModelName(raw))
        || catalog.find(m => normalizeModelName(m.key) === normalizeModelName(raw))
        || null;
}

module.exports = {
    PRODUCTS,
    CHAT_PATH,
    ENCRYPTED_CHAT_PATH,
    productIds,
    resolveProduct,
    catalogFor,
    findModel,
    resolveModel,
    normalizeModelName,
    accountsFile: process.env.QODER_PROXY_ACCOUNTS_FILE
        || path.join(os.homedir(), '.qoder-proxy', 'accounts.json'),
};
