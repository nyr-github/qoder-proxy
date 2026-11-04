// pnpm run clear — 清空账号池里落盘的所有令牌（`pnpm run login` 的反向操作）。
//
//   pnpm run clear                    交互确认后清空全部账号
//   pnpm run clear -- --yes           不询问，直接清（脚本 / CI 用）
//   pnpm run clear -- --product cn    只清一条产品线（qoder / qodercn / cn）
//   pnpm run clear -- --legacy        连老版本留下的 credentials.json(.migrated) 一起删
//   pnpm run clear -- --list          只看会清掉哪些，不动手
//
// 边界要说清楚：
//   · 本命令只删本机文件里存的令牌，远端授权不会因此失效，真要撤销得到 Qoder
//     账号页操作；
//   · 正在跑的代理按请求读池子，清完立刻生效，不用重启；
//   · 如果服务端还挂着一个没走完的设备码授权，浏览器里点“同意”会把账号重新
//     写回池子，清完先别点；
//   · 只靠 QODER_ACCESS_TOKEN 环境变量注入的那个只读条目不在文件里，本命令
//     碰不到，要清它得改环境变量。
const fs = require('fs');
const readline = require('readline');
const accounts = require('./accounts');
const products = require('./products');
const config = require('./config');
const { parseProduct, asksForSeveral } = require('./login');

function argValue(flag) {
    const index = process.argv.indexOf(flag);
    if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
    const inline = process.argv.find(a => a.startsWith(`${flag}=`));
    return inline ? inline.slice(flag.length + 1) : undefined;
}

function hasFlag(...names) {
    return names.some(name => process.argv.includes(name));
}

// Pool entries that still hold token material on disk. Transient ones come from
// QODER_ACCESS_TOKEN and are never persisted, so they are not ours to clear.
function targets(productId) {
    return accounts.list().filter(a => !a.transient && (!productId || a.product === productId));
}

// Old single-account releases kept the credential next to the pool and renamed
// it to `.migrated` after importing. Deleting those is irreversible, so they
// are only touched when the caller asks for --legacy.
function legacyTokenFiles() {
    return [config.credentialFile, `${config.credentialFile}.migrated`].filter(f => fs.existsSync(f));
}

// What the confirmation and the summary print. Deliberately built from the
// public view: an alias and a uid are fine to echo, a token is not.
function planText(list, files, productId) {
    const lines = [];
    lines.push(`将要清除的令牌（${productId ? products.PRODUCTS[productId].displayName : '全部产品线'}）：`);
    if (!list.length) lines.push('  · 账号池里没有匹配的登录');
    for (const a of list) {
        const product = products.PRODUCTS[a.product];
        const exp = a.expire_time ? new Date(a.expire_time).toLocaleString() : '未知';
        lines.push(`  · ${a.alias}  ${(product && product.displayName) || a.product}  ${a.nickname || '(未取到昵称)'}  uid=${a.uid || '缺失'}  到期=${exp}`);
    }
    for (const f of files) lines.push(`  · 老版本令牌文件：${f}`);
    lines.push(`令牌文件：${products.accountsFile}`);
    return lines.join('\n');
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function main() {
    const productIdRaw = argValue('--product') || argValue('--pkg');
    let productId = null;
    if (productIdRaw !== undefined) {
        productId = parseProduct(productIdRaw);
        if (!productId) {
            console.error(asksForSeveral(productIdRaw)
                ? `一次只能清一条产品线（${products.productIds().join(' / ')}），要清另一条请再跑一次 clear`
                : `unknown product "${productIdRaw}" — expected one of: ${products.productIds().join(', ')}, cn`);
            process.exit(1);
        }
    }
    const dryRun = hasFlag('--list', '-l');
    const includeLegacy = hasFlag('--legacy');
    const skipAsk = hasFlag('--yes', '-y');

    const doomed = targets(productId);
    const legacy = includeLegacy ? legacyTokenFiles() : [];
    const leftoverLegacy = includeLegacy ? [] : legacyTokenFiles();

    if (!doomed.length && !legacy.length) {
        console.log(productId
            ? `${products.PRODUCTS[productId].displayName} 的账号池本来就是空的。`
            : '账号池本来就是空的（没有需要清除的令牌）。');
        console.log('明细：pnpm run login -- --list');
        if (leftoverLegacy.length) {
            console.log(`注意：老版本的令牌文件还在，删掉 accounts.json 后它们会被当成登录导入回来：\n  ${leftoverLegacy.join('\n  ')}`);
            console.log('一起清掉：pnpm run clear -- --legacy');
        }
        process.exit(0);
    }

    console.log(planText(doomed, legacy, productId));
    if (dryRun) {
        console.log('\n--list 只看不删，账号池没有改动。');
        process.exit(0);
    }
    if (!skipAsk) {
        if (!process.stdin.isTTY) {
            console.error('\n非交互环境不会自动删令牌，确认要清请加 --yes');
            process.exit(1);
        }
        const answer = (await ask('\n输入 clear 确认删除，其它任意输入取消：')).trim().toLowerCase();
        if (answer !== 'clear') {
            console.log('已取消，账号池没有改动。');
            process.exit(130);
        }
    }

    // Whole pool -> one empty write; one product line -> drop just those ids.
    if (productId) doomed.forEach(a => accounts.remove(a.id));
    else accounts.removeAll();
    for (const f of legacy) {
        try { fs.rmSync(f, { force: true }); } catch (e) { console.error(`  删除 ${f} 失败：${e.message}`); }
    }

    const rest = targets(null);
    console.log(`\n已清除 ${doomed.length} 个账号的令牌${legacy.length ? `（含 ${legacy.length} 个老版本文件）` : ''}。`);
    console.log(rest.length
        ? `剩下的账号：${rest.map(a => `${a.alias}=${a.product}`).join(', ')}  明细：pnpm run login -- --list`
        : '账号池现在是空的，重新登录：pnpm run login');
    if (leftoverLegacy.length) {
        console.log(`注意：老版本的令牌文件还留着，删掉 accounts.json 后它们会被当成登录导入回来：\n  ${leftoverLegacy.join('\n  ')}`);
        console.log('一起清掉：pnpm run clear -- --legacy');
    }
    if (process.env.QODER_ACCESS_TOKEN) {
        console.log('注意：QODER_ACCESS_TOKEN 注入的只读条目不走文件，仍然可用（要清它请改环境变量）。');
    }
    console.log('正在跑的代理按请求读池子，无需重启；清除后调用会返回 401 直到重新登录。');
    process.exit(0);
}

// Guarded so the helpers above stay checkable without touching the real pool
// (see scripts/selftest.js group 7).
if (require.main === module) main();

module.exports = { targets, legacyTokenFiles, planText };
