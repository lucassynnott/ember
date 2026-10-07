const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

async function main() {
  assert.equal(process.platform, 'win32');
  const {app, safeStorage} = require('electron');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-delete-native-'));
  app.setPath('userData', profile); app.setPath('sessionData', profile); app.on('window-all-closed', () => {});
  await app.whenReady();
  const {WindowsDriveState} = require('../src/windows-drive-state');
  const {WindowsDriveStore} = require('../src/windows-drive-store');
  const {WindowsCloudFiles} = require('../src/windows-cloud-files');
  const {prepareDeletion, completeDeletion} = require('../src/windows-drive-delete');
  const {TRASH} = require('../src/windows-drive-store');
  const data = crypto.randomBytes(8 * 1024 * 1024 + 123), small = Buffer.from('Recoverable deletion bytes.');
  const cloud = await require('./windows-drive-cloud-fixture').cloudFixture({
    'delete.txt': data, 'refused.txt': small, 'dirty.txt': small, 'copy-lost.txt': small,
    'delete-lost.txt': small, 'changed.txt': small, 'cancelled.txt': small
  });
  const root = await fs.mkdtemp(path.join(os.homedir(), 'Ember Delete Acceptance - '));
  const state = new WindowsDriveState({directory: path.join(profile, 'windows-drive'), safeStorage}); await state.load();
  const store = await WindowsDriveStore.create(cloud.config), completed = [], requests = [], hydration = [], refusals = [];
  let mode = 'deny';
  const bridge = new WindowsCloudFiles({store, helper: path.resolve('native/windows/bin/meeting-notes-hotkey.exe'), onDelete: async request => {
    requests.push(request);
    if (mode === 'deny') throw Error('The test deliberately denies deletion.');
    if (mode === 'wait') await new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(Error('Disconnected')), {once: true}));
    await assert.rejects(async()=>{const writer=await fs.open(path.join(root,...request.local.split('/')),'r+');await writer.close();},'the pending native deletion must block competing writers');
    return prepareDeletion({...request, state, store});
  }});
  bridge.on('deletionError', error => refusals.push(error.stage));
  bridge.on('deleteCompleted', event => completed.push(event)); bridge.on('hydrationProgress', event => hydration.push(event));
  const wait = async (predicate, message) => {const deadline = Date.now() + 5000; while (!predicate()) {assert(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20));}};
  const mutations = method => cloud.requests.filter(request => method ? request.method === method : ['PUT', 'DELETE'].includes(request.method)).length;
  const create = async local => {
    const object = await store.stat(local); await bridge.create(local, object);
    await state.markMaterialized(local, {key: local, etag: object.etag, fileID: object.fileID || null, size: object.size});
    return object;
  };
  const finalize = async local => {
    await wait(() => completed.some(event => event.path === local), 'The native successful-deletion callback must arrive.');
    const event = completed.find(event => event.path === local), identity = JSON.parse(event.identity);
    assert.equal(identity.key, local);
    const entry = Object.values(state.snapshot().deletes).find(entry => entry.local === local); assert(entry);
    assert.equal(entry.phase, 'deleted'); assert.equal((await completeDeletion({id: entry.id, state, store, bridge})).resolved, true);
    assert.equal(state.snapshot().materialized[local], undefined); assert.equal(state.snapshot().deletes[entry.id], undefined);
    return entry;
  };
  try {
    await bridge.register(root, state.snapshot().identity);
    await create('refused.txt'); const initialMutations = mutations();
    await assert.rejects(fs.unlink(path.join(root, 'refused.txt')), 'A refused delete must fail the real filesystem operation.');
    assert.equal((await bridge.inspect('refused.txt')).exists, true); assert(cloud.objects.has('refused.txt'));
    assert.equal(mutations(), initialMutations); assert.equal(completed.length, 0); assert.equal(requests.length, 1, JSON.stringify({refusals}));

    mode = 'allow'; await create('delete.txt'); assert.equal((await bridge.inspect('delete.txt')).onDiskBytes, 0);
    await fs.unlink(path.join(root, 'delete.txt')); const deleted = await finalize('delete.txt');
    assert.equal(cloud.objects.has('delete.txt'), false); assert(deleted.trash.startsWith(TRASH));
    assert.deepEqual(cloud.objects.get(deleted.trash).data, data); assert.equal(hydration.length, 0, 'Deleting an unhydrated file must not download it into its placeholder.');

    await create('dirty.txt'); await bridge.pin('dirty.txt');
    const dirty = Buffer.from(small); Buffer.from('Edit').copy(dirty);
    const file = await fs.open(path.join(root, 'dirty.txt'), 'r+'); try {await file.write(dirty, 0, dirty.length, 0); await file.sync();} finally {await file.close();}
    const callsBeforeDirty = requests.length, mutationsBeforeDirty = mutations();
    await assert.rejects(fs.unlink(path.join(root, 'dirty.txt')), 'Unsynced local edits must prevent cloud deletion.');
    assert.equal(requests.length, callsBeforeDirty); assert.equal(mutations(), mutationsBeforeDirty);
    assert.deepEqual(await fs.readFile(path.join(root, 'dirty.txt')), dirty); assert.deepEqual(cloud.objects.get('dirty.txt').data, small);

    await create('copy-lost.txt'); cloud.loseNextCopyAcknowledgement();
    const copyPuts = mutations('PUT'); await assert.rejects(fs.unlink(path.join(root, 'copy-lost.txt')));
    assert.equal((await bridge.inspect('copy-lost.txt')).exists, true); assert(cloud.objects.has('copy-lost.txt'));
    assert.equal(mutations('PUT'), copyPuts + 1); const copyIntent = Object.values(state.snapshot().deletes).find(entry => entry.local === 'copy-lost.txt'); assert.equal(copyIntent.phase, 'copying');
    const firstTrash = cloud.objects.get(copyIntent.trash); assert.deepEqual(firstTrash.data, small);
    await fs.unlink(path.join(root, 'copy-lost.txt')); await finalize('copy-lost.txt');
    assert.equal(mutations('PUT'), copyPuts + 1, 'Retrying actual deletion must not replay the confirmed trash copy.'); assert.strictEqual(cloud.objects.get(copyIntent.trash), firstTrash);

    await create('delete-lost.txt'); cloud.loseNextDeleteAcknowledgement();
    await assert.rejects(fs.unlink(path.join(root, 'delete-lost.txt'))); assert.equal((await bridge.inspect('delete-lost.txt')).exists, true);
    assert.equal(cloud.objects.has('delete-lost.txt'), false); const deleteIntent = Object.values(state.snapshot().deletes).find(entry => entry.local === 'delete-lost.txt'); assert.equal(deleteIntent.phase, 'deleting');
    const afterLostDelete = mutations(); await fs.unlink(path.join(root, 'delete-lost.txt')); await finalize('delete-lost.txt');
    assert.equal(mutations(), afterLostDelete, 'A lost cloud delete acknowledgement must be confirmed without repeating cloud writes.'); assert.deepEqual(cloud.objects.get(deleteIntent.trash).data, small);

    await create('changed.txt'); cloud.put('changed.txt', Buffer.from('Different remote bytes.')); const beforeChanged = mutations();
    await assert.rejects(fs.unlink(path.join(root, 'changed.txt'))); assert.equal((await bridge.inspect('changed.txt')).exists, true);
    assert.deepEqual(cloud.objects.get('changed.txt').data, Buffer.from('Different remote bytes.')); assert.equal(mutations(), beforeChanged);
    await create('cancelled.txt'); mode = 'wait'; const beforeCancel = mutations();
    const cancelledFile = path.join(root, 'cancelled.txt'), cancelledDelete = assert.rejects(fs.unlink(cancelledFile));
    await wait(() => requests.some(request => request.local === 'cancelled.txt'), 'The actual delete must reach the provider before disconnect.');
    const disconnectStarted = Date.now(); await bridge.command('disconnect'); assert(Date.now() - disconnectStarted < 10000, 'Disconnect must release the blocked callback promptly.'); await cancelledDelete;
    assert.equal(mutations(), beforeCancel); assert.equal((await fs.stat(cancelledFile)).isFile(), true); assert(cloud.objects.has('cancelled.txt'));
    mode = 'allow'; await bridge.register(root, state.snapshot().identity); await fs.unlink(cancelledFile); await finalize('cancelled.txt');
    console.log(JSON.stringify({nativeDeletionAuthorizationVerified: true, nativeDeletionBlocksCompetingWritesVerified: true, nativeTrashBeforeLocalDeletionVerified: true,
      nativeDeletionWithoutPlaceholderHydrationVerified: true, nativeDirtyDeletionRefused: true, nativeChangedRevisionDeletionRefused: true,
      nativeLostCopyRecoveryVerified: true, nativeLostDeleteRecoveryVerified: true, nativeDeletionCompletionBindingVerified: true, nativeDeletionDisconnectCancellationVerified: true,
      actualDeletedFiles: completed.map(event => event.path)}));
  } finally {
    try {await bridge.unregister();} finally {await bridge.closeAndWait().catch(() => {}); store.close(); await cloud.close();}
    await fs.rm(root, {recursive: true, force: true}); await fs.rm(profile, {recursive: true, force: true});
  }
}
if (!process.versions.electron) {
  const {spawnSync} = require('node:child_process'), env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {env, stdio: 'inherit', timeout: 120000, windowsHide: true});
  if (result.error) throw result.error; process.exitCode = result.status ?? 1;
} else {
  main().then(() => require('electron').app.exit(0)).catch(error => {console.error(error); require('electron').app.exit(1);});
}
