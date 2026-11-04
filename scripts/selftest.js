// pnpm run selftest — offline regression for the parts that cannot be checked
// without burning a real login: product presets, account-pool routing, envelope
// unwrapping, OpenAI->encrypted ask conversion, and WASM request signing.
//
// It never touches the real ~/.qoder-proxy: the pool file is redirected to a
// temp path *before* the modules read it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-proxy-selftest-'));
process.env.QODER_PROXY_ACCOUNTS_FILE = path.join(tmpDir, 'accounts.json');
// Migration source must also be redirected: pointing it at the real
// credentials.json would rename that file as a side effect of running a test.
process.env.QODER_PROXY_CRED_FILE = path.join(tmpDir, 'credentials.json');
delete process.env.QODER_ACCESS_TOKEN;
delete process.env.QODER_PRODUCT;

const products = require('../src/products');
const accounts = require('../src/accounts');
const envelope = require('../src/envelope');
const encrypted = require('../src/encrypted');
const wasm = require('../src/qoder-wasm');

let failures = 0;
function check(name, condition, detail) {
    if (condition) { console.log(`  ok   ${name}`); return; }
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? '' : ` — ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`}`);
}

function writePool(list) {
    fs.writeFileSync(products.accountsFile, JSON.stringify({ accounts: list }, null, 2));
}

function poolEntry(product, seq) {
    const preset = products.PRODUCTS[product];
    return {
        id: `${preset.tag}:uid-${product}`,
        alias: `${preset.tag}${seq}`,
        product,
        nickname: `${product} user`,
        uid: `uid-${product}`,
        machine_id: `machine-${product}`,
        security_oauth_token: `token-${product}`,
        access_token: `token-${product}`,
        refresh_token: `refresh-${product}`,
        expire_time: Date.now() + 3_600_000,
        enabled: true,
        model_rate_limits: {},
    };
}

function bytes(text) { return new TextEncoder().encode(text); }

// Feed an SSE body through the unwrapper, split mid-frame on purpose: a
// transport boundary must not be read as a frame boundary.
async function unwrapChunks(frames) {
    const body = (async function* () {
        const raw = frames.join('');
        for (let i = 0; i < raw.length; i += 37) yield bytes(raw.slice(i, i + 37));
    })();
    const out = [];
    for await (const frame of envelope.unwrapStream(body)) out.push(frame);
    return out;
}

const envelopeFrame = inner => `data:{"headers":{},"body":${JSON.stringify(typeof inner === 'string' ? inner : JSON.stringify(inner))},"statusCodeValue":200,"statusCode":"OK"}\n\n`;

async function testProducts() {
    console.log('\n[1] product presets');
    check('qoder catalog has 17 models', products.catalogFor('qoder').length === 17, products.catalogFor('qoder').length);
    check('qodercn catalog has 14 models', products.catalogFor('qodercn').length === 14, products.catalogFor('qodercn').length);
    check('CN keeps its own entries', !!products.findModel('qodercn', 'q37fmodel') && !products.findModel('qodercn', 'ultimate'));
    check('CN MiniMax is M2.7 / 200K', products.findModel('qodercn', 'mmodel').name === 'MiniMax-M2.7'
        && products.findModel('qodercn', 'mmodel').context === 200_000);
    check('client ids differ per product', products.PRODUCTS.qoder.clientId !== products.PRODUCTS.qodercn.clientId);
    check('session types differ', products.PRODUCTS.qoder.sessionType === 'qodercli'
        && products.PRODUCTS.qodercn.sessionType === 'qoder_work');
    check('encrypted host is not the public host', products.PRODUCTS.qoder.encryptedApiBase !== products.PRODUCTS.qoder.apiBase);
    check('cn/qoder-cn spellings resolve', products.resolveProduct('cn') === products.PRODUCTS.qodercn
        && products.resolveProduct('Qoder CN') === products.PRODUCTS.qodercn);
}

async function testMigration() {
    console.log('\n[2] legacy single-credential migration');
    fs.rmSync(products.accountsFile, { force: true });
    fs.rmSync(`${process.env.QODER_PROXY_CRED_FILE}.migrated`, { force: true });
    fs.writeFileSync(process.env.QODER_PROXY_CRED_FILE, JSON.stringify({
        security_oauth_token: 'legacy-token',
        access_token: 'legacy-token',
        refresh_token: 'legacy-refresh',
        uid: 'legacy-uid',
        machine_id: 'legacy-machine',
        nickname: 'old style user',
    }));
    const list = accounts.list();
    check('old credential becomes the first pooled account', list.length === 1 && list[0].alias === 'a1'
        && list[0].uid === 'legacy-uid' && list[0].access_token === 'legacy-token', list.map(a => a.alias));
    check('id shape matches upsert', list[0].id === 'a:legacy-uid', list[0].id);
    check('migration result is persisted (a crash cannot lose the login)',
        fs.existsSync(products.accountsFile) && fs.readFileSync(products.accountsFile, 'utf8').includes('legacy-token'));
    check('legacy file is renamed, not deleted',
        !fs.existsSync(process.env.QODER_PROXY_CRED_FILE)
        && fs.existsSync(`${process.env.QODER_PROXY_CRED_FILE}.migrated`));

    // Logging out empties the pool; an emptied pool must not resurrect the old
    // credential from the .migrated file on the next read.
    accounts.removeAll();
    check('logout is not undone by the migration path', accounts.list().length === 0);
    fs.rmSync(products.accountsFile, { force: true });
    check('a half-migrated pool recovers from .migrated',
        accounts.list().length === 1 && accounts.list()[0].uid === 'legacy-uid');

    // Re-login of the same uid must not pile up duplicates.
    accounts.upsert({ uid: 'legacy-uid', access_token: 'new-token', security_oauth_token: 'new-token', machine_id: 'legacy-machine' }, 'qoder');
    const after = accounts.list();
    check('same uid on same product replaces instead of duplicating',
        after.length === 1 && after[0].access_token === 'new-token', after.length);
    // The alias is the name clients use, so overwriting must not rename it.
    check('re-login keeps the alias and the stored nickname',
        after.length === 1 && after[0].alias === 'a1' && after[0].nickname === 'old style user', after[0] && after[0].alias);
    accounts.upsert({ access_token: 'cn-token', security_oauth_token: 'cn-token' }, 'qodercn');
    check('same product line, different uid is another account',
        accounts.list().length === 2 && accounts.list().some(a => a.alias === 'c1'));
    check('a missing uid is kept missing, not invented',
        accounts.list().find(a => a.alias === 'c1').uid === null);
    accounts.upsert({ uid: 'second-intl', access_token: 'i2', security_oauth_token: 'i2' }, 'qoder');
    accounts.upsert({ uid: 'second-cn', access_token: 'n2', security_oauth_token: 'n2' }, 'qodercn');
    const aliases = accounts.list().map(a => a.alias).sort();
    check('aliases number per product line, not per file position',
        aliases.join(',') === 'a1,a2,c1,c2', aliases);

    fs.rmSync(`${process.env.QODER_PROXY_CRED_FILE}.migrated`, { force: true });
    writePool([poolEntry('qoder', 1), poolEntry('qodercn', 1)]);
}

async function testRouting() {
    console.log('\n[3] account pool + model-name routing');
    writePool([]);
    fs.rmSync(`${process.env.QODER_PROXY_CRED_FILE}.migrated`, { force: true });
    let threw = null;
    try { accounts.resolveTarget('qfmodel'); } catch (e) { threw = e; }
    check('empty pool -> 401 asking for login', threw && threw.status === 401, threw && threw.message);

    writePool([poolEntry('qoder', 1), poolEntry('qodercn', 1)]);
    const listed = accounts.modelNameCatalog();
    const names = listed.map(m => m.id);
    check('intl account is listed by name-product-alias', names.includes('Qwen3.8-Flash-qoder@a1'), names[0]);
    check('CN account is listed by name-product-alias', names.includes('GLM-5.2-qodercn@c1'));
    check('public names only on intl', names.includes('qwen-flash-qoder@a1') && !names.includes('qwen-flash-qodercn@c1'));
    check('no duplicate ids across accounts', new Set(names).size === names.length, names.length);
    check('list is exactly one row per account x model', names.every(n => n.includes('@'))
        && names.length === 17 + 2 + 14, names.length);

    // The caller may use the display name or Qoder's short key; both must land
    // on the same entry, and only the short key may ever reach the upstream.
    const byName = accounts.resolveTarget('Qwen3.8-Flash');
    check('display name resolves to the catalog entry', byName.model && byName.model.key === 'qfmodel', byName.model && byName.model.key);
    check('display name keeps the short key for upstream', byName.modelKey === 'qfmodel');
    check('short key reports the same upstream key', accounts.resolveTarget('qfmodel').modelKey === 'qfmodel');
    check('case, dashes and spaces are all tolerated',
        accounts.resolveTarget(' qwen3.8 flash ').model.key === 'qfmodel'
        && accounts.resolveTarget('GLM-5.2').model.key === 'gm51model');
    check('display name with alias pins the account',
        accounts.resolveTarget('GLM-5.2@c1').account.alias === 'c1'
        && accounts.candidateTargets('GLM-5.2@c1').length === 1);
    check('intl-only names stay unknown to the CN account', (() => {
        try { accounts.resolveTarget('Ultimate@c1'); return false; } catch (e) { return e.status === 404; }
    })());

    // The product segment in the listed id also narrows the account pool.
    check('product segment alone routes to that line',
        accounts.resolveTarget('Qwen3.8-Flash-qodercn').product.id === 'qodercn'
        && accounts.resolveTarget('Ultimate-qoder').product.id === 'qoder');
    check('listed id form round-trips to the same entry', (() => {
        const row = listed.find(m => m.id === 'GLM-5.2-qodercn@c1');
        const hit = accounts.resolveTarget(row.id);
        return hit.account.alias === 'c1' && hit.modelKey === row.model_key && hit.transport === 'encrypted';
    })());
    threw = null;
    try { accounts.resolveTarget('GLM-5.2-qoder@c1'); } catch (e) { threw = e; }
    check('product segment contradicting the alias -> 404', threw && threw.status === 404, threw && threw.message);
    check('short key keeps working with a product segment',
        accounts.resolveTarget('qfmodel-qodercn').account.alias === 'c1');

    const pinned = accounts.resolveTarget('qfmodel@c1');
    check('pinned alias selects that account', pinned.account.alias === 'c1' && pinned.product.id === 'qodercn');
    check('catalog key routes to encrypted', pinned.transport === 'encrypted');
    check('pinned name has exactly one candidate', accounts.candidateTargets('qfmodel@c1').length === 1);

    const generic = accounts.resolveTarget('qwen-flash@a1');
    check('generic name routes to public', generic.transport === 'public' && generic.model === null);

    threw = null;
    try { accounts.resolveTarget('qfmodel@zz'); } catch (e) { threw = e; }
    check('unknown alias -> 404', threw && threw.status === 404, threw && threw.message);

    threw = null;
    try { accounts.resolveTarget('nope-model'); } catch (e) { threw = e; }
    check('unknown model -> 404', threw && threw.status === 404, threw && threw.message);

    // Bare names prefer the free model and skip queued accounts.
    const bare = accounts.resolveTarget('qfmodel');
    check('bare name picks an account that knows it', bare.account.alias === 'a1', bare.account.alias);
    accounts.markRateLimited('a:uid-qoder', 'qfmodel', Date.now() + 60_000);
    const after = accounts.resolveTarget('qfmodel');
    check('bare name skips the queued account', after.account.alias === 'c1', after.account.alias);
    check('one cooldown covers both spellings of the model',
        accounts.resolveTarget('Qwen3.8-Flash').account.alias === 'c1');
    check('queue window never shortens', (() => {
        accounts.markRateLimited('a:uid-qoder', 'qfmodel', Date.now() + 1000);
        return accounts.limitedUntil(accounts.get('a1'), 'qfmodel') > Date.now() + 50_000;
    })());
    accounts.clearRateLimits('a1');
    check('clear-limit restores the account', accounts.limitedUntil(accounts.get('a1'), 'qfmodel') === 0);

    const disabled = accounts.update('c1', { enabled: false });
    check('disable then bare routing avoids it', disabled.enabled === false
        && accounts.resolveTarget('qfmodel').account.alias === 'a1');
    threw = null;
    try { accounts.resolveTarget('qfmodel@c1'); } catch (e) { threw = e; }
    check('pinned disabled account -> 403', threw && threw.status === 403);
    accounts.update('c1', { enabled: true });

    threw = null;
    try { accounts.update('a1', { alias: 'c1' }); } catch (e) { threw = e; }
    check('alias collision rejected', threw && threw.status === 409, threw && threw.message);

    // --- per-account model selection (the console's checkbox) ---------------
    const roster = accounts.accountModels('a1');
    check('roster lists the whole product catalog, all checked by default',
        roster.data.length === 17 + 2 && roster.data.every(m => m.enabled === true), roster.data.length);
    check('roster is per product line (CN has no public names)',
        accounts.accountModels('c1').data.length === 14);

    accounts.setModelsDisabled('a1', ['qfmodel', 'qwen-flash']);
    const afterOff = accounts.modelNameCatalog().map(m => m.id);
    check('unchecked catalog model leaves /v1/models for that account only',
        !afterOff.includes('Qwen3.8-Flash-qoder@a1')
        && afterOff.includes('Qwen3.8-Flash-qodercn@c1'), afterOff.length);
    check('unchecked public name leaves /v1/models too',
        !afterOff.includes('qwen-flash-qoder@a1') && afterOff.includes('qwen-plus-qoder@a1'));
    check('rows stay visible to the picker with enabled=false',
        accounts.accountModels('a1').data.some(m => m.key === 'qfmodel' && m.enabled === false));

    threw = null;
    try { accounts.resolveTarget('Qwen3.8-Flash@a1'); } catch (e) { threw = e; }
    check('pinned unchecked model -> 404 naming the console page',
        threw && threw.status === 404 && /账号和模型/.test(threw.message), threw && threw.message);
    check('short key is blocked by the same deny entry as the display name', (() => {
        try { accounts.resolveTarget('qfmodel@a1'); return false; } catch (e) { return e.status === 404; }
    })());
    check('bare name fails over to an account still offering it',
        accounts.resolveTarget('qfmodel').account.alias === 'c1');
    check('public name unchecked on the only account that has it -> 404', (() => {
        try { accounts.resolveTarget('qwen-flash@a1'); return false; } catch (e) { return e.status === 404; }
    })());
    check('unchecked count is what the pool reports as served',
        accounts.servedModelKeys(accounts.get('a1')).length === 19 - 2,
        accounts.servedModelKeys(accounts.get('a1')).length);

    threw = null;
    try { accounts.setModelsDisabled('a1', ['not-a-model']); } catch (e) { threw = e; }
    check('unknown catalog key rejected', threw && threw.status === 400, threw && threw.message);
    threw = null;
    try { accounts.setModelsDisabled('a1', 'qfmodel'); } catch (e) { threw = e; }
    check('non-array rejected instead of silently clearing', threw && threw.status === 400);
    check('the deny list survives a reload (it is on disk, not in memory)',
        accounts.get('a1').models_disabled.includes('qfmodel'));

    accounts.setModelsDisabled('a1', []);
    check('empty deny list is the deliberate "everything back on"',
        accounts.modelNameCatalog().map(m => m.id).includes('Qwen3.8-Flash-qoder@a1')
        && accounts.servedModelKeys(accounts.get('a1')).length === 19);

    process.env.QODER_ACCESS_TOKEN = 'env-token-abc';
    check('QODER_ACCESS_TOKEN joins the pool as read-only',
        accounts.list().some(a => a.alias === 'env' && a.transient === true));
    accounts.update('a1', { nickname: 'renamed' });
    check('a nickname addresses the account as well as the alias',
        accounts.resolveTarget('Qwen3.8-Flash@renamed').account.alias === 'a1');
    check('a hand-supplied token is never written to disk',
        !fs.readFileSync(products.accountsFile, 'utf8').includes('env-token-abc'));
    delete process.env.QODER_ACCESS_TOKEN;
}

async function testEnvelope() {
    console.log('\n[4] encrypted-endpoint envelope unwrapping');
    const chunk = delta => envelopeFrame({ choices: [{ index: 0, delta, finish_reason: null }] });
    const frames = [
        chunk({ role: 'assistant', content: '' }),
        'event: message\n\n',
        chunk({ content: 'Hel' }),
        envelopeFrame(null),                       // heartbeat: body null
        envelopeFrame(''),                         // heartbeat: empty string
        envelopeFrame('{}'),                      // heartbeat: empty object
        chunk({ content: 'lo' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"city":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
        envelopeFrame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } }),
        'data: [DONE]\n\n',
    ];
    const out = await unwrapChunks(frames);
    const chunks = out.filter(f => f.kind === 'chunk');
    // 6 real frames in, 3 heartbeats silently dropped, stream always terminated.
    check('heartbeats dropped', out.every(f => f.kind !== 'error') && chunks.length === 6, out.map(f => f.kind));
    check('[DONE] passed through once', out.filter(f => f.kind === 'done').length === 1);
    check('inner chunk is bare OpenAI JSON', JSON.parse(chunks[1].data).choices[0].delta.content === 'Hel');

    const collected = await envelope.collectCompletion((async function* () {
        for (let i = 0; i < frames.join('').length; i += 53) yield bytes(frames.join('').slice(i, i + 53));
    })(), 'qfmodel');
    check('non-stream aggregates text', collected.completion.choices[0].message.content === 'Hello', collected.completion.choices[0]);
    const calls = collected.completion.choices[0].message.tool_calls;
    check('tool call deltas merge', calls && calls.length === 1 && calls[0].function.name === 'get_weather'
        && JSON.parse(calls[0].function.arguments).city === 'Paris', calls);
    check('usage carried over', collected.completion.usage && collected.completion.usage.total_tokens === 8);

    const errFrames = await unwrapChunks([
        envelopeFrame({ code: '10605', message: '{"retryAfterSeconds":45} model is queued' }),
    ]);
    check('error frame classified', errFrames[0].kind === 'error' && errFrames[0].error.code === '10605', errFrames);
    check('code field survives unwrapping', errFrames[0].error.code === '10605', errFrames[0].error);
    check('message not polluted by code suffix', !String(errFrames[0].error.message).includes('(10605)'), errFrames[0].error.message);
    const wait = envelope.waitInfoOf(errFrames[0].error);
    check('queue code maps to the server-provided wait', wait && wait.retryAfterMs === 45_000, wait);
    check('prose wait parsed too', envelope.waitInfoOf({ code: '10605', message: 'please retry in 60s' }).retryAfterMs === 60_000);
    check('unrelated code is not a wait signal', envelope.waitInfoOf({ code: '400', message: 'bad request' }) === null);

    const onlyError = await envelope.collectCompletion((async function* () {
        yield bytes(envelopeFrame({ code: '110', message: 'quota exceeded' }));
        yield bytes('data: [DONE]\n\n');
    })(), 'dmodel');
    check('failure with no content reports the error', onlyError.error && onlyError.error.code === '110', onlyError);

    const plain = await unwrapChunks(['data:{"choices":[{"delta":{"content":"raw"}}]}\n\n', 'data: [DONE]\n\n']);
    check('non-envelope frames still pass through', JSON.parse(plain[0].data).choices[0].delta.content === 'raw');
}

async function testAsk() {
    console.log('\n[5] OpenAI request -> encrypted ask');
    const product = products.PRODUCTS.qodercn;
    const model = products.findModel('qodercn', 'dmodel');
    const body = {
        model: 'dmodel',
        messages: [
            { role: 'system', content: 'be terse' },
            { role: 'user', content: 'weather in Paris?' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', content: '{"temp":12}' },
            { role: 'user', content: [{ type: 'text', text: 'and tomorrow?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
        ],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
        max_tokens: 512,
        reasoning_effort: 'high',
    };
    const ask = encrypted.buildAsk(body, product, model);
    check('system turns collected', ask.systemText === 'be terse', ask.systemText);
    check('last user turn is the question', ask.userText === 'and tomorrow?', ask.userText);
    check('multimodal content kept as parts', Array.isArray(ask.history[ask.history.length - 1].content)
        && ask.history[ask.history.length - 1].content[1].type === 'image_url');
    check('assistant tool_calls preserved', ask.history.some(m => Array.isArray(m.tool_calls)));
    check('tool result id preserved', ask.history.some(m => m.tool_call_id === 'c1'));
    check('business routing field set', ask.business && ask.business.type === 'agent');
    check('session type follows product', ask.sessionType === 'qoder_work');
    check('catalog flags forwarded', ask.isReasoning === true && ask.displayName === 'DeepSeek-V4-Pro'
        && ask.maxInputTokens === 1_000_000);
    check('tools normalized', ask.tools[0].function.name === 'get_weather');
    check('effort passed when catalog allows it', ask.reasoningEffort === 'high');
    // Callers may type the display name; the field that goes upstream stays the key.
    const askByName = encrypted.buildAsk({ ...body, model: 'DeepSeek-V4-Pro' }, product,
        products.resolveModel('qodercn', 'DeepSeek-V4-Pro'));
    check('display name never reaches the upstream key field', askByName.modelKey === 'dmodel', askByName.modelKey);
    check('display name still fills the label', askByName.displayName === 'DeepSeek-V4-Pro', askByName.displayName);
    const flat = encrypted.buildAsk({ model: 'dmodel', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'f', description: '', parameters: {} }] }, product, model);
    check('flat tool shape accepted', flat.tools[0].function.name === 'f');
    check('empty messages still produce a question', flat.userText === 'hi' && flat.history.length === 1);
    check('max_tokens mapped', encrypted.buildAsk({ model: 'dmodel', messages: [], max_tokens: 9 }, product, model).maxTokens === 9);
}

async function testWasm() {
    console.log('\n[6] WASM request signing (offline)');
    const user = { uid: 'selftest-uid', securityOauthToken: 'selftest-token' };
    const fields = await wasm.generateRuntimeAuthFields(user);
    check('auth fields produced', typeof fields.encrypt_user_info === 'string' && fields.encrypt_user_info.length > 16
        && typeof fields.key === 'string' && fields.key.length > 16, Object.keys(fields || {}));

    const client = await wasm.EncryptedInfer.create({
        user,
        machineId: 'selftest-machine',
        metadata: { ...products.PRODUCTS.qodercn.clientMetadata },
        host: products.PRODUCTS.qodercn.encryptedApiBase,
    });
    const request = client.prepareInfer(encrypted.buildAsk(
        { model: 'dmodel', messages: [{ role: 'user', content: 'hello' }] },
        products.PRODUCTS.qodercn,
        products.findModel('qodercn', 'dmodel'),
    ));
    check('url targets the encrypted sse route', request.url.includes('gateway.qoder.com.cn')
        && request.url.includes('/algo/api/v2/service/pro/sse/agent_chat_generation') && request.url.includes('Encode=1'), request.url);
    const authHeader = request.headers.Authorization || request.headers.authorization;
    check('Authorization is a COSY signature', typeof authHeader === 'string' && authHeader.startsWith('Bearer COSY.'), authHeader && authHeader.slice(0, 40));
    check('catalog key header present', Object.entries(request.headers).some(([k, v]) => /model-key/i.test(k) || String(v).includes('dmodel')));
    check('body is opaque (encrypted)', typeof request.body === 'string' && request.body.length > 100
        && (() => { try { JSON.parse(request.body); return false; } catch { return true; } })());
}

function testLoginArgs() {
    console.log('\n[7] login / clear CLI');
    // Requiring the entry file is safe because its main() is guarded on
    // `require.main === module`; without that guard this import would open a
    // browser and start polling.
    const cli = require('../src/login');
    check('--product qodercn / cn / "Qoder CN" all resolve',
        cli.parseProduct('qodercn') === 'qodercn'
        && cli.parseProduct('cn') === 'qodercn'
        && cli.parseProduct('Qoder CN') === 'qodercn'
        && cli.parseProduct('QODER') === 'qoder', cli.parseProduct('Qoder CN'));
    // One login per run: asking for two lines is refused rather than quietly
    // collapsed into one, and the caller gets a "run it again" message.
    check('asking for both lines is refused, not expanded',
        cli.parseProduct('both') === null && cli.parseProduct('all') === null
        && cli.parseProduct('qoder,cn') === null
        && cli.asksForSeveral('qoder,cn') && cli.asksForSeveral('both')
        && !cli.asksForSeveral('nope'));
    // "qoder cn" is the CN display name, so the whole value wins over splitting.
    check('the display-name form is one product, not two',
        cli.parseProduct('qoder cn') === 'qodercn', cli.parseProduct('qoder cn'));
    check('a typo is rejected instead of silently logging into qoder',
        cli.parseProduct('nope') === null && cli.parseProduct('') === null
        && !cli.asksForSeveral('nope') && !cli.asksForSeveral(undefined));
    check('menu counts only real logins of that product line',
        cli.poolOf('qoder').every(a => a.product === 'qoder' && !a.transient)
        && cli.poolOf('qodercn').every(a => a.product === 'qodercn' && !a.transient));
    const menu = cli.menuText();
    check('numeric menu offers exactly the two product lines',
        menu.includes('1) ' + products.PRODUCTS.qoder.displayName)
        && menu.includes('2) ' + products.PRODUCTS.qodercn.displayName)
        && menu.includes('a1') && /尚未登录|已登录 \d+ 个：c1/.test(menu)
        && !menu.includes('3)'), menu);
    const rows = cli.menuRows();
    check('arrow menu rows are the two product lines, in pool order',
        rows.map(r => r.id).join() === 'qoder,qodercn'
        && rows.every(r => r.name && typeof r.status === 'string' && r.status.length), rows);
    check('arrow menu hint teaches the keys it actually binds',
        ['↑', '↓', '回车', 'Ctrl+C'].every(k => cli.MENU_HINT.includes(k))
        && !cli.MENU_HINT.includes('空格'), cli.MENU_HINT);
    check('without a raw-capable terminal the menu falls back to typing',
        cli.menuMode() === 'numeric', cli.menuMode());

    // `pnpm run clear` shares the login argument parsing, so check the clearing
    // path here too: what it selects, what it prints, and what it leaves behind.
    const cleaner = require('../src/clear');
    check('clear only selects real logins of the asked product line',
        cleaner.targets(null).every(a => !a.transient)
        && cleaner.targets('qoder').every(a => a.product === 'qoder')
        && cleaner.targets('qodercn').every(a => a.product === 'qodercn')
        && cleaner.targets(null).length >= 2, cleaner.targets(null).map(a => a.alias));
    // The plan is printed to a terminal on the way to deleting credentials, so it
    // must identify accounts without ever echoing the secrets being removed.
    const plan = cleaner.planText(accounts.list(), [], null);
    check('the clear plan names accounts but never prints a token',
        plan.includes('a1') && plan.includes('c1') && !plan.includes('token-')
        && !plan.includes('refresh-') && !plan.includes('env-token'), plan.slice(0, 200));
    fs.writeFileSync(process.env.QODER_PROXY_CRED_FILE, '{}');
    check('--legacy offers exactly the old files that still exist',
        cleaner.legacyTokenFiles().join() === [process.env.QODER_PROXY_CRED_FILE].join()
        && !cleaner.legacyTokenFiles().includes(`${process.env.QODER_PROXY_CRED_FILE}.migrated`),
        cleaner.legacyTokenFiles());
    fs.rmSync(process.env.QODER_PROXY_CRED_FILE, { force: true });

    // Removing one line must not take the other one with it, and clearing the
    // whole pool must leave an empty file behind (not a missing file, which is
    // what would let an old credential be imported again).
    const poolSnapshot = fs.readFileSync(products.accountsFile, 'utf8');
    cleaner.targets('qodercn').forEach(a => accounts.remove(a.id));
    check('clearing one product line leaves the other intact',
        accounts.list().filter(a => !a.transient).every(a => a.product === 'qoder')
        && accounts.list().some(a => a.alias === 'a1'), accounts.list().map(a => a.alias));
    fs.writeFileSync(products.accountsFile, poolSnapshot);
    accounts.removeAll();
    check('clearing the pool empties the file instead of deleting it',
        fs.existsSync(products.accountsFile) && accounts.list().filter(a => !a.transient).length === 0);
    fs.writeFileSync(products.accountsFile, poolSnapshot);
    // Same rule in the other direction: only a deliberate wipe is honoured, so
    // an empty write caused by a failed concurrent read cannot cost logins.
    accounts.saveAll([]);
    check('an accidental empty write cannot wipe the pool',
        accounts.list().filter(a => !a.transient).length === 2, accounts.list().map(a => a.alias));
    cleaner.targets(null).forEach(a => accounts.remove(a.id));
    check('deleting the last login on its own still empties the pool',
        fs.existsSync(products.accountsFile) && accounts.list().filter(a => !a.transient).length === 0);
    fs.writeFileSync(products.accountsFile, poolSnapshot);
    check('the pool survives a clear for the groups that follow',
        accounts.list().map(a => a.alias).join() === 'a1,c1', accounts.list().map(a => a.alias));
}

// The arrow menu is the only part of the CLI that needs a terminal, so drive it
// with an in-memory Readable that pretends to be one.
async function testArrowMenu() {
    console.log('\n[8] arrow-key menu (fake terminal)');
    const { Readable } = require('stream');
    const cli = require('../src/login');
    const rows = cli.menuRows();
    const realStdin = process.stdin;
    const realWrite = process.stdout.write;
    const realTty = process.stdout.isTTY;
    process.stdout.isTTY = true;
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const visible = text => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

    async function run(keys) {
        let screen = '';
        let raw = false;
        const stdin = new Readable({ read() { } });
        stdin.isTTY = true;
        stdin.setRawMode = mode => { raw = mode; };
        process.stdout.write = chunk => { screen += String(chunk); return true; };
        Object.defineProperty(process, 'stdin', { value: stdin, configurable: true, writable: true });
        try {
            const pending = cli.arrowSelect(rows);
            await tick();
            for (const seq of keys) {
                stdin.push(Buffer.from(seq));
                await tick();
            }
            return { screen, picked: await pending, raw };
        } finally {
            stdin.destroy();
            Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true, writable: true });
            process.stdout.write = realWrite;
        }
    }

    const plain = await run(['\r']);
    check('enter takes the highlighted line and releases raw mode',
        plain.picked === 'qoder' && plain.raw === false, plain.picked);
    check('both product lines are listed with their pool state',
        visible(plain.screen).includes(`❯ ${products.PRODUCTS.qoder.displayName}`)
        && visible(plain.screen).includes(products.PRODUCTS.qodercn.displayName)
        && rows.every(row => visible(plain.screen).includes(`${row.name}  ${row.status}`)), visible(plain.screen).slice(0, 300));

    const moved = await run(['\x1b[B', '\r']);
    check('down then enter picks the other product line',
        moved.picked === 'qodercn', moved.picked);
    check('the menu is repainted in place instead of printed over and over',
        /\x1b\[4A/.test(moved.screen)
        && (moved.screen.match(/选择要登录的产品线/g) || []).length === 2, '');
    check('the cursor is the only selection marker',
        !moved.screen.includes('[x]') && !visible(moved.screen).includes('空格'), '');

    const wrapped = await run(['\x1b[A', '\r']);
    check('up from the first row wraps to the last',
        wrapped.picked === 'qodercn', wrapped.picked);

    const quit = await run(['q']);
    check('q quits and returns nothing (caller exits without touching the pool)',
        quit.picked === null && quit.raw === false, quit.picked);
    process.stdout.isTTY = realTty;
}

// The demo console is plain client code, so the checks that matter are the ones
// that keep it standalone and safe: no external assets, relative endpoints only,
// the script still compiles, and model output passes through the escaper.
function testDemoPage() {
    console.log('\n[9] demo chat page (GET /)');
    const playground = require('../src/playground');
    const html = playground.pageHtml();
    check('page file is served, not inlined into JS',
        fs.existsSync(playground.PAGE_FILE) && html.startsWith('<!DOCTYPE html>')
        && html.includes('</html>'), playground.PAGE_FILE);
    const layers = playground.router.stack.filter(l => l.route);
    check('router exposes exactly GET /',
        layers.length === 1 && layers[0].route.path === '/'
        && layers[0].route.methods.get === true, layers.map(l => l.route.path));
    // Any absolute URL would mean the page needs the internet to render. The
    // illustrative origin in comments and the copy-the-endpoint labels are the
    // only places where 127.0.0.1 may appear, and they are never fetched.
    const absolute = (html.match(/https?:\/\/[^\s"'`);<]+/g) || [])
        .filter(u => !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u));
    check('no external asset or API host is referenced',
        absolute.length === 0 && !/<link[^>]+href/.test(html), absolute);
    check('talks to the /v1 direct-HTTP transport only',
        html.includes("'/v1/chat/completions'") && html.includes("'/v1/models'")
        && html.includes("'/health'") && !html.includes('/v0/'), '');
    const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    let compiles = true;
    try { new Function(script); } catch (e) { compiles = false; console.error('       ' + e.message); }
    check('the inline script compiles', compiles);
    check('model output is escaped before it becomes markup',
        /function plain\(text\)[\s\S]*?return esc\(text\)/.test(script)
        && /<pre><code>' \+ esc\(match\[2\]\)/.test(script), '');
    const sinks = script.match(/\.innerHTML = [^\n]+/g) || [];
    check('every innerHTML sink is escaper output or a fixed literal',
        sinks.length >= 4 && sinks.every(s => s.includes('rich(') || s.includes("''")
            || s.includes('<div class="banner">') || s.includes("'<option")), sinks);
    check('stream reader handles the [DONE] terminator and queue frames',
        script.includes("payload === '[DONE]'") && /json\.choices && json\.message/.test(script)
        && script.includes('text/event-stream'), '');
}

async function main() {
    console.log('qoder-proxy selftest (no network, temp account pool)');
    await testProducts();
    await testMigration();
    await testRouting();
    await testEnvelope();
    await testAsk();
    await testWasm();
    testLoginArgs();
    await testArrowMenu();
    testDemoPage();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (failures > 0) {
        console.error(`\n${failures} check(s) FAILED`);
        process.exit(1);
    }
    console.log('\nall checks passed');
}

main().catch(e => { console.error(e); process.exit(1); });
