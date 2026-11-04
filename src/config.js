const path = require('path');
const os = require('os');
const fs = require('fs');

// Product presets (endpoints, client ids, model catalogs) live in products.js:
// the pool serves both product lines at once, so nothing here may depend on a
// single "current" product.
function findCli() {
  if (process.env.QODER_CLI_PATH) return process.env.QODER_CLI_PATH;

  const home = os.homedir();
  const isWin = process.platform === 'win32';
  // Windows ships .exe; on Linux/macOS the binaries are extension-less.
  const exe = name => (isWin ? `${name}.exe` : name);

  const candidates = [
    path.join(home, '.qoder/bin/qodercli', exe('qodercli')),
    path.join(home, '.qoderwake/bin/qodercli', exe('qodercli-wake')),
    path.join(home, '.qoderwake-cn/bin/qodercli', exe('qodercli-cn-wake')),
  ];

  // Common system-wide install locations (non-Windows).
  if (!isWin) {
    candidates.push('/usr/local/bin/qodercli', '/usr/bin/qodercli', path.join(home, '.local/bin/qodercli'));
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall back to PATH lookup (node resolves the bare name per platform).
  return 'qodercli';
}

module.exports = {
  cliPath: findCli(),
  port: parseInt(process.env.PORT || '8787', 10),
  host: process.env.HOST || '127.0.0.1',
  userAgent: 'qoder/1.0.0',
  // Where the pre-multi-account release stored its single credential; the pool
  // migrates it into accounts.json on first load and leaves the file as .migrated.
  credentialFile: process.env.QODER_PROXY_CRED_FILE
    || path.join(os.homedir(), '.qoder-proxy', 'credentials.json'),
  machineIdFile: process.env.QODER_PROXY_MACHINE_ID_FILE
    || path.join(os.homedir(), '.qoder-proxy', 'machine_id'),
  // Generic model names accepted by the public endpoint (it has no list API and
  // rejects the client catalog keys like `qfmodel`).
  v2Models: (process.env.QODER_V2_MODELS || 'qwen-flash,qwen-plus')
    .split(',').map(s => s.trim()).filter(Boolean),
};
