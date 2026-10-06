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
const keyring = path.join(source, 'ts', 'packages', 'cli-keyring', 'src');
fs.copyFileSync(path.join(root, 'native', 'windows', 'composio-keyring', 'windows-dpapi.ts'), path.join(keyring, 'stores', 'windows-dpapi.ts'));
const keyringIndex = path.join(keyring, 'index.ts');
let indexText = fs.readFileSync(keyringIndex, 'utf8');
if (!indexText.includes("from './stores/windows-dpapi'")) {
  indexText = indexText.replace("import { UnsupportedPlatformStore }", "import { WindowsDpapiStore } from './stores/windows-dpapi';\nimport { UnsupportedPlatformStore }");
  indexText = indexText.replaceAll("    case 'linux':", "    case 'win32':\n      return new WindowsDpapiStore();\n    case 'linux':");
  fs.writeFileSync(keyringIndex, indexText);
}
const userContext = path.join(source, 'ts', 'packages', 'cli', 'src', 'services', 'user-context.ts');
let contextText = fs.readFileSync(userContext, 'utf8');
if (!contextText.includes('requireProtectedStorage: boolean')) {
  contextText = contextText.replace("import * as FileSystem", "import { NodeOs } from 'src/services/node-os';\nimport * as FileSystem");
  contextText = contextText.replace('  useLegacyStorage: boolean;', '  useLegacyStorage: boolean;\n  requireProtectedStorage: boolean;');
  contextText = contextText.replace("          if (err instanceof KeyringError && err.kind === 'NoStorageAccess') {", "          if (deps.requireProtectedStorage) return yield* Effect.die(new Error('Windows protected credential storage failed.'));\n          if (err instanceof KeyringError && err.kind === 'NoStorageAccess') {");
  contextText = contextText.replace('    const useLegacyStorage =\n      cliConfig', "    const requireProtectedStorage = (yield* NodeOs.pipe(Effect.provide(NodeOs.Default))).platform === 'win32';\n    const useLegacyStorage = !requireProtectedStorage && (\n      cliConfig");
  contextText = contextText.replace("cliConfig.data.security === 'json';", "cliConfig.data.security === 'json');");
  contextText = contextText.replace('const kDeps: KeyringDeps = { keyring, useLegacyStorage };', 'const kDeps: KeyringDeps = { keyring, useLegacyStorage, requireProtectedStorage };');
  fs.writeFileSync(userContext, contextText);
}
run('pnpm', ['install', '--frozen-lockfile', '--filter', '@composio/cli...']);
run('pnpm', ['--filter', '@composio/cli^...', 'run', 'build']);
fs.mkdirSync(output, { recursive: true });
run('bun', ['build', './src/bin.ts', '--env', 'DEBUG_OVERRIDE_*', '--define', '__COMPOSIO_CLI_RELEASE_VERSION__="0.4.2"', '--compile', '--production', '--target', 'bun-windows-x64', '--outfile', path.join(output, 'composio.exe')], path.join(source, 'ts', 'packages', 'cli'));
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'composio-LICENSE'));
fs.writeFileSync(path.join(output, 'composio-source.txt'), `Composio CLI 0.4.2\nhttps://github.com/ComposioHQ/composio/tree/${revision}\nCompiled by Ember with Bun 1.3.14 for Windows x64.\nEmber adaptations: Windows DPAPI credential backend and protected-storage defaults.\nAdapter source: https://github.com/lucassynnott/ember/tree/codex/windows-port/native/windows/composio-keyring\n`);
console.log('Windows Composio CLI built from pinned source.');
