// Silent install/uninstall acceptance in an isolated disposable Windows runner.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function exists(file) { try { await fs.stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function main() {
  assert.equal(process.platform, 'win32', 'installer acceptance requires Windows');
  const dist = path.resolve('dist');
  const setups = (await fs.readdir(dist)).filter(name => /^Ember-.*-windows-x64-setup\.exe$/.test(name));
  assert.equal(setups.length, 1, 'exactly one Windows x64 installer');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ember install acceptance '));
  const installed = path.join(temporary, 'Ember');
  let uninstalled = false;
  let replacementVerified = false;
  assert.ok(process.env.APPDATA,'Windows roaming profile is available');
  const profile = path.join(process.env.APPDATA,'Ember');
  const profileExisted = await exists(profile);
  const environment = {...process.env};
  let profileFixtureWritten = false;
  const settings = JSON.stringify({speakerName:'Windows replacement acceptance',notesDir:path.join(temporary,'notes')});
  const profileFile = path.join(profile,'settings.json');

  try {
    if (process.argv[2]) {
      assert.equal(await exists(profileFile),false,'replacement acceptance refuses to overwrite an existing profile');
      const previousDirectory = path.resolve(process.argv[2]);
      const previousSetups = (await fs.readdir(previousDirectory)).filter(name => /^Ember-.*-windows-x64-setup\.exe$/.test(name));
      assert.equal(previousSetups.length,1,'exactly one predecessor installer');
      await execFile(path.join(previousDirectory,previousSetups[0]),['/S',`/D=${installed}`],{timeout:180000,windowsHide:true,env:environment});
      assert.ok(await exists(path.join(installed,'Ember.exe')),'predecessor installed');
      const before = crypto.createHash('sha256').update(await fs.readFile(path.join(installed,'resources','app.asar'))).digest('hex');
      await fs.mkdir(profile,{recursive:true});await fs.writeFile(profileFile,settings,{flag:'wx'});profileFixtureWritten=true;
      await execFile(path.join(dist,setups[0]),['/S',`/D=${installed}`],{timeout:180000,windowsHide:true,env:environment});
      const after = crypto.createHash('sha256').update(await fs.readFile(path.join(installed,'resources','app.asar'))).digest('hex');
      const expected = crypto.createHash('sha256').update(await fs.readFile(path.join(dist,'win-unpacked','resources','app.asar'))).digest('hex');
      assert.notEqual(before,after,'replacement must actually change application contents');
      assert.equal(after,expected,'replacement installs the current application archive');
      assert.equal(await fs.readFile(profileFile,'utf8'),settings,'installer replacement preserves profile bytes');
      replacementVerified = true;
    } else await execFile(path.join(dist, setups[0]), ['/S', `/D=${installed}`], { timeout: 180000, windowsHide: true,env:environment });
    assert.ok(await exists(path.join(installed, 'Ember.exe')), 'installer wrote application');
    await execFile(process.execPath, [path.resolve('scripts/test-windows-package.js'), installed], { timeout: 60000, windowsHide: true });
    await execFile(process.execPath,[path.resolve('scripts/test-windows-app-startup.js'),path.join(installed,'Ember.exe')],{timeout:180000,windowsHide:true,env:{...environment,EMBER_STARTUP_EVIDENCE:path.join(dist,'windows-installed-startup-evidence')}});
    const uninstallers = (await fs.readdir(installed)).filter(name => /^Uninstall.*\.exe$/i.test(name));
    assert.equal(uninstallers.length, 1, 'uninstaller present');
    await execFile(path.join(installed, uninstallers[0]), ['/S'], { timeout: 60000, windowsHide: true,env:environment });
    // NSIS may hand off to a temporary uninstaller and return before deletion.
    const deadline = Date.now() + 60000;
    while (await exists(path.join(installed, 'Ember.exe'))) {
      assert.ok(Date.now() < deadline, 'uninstaller removed application executable');
      await delay(250);
    }
    if(replacementVerified)assert.equal(await fs.readFile(profileFile,'utf8'),settings,'uninstall preserves profile bytes');
    uninstalled = true;
    console.log(JSON.stringify({windowsInstaller:'passed', installation:'passed', packagedRuntime:'passed', installedFirstRun:'passed', installationPathWithSpaces:true, uninstall:'passed',distinctBuildReplacement:replacementVerified,profileBytesPreserved:replacementVerified}));
  } finally {
    if(profileFixtureWritten && await fs.readFile(profileFile,'utf8').catch(()=>null)===settings) {
      await fs.rm(profileFile);
      if(!profileExisted)await fs.rmdir(profile).catch(()=>{});
    }
    if (uninstalled) await fs.rm(temporary, {recursive:true, force:true, maxRetries:10, retryDelay:300});
    else console.error(`Installer failure artifacts retained at ${temporary}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
