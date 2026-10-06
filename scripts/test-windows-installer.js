// Silent install/uninstall acceptance in an isolated disposable Windows runner.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(file) { try { await fs.stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function main() {
  assert.equal(process.platform, 'win32', 'installer acceptance requires Windows');
  const dist = path.resolve('dist');
  const setups = (await fs.readdir(dist)).filter(name => /^Ember-.*-windows-x64-setup\.exe$/.test(name));
  assert.equal(setups.length, 1, 'exactly one Windows x64 installer');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-install-acceptance-'));
  const installed = path.join(temporary, 'Ember');
  let uninstalled = false;
  try {
    await execFile(path.join(dist, setups[0]), ['/S', `/D=${installed}`], { timeout: 180000, windowsHide: true });
    assert.ok(await exists(path.join(installed, 'Ember.exe')), 'installer wrote application');
    await execFile(process.execPath, [path.resolve('scripts/test-windows-package.js'), installed], { timeout: 60000, windowsHide: true });
    const uninstallers = (await fs.readdir(installed)).filter(name => /^Uninstall.*\.exe$/i.test(name));
    assert.equal(uninstallers.length, 1, 'uninstaller present');
    await execFile(path.join(installed, uninstallers[0]), ['/S'], { timeout: 60000, windowsHide: true });
    // NSIS may hand off to a temporary uninstaller and return before deletion.
    const deadline = Date.now() + 60000;
    while (await exists(path.join(installed, 'Ember.exe'))) {
      assert.ok(Date.now() < deadline, 'uninstaller removed application executable');
      await delay(250);
    }
    uninstalled = true;
    console.log(JSON.stringify({windowsInstaller:'passed', installation:'passed', packagedRuntime:'passed', uninstall:'passed'}));
  } finally {
    if (uninstalled) await fs.rm(temporary, {recursive:true, force:true, maxRetries:10, retryDelay:300});
    else console.error(`Installer failure artifacts retained at ${temporary}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
