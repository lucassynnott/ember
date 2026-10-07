const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
async function main() {
  assert.equal(process.platform, 'win32'); const {app, safeStorage} = require('electron');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-remote-native-'));
  app.setPath('userData', profile);app.setPath('sessionData', profile);app.on('window-all-closed', () => {});await app.whenReady();
  const {WindowsDriveState} = require('../src/windows-drive-state'), {WindowsDriveStore} = require('../src/windows-drive-store'), {WindowsCloudFiles} = require('../src/windows-cloud-files');
  const {prepareRemoteRemoval, recoverRemoteRemoval, verifyRemoteRemovalCopy} = require('../src/windows-drive-remote-removal');
  const bytes = crypto.randomBytes(1024 * 1024 + 71), cloud = await require('./windows-drive-cloud-fixture').cloudFixture({'cached.bin': bytes, 'lost.bin': bytes, 'empty-cache.bin': bytes});
  const root = await fs.mkdtemp(path.join(os.homedir(), 'Ember Remote Removal - '));
  const state = new WindowsDriveState({directory: path.join(profile, 'windows-drive'), safeStorage});await state.load();await state.configure(cloud.config);
  const store = await WindowsDriveStore.create(cloud.config);let ordinaryDeletes = 0;
  const bridge = new WindowsCloudFiles({store, helper: path.resolve('native/windows/bin/meeting-notes-hotkey.exe'), onDelete: async () => {ordinaryDeletes++;throw Error('Remote removal must not invoke cloud-trash deletion.');}});
  try {
    await bridge.register(root, state.snapshot().identity);
    for (const local of ['cached.bin', 'lost.bin', 'empty-cache.bin']) {
      const object = await store.stat(local), previous = {key: local, etag: object.etag, fileID: object.fileID || null, size: object.size};
      await bridge.create(local, object);await state.markMaterialized(local, previous);
      if (local !== 'empty-cache.bin') {await bridge.pin(local);assert.deepEqual(await fs.readFile(path.join(root, local)), bytes);}
      cloud.objects.delete(local);
      const baselineWrites = cloud.writes, reads = cloud.requests.filter(r => r.range).length;
      const args = {local, previous, root, state, store, bridge};const prepared = await prepareRemoteRemoval(args);assert(prepared.readyForNativeRemoval);
      if (local === 'lost.bin') {
        const original = bridge.removeRemote.bind(bridge);bridge.removeRemote = async (...args) => {await original(...args);throw Error('Injected lost native reply');};
        await assert.rejects(recoverRemoteRemoval({...args, id: prepared.id, finish: true}), /Injected lost native reply/);bridge.removeRemote = original;
        assert.equal(state.snapshot().remoteRemovals[prepared.id].phase, 'removing');
        const reopened = new WindowsDriveState({directory: state.directory, safeStorage});await reopened.load();
        assert((await recoverRemoteRemoval({...args, state: reopened, id: prepared.id})).resolved);
        // Restore the same durable view for subsequent test files.
        await state.load();
      } else assert((await recoverRemoteRemoval({...args, id: prepared.id, finish: true})).resolved);
      assert.equal((await bridge.inspect(local)).exists, false);assert.equal(state.snapshot().materialized[local], undefined);
      const entry = state.snapshot().remoteRemovals[prepared.id];assert.equal(entry.phase, 'removed');
      if (local !== 'empty-cache.bin') {await verifyRemoteRemovalCopy({entry, state});assert.deepEqual(await fs.readFile(entry.copy.file), bytes);}
      assert.equal(cloud.writes, baselineWrites);assert.equal(cloud.requests.filter(r => r.range).length, reads);
    }
    await bridge.command('disconnect');cloud.put('background.bin', bytes);
    const {WindowsDriveRuntime} = require('../src/windows-drive-runtime');
    const runtime = new WindowsDriveRuntime({state, root, platform: 'win32', syncEnabled: false, storeFactory: async () => store, bridgeFactory: () => bridge});
    await runtime.start();await bridge.pin('background.bin');assert.deepEqual(await fs.readFile(path.join(root, 'background.bin')), bytes);
    cloud.objects.delete('background.bin');const writes = cloud.writes, reads = cloud.requests.filter(r => r.range).length;
    await runtime.refresh();assert.equal((await bridge.inspect('background.bin')).exists, false);assert(!runtime.status.conflicts.some(c => c.path === 'background.bin'));
    const background = Object.values(state.snapshot().remoteRemovals).find(entry => entry.local === 'background.bin');
    assert.equal(background.phase, 'removed');await verifyRemoteRemovalCopy({entry: background, state});assert.deepEqual(await fs.readFile(background.copy.file), bytes);
    assert.equal(cloud.writes, writes);assert.equal(cloud.requests.filter(r => r.range).length, reads);
    cloud.put('folder/', Buffer.alloc(0));cloud.put('folder/child.bin', bytes);await runtime.refresh();await bridge.pin('folder/child.bin');
    assert.deepEqual(await fs.readFile(path.join(root, 'folder', 'child.bin')), bytes);cloud.objects.delete('folder/');cloud.objects.delete('folder/child.bin');
    const folderWrites = cloud.writes, folderReads = cloud.requests.filter(r => r.range).length;await runtime.refresh();
    assert.equal((await bridge.inspect('folder')).exists, false);assert(!state.snapshot().materialized.folder);assert(!state.snapshot().materialized['folder/child.bin']);
    const child = Object.values(state.snapshot().remoteRemovals).find(entry => entry.local === 'folder/child.bin'), removedFolder = Object.values(state.snapshot().remoteRemovals).find(entry => entry.local === 'folder');
    assert.equal(child.phase, 'removed');assert.equal(removedFolder.phase, 'removed');assert(removedFolder.completed >= child.completed);await verifyRemoteRemovalCopy({entry: child, state});assert.deepEqual(await fs.readFile(child.copy.file), bytes);
    assert.equal(cloud.writes, folderWrites);assert.equal(cloud.requests.filter(r => r.range).length, folderReads);assert.equal(ordinaryDeletes, 0);
    const proof = {nativeRemoteCachedRemoval: true, nativeRemoteUnhydratedRemoval: true, nativeRemoteLostReplyRestart: true, automaticRuntimeRemoteReconciliation: true, nativeRemoteFolderChildFirst: true, retainedCachedBytesVerified: true, noCloudWrites: true, noHydration: true, ordinaryDeleteAuthorizationNotBypassed: true};
    await fs.mkdir('dist/windows-drive-remote-evidence', {recursive: true});await fs.writeFile('dist/windows-drive-remote-evidence/result.json', JSON.stringify(proof, null, 2));console.log(JSON.stringify(proof));
  } finally {try {await bridge.unregister();} finally {await bridge.closeAndWait().catch(() => {});store.close();await cloud.close();}await fs.rm(root, {recursive: true, force: true});await fs.rm(profile, {recursive: true, force: true});}
}
if (process.versions.electron) main().then(() => require('electron').app.exit(0)).catch(e => {console.error(e);require('electron').app.exit(1);});
else {const {spawnSync} = require('node:child_process'), env = {...process.env};delete env.ELECTRON_RUN_AS_NODE;const result = spawnSync(require('electron'), [__filename], {env, stdio: 'inherit', timeout: 180000, windowsHide: true});if (result.error) throw result.error;process.exitCode = result.status ?? 1;}
