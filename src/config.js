const path = require('path');
const os = require('os');
const fs = require('fs');

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
};
