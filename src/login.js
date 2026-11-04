// pnpm run login — command-line device-flow login for the /v1 transport.
// Works without the proxy server running: prints the authorization link,
// opens the system browser (unless --no-browser), waits for the poll to
// complete, and stores the credential in ~/.qoder-proxy/accounts.json.
//
// Pool rules, in the order the code applies them:
//   - same product line + same uid  -> the existing entry is OVERWRITTEN
//     (fresh tokens, same alias), so re-logging in never piles up duplicates;
//   - a different person, or the other product line -> a new alias (a2 / c1 ...);
//   - one run authorises exactly one product line — run `login` again for the
//     other one, so each browser round-trip stands on its own.
//
// A running proxy reads the pool per request, so no restart is needed.
const readline = require('readline');
const auth = require('./qoder-auth');
const accounts = require('./accounts');
const products = require('./products');

// Typed-menu keys, in menuRows() order.
const MENU = [
    { key: '1', id: 'qoder' },
    { key: '2', id: 'qodercn' },
];

function argValue(flag) {
    const index = process.argv.indexOf(flag);
    if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
    const inline = process.argv.find(a => a.startsWith(`${flag}=`));
    return inline ? inline.slice(flag.length + 1) : undefined;
}

// `--product` takes exactly one product line and accepts the documented
// spellings (qoder / qodercn / cn / "Qoder CN"), which is why a value with a
// space is resolved whole rather than split. Anything naming more than one line
// (`both`, `all`, a comma pair) is refused instead of silently becoming one.
function parseProduct(raw) {
    const value = String(raw === undefined ? '' : raw).trim();
    if (!value || /both|all|,/i.test(value)) return null;
    const product = products.resolveProduct(value);
    return product ? product.id : null;
}

// Distinguishes "you asked for two lines" from "that product does not exist",
// so the error can say which mistake was made.
function asksForSeveral(raw) {
    return /both|all|,/i.test(String(raw === undefined ? '' : raw));
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function poolOf(productId) {
    return accounts.list().filter(a => !a.transient && a.product === productId);
}

function listPool() {
    const pool = accounts.list();
    if (!pool.length) {
        console.log('账号池为空，先跑 `pnpm run login`。');
        return;
    }
    console.log(`账号池（${products.accountsFile}）：`);
    for (const a of pool) {
        const product = products.PRODUCTS[a.product];
        const exp = a.expire_time ? new Date(a.expire_time).toLocaleString() : 'unknown';
        console.log(`  ${a.alias}  ${(product && product.displayName) || a.product}  ${a.nickname || '(未取到昵称)'}  uid=${a.uid || '缺失'}  到期=${exp}${a.transient ? '  [来自 QODER_ACCESS_TOKEN，只读]' : ''}`);
    }
}

// Menu rows come from pure functions, so the interactive path stays checkable
// without a real terminal (see scripts/selftest.js group 7).
function menuRows() {
    const describe = id => {
        const product = products.PRODUCTS[id];
        const list = poolOf(id);
        return {
            id,
            name: product.displayName,
            status: list.length
                ? `已登录 ${list.length} 个：${list.map(a => a.alias + (a.nickname ? `(${a.nickname})` : '')).join(', ')}`
                : '尚未登录',
        };
    };
    return [describe('qoder'), describe('qodercn')];
}

function menuHeader() {
    const all = [...poolOf('qoder'), ...poolOf('qodercn')];
    return `选择要登录的产品线（当前账号池：${all.map(a => a.alias).join(', ') || '空'}）`;
}

const MENU_HINT = '↑/↓ 选择，回车 确认，Ctrl+C 退出';

// `1) 2)` text, for terminals that cannot do the arrow-key menu (piped input is
// handled earlier, this is for TERM=dumb / QODER_LOGIN_MENU=numeric).
function menuText() {
    return [
        menuHeader(),
        ...menuRows().map((row, index) => `  ${index + 1}) ${row.name}  ${row.status}`),
    ].join('\n');
}

// Raw-mode single-choice menu: the cursor is the selection, enter takes it, and
// cancelling resolves null (the caller then exits without touching the pool).
function arrowSelect(rows) {
    return new Promise(resolve => {
        let cursor = 0;
        let painted = 0;

        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);

        const paint = () => {
            const lines = [
                menuHeader(),
                ...rows.map((row, index) => index === cursor
                    ? `\x1b[36m❯\x1b[0m ${row.name}  ${row.status}`
                    : `  \x1b[90m${row.name}  ${row.status}\x1b[0m`),
                `\x1b[90m${MENU_HINT}\x1b[0m`,
            ];
            if (painted) process.stdout.write(`\x1b[${painted}A`);
            process.stdout.write('\x1b[J' + lines.map(line => `${line}\n`).join(''));
            painted = lines.length;
        };

        const finish = picked => {
            process.stdin.removeListener('keypress', onKey);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve(picked);
        };

        function onKey(str, key) {
            const name = key && key.name;
            if (name === 'c' && key.ctrl) return finish(null);
            if (name === 'escape' || name === 'q') return finish(null);
            if (name === 'up' || name === 'k') cursor = (cursor + rows.length - 1) % rows.length;
            else if (name === 'down' || name === 'j') cursor = (cursor + 1) % rows.length;
            else if (name === 'return' || name === 'enter') {
                process.stdout.write('\n');
                return finish(rows[cursor].id);
            }
            paint();
        }

        paint();
        process.stdin.on('keypress', onKey);
        process.stdin.resume();
    });
}

// Arrow keys need a real terminal that speaks ANSI; `QODER_LOGIN_MENU=numeric`
// forces the typed menu for consoles that render the escape codes as garbage.
function menuMode() {
    const rawCapable = Boolean(process.stdin.isTTY && process.stdout.isTTY && process.stdin.setRawMode);
    const forced = String(process.env.QODER_LOGIN_MENU || '').toLowerCase();
    if (forced === 'numeric') return 'numeric';
    // Asking for the arrow menu cannot invent a terminal that has no raw mode.
    if (forced === 'arrow') return rawCapable ? 'arrow' : 'numeric';
    if (!rawCapable) return 'numeric';
    return process.env.TERM === 'dumb' ? 'numeric' : 'arrow';
}

// Interactive picker — only when nobody passed --product and stdin is a real
// terminal. Piped/CI runs keep the old non-interactive default (qoder).
async function chooseProduct() {
    if (menuMode() === 'numeric') {
        console.log(`\n${menuText()}\n`);
        const answer = (await ask('\n输入 1 / 2 [1]: ')).trim();
        const picked = MENU.find(m => m.key === answer) || MENU[0];
        return picked.id;
    }
    console.log('');
    const picked = await arrowSelect(menuRows());
    if (!picked) {
        console.log('已取消，没有发起任何授权流程。');
        process.exit(130);
    }
    return picked;
}

function announce(productId) {
    const product = products.PRODUCTS[productId];
    const sameProduct = poolOf(productId);
    if (!sameProduct.length) {
        console.log(`\n即将登录「${product.displayName}」，账号池新增一个别名 ${product.tag}1。`);
        return;
    }
    console.log(`\n「${product.displayName}」已有 ${sameProduct.length} 个账号：${sameProduct.map(a => a.alias).join(', ')}。`);
    console.log('  · 授权的是同一个账号 → 覆盖它的令牌，别名不变（不会多出条目）；');
    console.log('  · 授权的是另一个账号 → 新增一个别名（换号登录）。');
    console.log('  只想续期的话不用重新登录：POST /v1/accounts/<别名>/refresh');
}

function report(account, product) {
    const exp = account.expire_time ? new Date(account.expire_time).toLocaleString() : 'unknown';
    const catalog = products.catalogFor(product.id);
    console.log(`\nLogged in as ${account.alias}${account.nickname ? `: ${account.nickname}` : ''}${account.uid ? ` (uid: ${account.uid})` : ''}`);
    console.log(`  product              : ${product.displayName}`);
    console.log(`  access token expires : ${exp}`);
    console.log(`  refreshable          : ${account.refresh_token ? 'yes (auto-renews on expiry)' : 'NO — re-login will be required'}`);
    console.log(`  model names          : ${catalog.slice(0, 3).map(m => `${m.key}@${account.alias}`).join(', ')} … (${catalog.length} in catalog)`);
    console.log(`  credentials saved to : ${products.accountsFile}`);
}

async function runLogin(productId, { open }) {
    const product = products.PRODUCTS[productId];
    announce(productId);
    const { loginUrl } = auth.startLogin({ product: productId, open });
    console.log(`\nQoder login (device flow) — ${product.displayName}\n`);
    console.log(open
        ? 'Browser should have opened. If not, visit this link manually:\n'
        : 'Open this link in your browser and authorize:\n');
    console.log(`  ${loginUrl}\n`);
    process.stdout.write('Waiting for authorization (times out after 5 minutes)');
    const spinner = setInterval(() => process.stdout.write('.'), 1000);
    try {
        const account = await auth.waitForLogin(productId);
        clearInterval(spinner);
        process.stdout.write('\n');
        report(account, product);
        return true;
    } catch (e) {
        clearInterval(spinner);
        process.stdout.write('\n');
        console.error(`Login failed for ${product.displayName}: ${e.message}`);
        return false;
    }
}

async function main() {
    if (process.argv.includes('--list') || process.argv.includes('-l')) {
        listPool();
        process.exit(0);
    }
    const noBrowser = process.argv.includes('--no-browser') || process.argv.includes('--url-only');
    const raw = argValue('--product') || argValue('--pkg') || process.env.QODER_PRODUCT;
    let productId;
    if (raw !== undefined) {
        productId = parseProduct(raw);
        if (!productId) {
            console.error(asksForSeveral(raw)
                ? `一次只登一条产品线（${products.productIds().join(' / ')}），要登另一条请再跑一次 login`
                : `unknown product "${raw}" — expected one of: ${products.productIds().join(', ')}, cn`);
            process.exit(1);
        }
    } else if (process.stdin.isTTY) {
        productId = await chooseProduct();
    } else {
        productId = 'qoder';
    }

    if (!await runLogin(productId, { open: !noBrowser })) process.exit(1);
    const pool = accounts.list().filter(a => !a.transient);
    console.log(`\n账号池：${pool.map(a => `${a.alias}=${a.product}${a.nickname ? `(${a.nickname})` : ''}`).join(', ') || '空'}`);
    console.log('明细：pnpm run login -- --list');
    console.log('想登另一条产品线：再跑一次 pnpm run login（会新增一个别名）');
    console.log(`试试：curl http://127.0.0.1:8787/v1/models  （或 GET /v1/accounts 查看账号池）`);
    process.exit(0);
}

// Guarded so the argument helpers stay testable without launching a browser
// flow (`scripts/selftest.js` requires this file).
if (require.main === module) main();

module.exports = { parseProduct, asksForSeveral, poolOf, listPool, menuText, menuRows, menuHeader, menuMode, MENU_HINT, arrowSelect };
