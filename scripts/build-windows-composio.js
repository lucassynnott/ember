const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.join(root, '.windows-tools', 'composio-source');
const revision = 'dfb8f1dfbd991d821cf9250def70e911cb6c1cf8';
const output = path.join(root, 'native', 'windows', 'bin');
function run(binary, args, cwd = source, capture = false) {
  const result = spawnSync(binary, args, { cwd, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', windowsHide: true,
    shell: process.platform === 'win32' && binary === 'pnpm' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} failed (${result.status}): ${result.stderr || ''}`);
  return result.stdout?.trim();
}
fs.mkdirSync(path.dirname(source), { recursive: true });
if (!fs.existsSync(source)) run('git', ['clone', '--depth', '1', '--branch', '@composio/cli@0.4.2', 'https://github.com/ComposioHQ/composio.git', source], root);
if (run('git', ['rev-parse', 'HEAD'], source, true) !== revision) throw new Error('Unexpected Composio source revision.');
if (run('bun', ['--version'], source, true) !== '1.3.14') throw new Error('This build requires Bun 1.3.14.');
run('pnpm', ['install', '--frozen-lockfile', '--filter', '@composio/cli...']);
run('pnpm', ['--filter', '@composio/cli^...', 'run', 'build']);
fs.mkdirSync(output, { recursive: true });
run('bun', ['build', './src/bin.ts', '--env', 'DEBUG_OVERRIDE_*', '--define', '__COMPOSIO_CLI_RELEASE_VERSION__="0.4.2"', '--compile', '--production', '--target', 'bun-windows-x64', '--outfile', path.join(output, 'composio.exe')], path.join(source, 'ts', 'packages', 'cli'));
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'composio-LICENSE'));
fs.writeFileSync(path.join(output, 'composio-source.txt'), `Composio CLI 0.4.2\nhttps://github.com/ComposioHQ/composio/tree/${revision}\nCompiled by Ember with Bun 1.3.14 for Windows x64.\n`);
console.log('Windows Composio CLI built from pinned source.');
