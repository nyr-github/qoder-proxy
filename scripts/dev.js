// pnpm run dev — 开发模式，两个作用：
//   1. 端口与正式实例错开（正式 8787，开发默认 8788），两者可以同时跑，
//      改代码不会把在用的服务踢掉；
//   2. 配合 `node --watch`，改动 src/*.js 等已加载的模块会自动重启进程。
//
// public/index.html 不在这个模块依赖图里，所以它不需要重启：src/playground.js
// 按文件 mtime 重新读取，浏览器刷新一下就生效。
//
// 端口优先级：命令行/环境变量 PORT > QODER_DEV_PORT > 8788。
if (!process.env.PORT) process.env.PORT = process.env.QODER_DEV_PORT || '8788';
console.log(`[dev] 监听端口 ${process.env.PORT}（正式实例默认 8787，可并存；Ctrl+C 停止）`);
require('../src/index.js');
