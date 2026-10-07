const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const {WindowsDriveState} = require('../src/windows-drive-state');
const {prepareRemoteRemoval, verifyRemoteRemovalCopy, recoverRemoteRemoval, reconcileRemoteRemovals} = require('../src/windows-drive-remote-removal');
async function fixture({reappeared = false, cachedBytes = 4} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-remote-copy-'));
  const state = new WindowsDriveState({directory, safeStorage: {isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString()}});
  await state.load(); await state.configure({provider: 's3', bucketName: 'test', keyID: 'test', applicationKey: 'test'});
  const previous = {key: 'a.txt', etag: 'old', fileID: 'v1', size: 4}; await state.markMaterialized('a.txt', previous);
  let checks = 0, unlocked = 0, captures = 0;
  const bridge = {inspect: async () => ({exists:true}), fingerprintPinned:async()=>({size:4,hash:crypto.createHash('sha256').update('Data').digest('hex')}), lockRemoteRemoval: async () => ({token: 'owned', cloud: true, identity: JSON.stringify(previous), size: 4, inSync: true, modifiedBytes: 0, onDiskBytes: cachedBytes}),
    capturePinnedCurrent: async (token, args) => {assert.equal(token, 'owned');captures++; await fs.writeFile(args.backup, 'Data', {flag: 'wx'});return {size: 4, hash: crypto.createHash('sha256').update('Data').digest('hex')};},
    unlockUpload: async token => {assert.equal(token, 'owned');unlocked++;}};
  const store = {stat: async () => {checks++;return reappeared && checks > 1 ? previous : null;}};
  return {state, args: {local: 'a.txt', previous, root: 'C:\\Drive', state, store, bridge}, counts: () => ({checks, unlocked, captures}), close: () => fs.rm(directory, {recursive: true, force: true})};
}
test('remote preparation saves and independently verifies real cached bytes without deleting or hydrating', async () => {
  const f = await fixture(); try {
    const result = await prepareRemoteRemoval(f.args); assert.equal(result.readyForNativeRemoval, true);
    assert.deepEqual(f.counts(), {checks: 2, unlocked: 1, captures: 1});
    const entry = f.state.snapshot().remoteRemovals[result.id]; assert.equal(entry.phase, 'preserved');
    assert.equal((await fs.readFile(entry.copy.file)).toString(), 'Data');
    await fs.writeFile(entry.copy.file, 'Bad!');
    await assert.rejects(verifyRemoteRemovalCopy({entry, state: f.state}), /bytes changed/);
    assert.deepEqual(f.state.snapshot().materialized['a.txt'], f.args.previous);
  } finally {await f.close();}
});
test('a reappeared remote object holds removal and keeps the private copy', async () => {
  const f = await fixture({reappeared: true}); try {
    const result = await prepareRemoteRemoval(f.args); assert.equal(result.reason, 'remote-reappeared');assert.equal(result.readyForNativeRemoval, false);
    const entry = f.state.snapshot().remoteRemovals[result.id]; await verifyRemoteRemovalCopy({entry, state: f.state});
    assert.equal(f.counts().unlocked, 1);
  } finally {await f.close();}
});
test('partial cached bytes are held before any capture or journal mutation', async () => {
  const f = await fixture({cachedBytes: 2});try {
    await assert.rejects(prepareRemoteRemoval(f.args), /clean cache/);
    assert.deepEqual(f.counts(), {checks: 1, unlocked: 1, captures: 0}); assert.deepEqual(f.state.snapshot().remoteRemovals, {});
  } finally {await f.close();}
});
test('a lost native removal reply resolves from absence without another mutation and retains cached bytes', async () => {
  const f = await fixture(); try {
    const prepared = await prepareRemoteRemoval(f.args); let exists = true, removals = 0;
    f.args.bridge.inspect = async () => ({exists});
    f.args.bridge.removeRemote = async (token, args) => {removals++;assert.equal(token, 'owned');assert.equal(args.absent, true);assert.equal((await fs.readFile(args.backup)).toString(), 'Data');exists = false;throw Error('lost native reply');};
    await assert.rejects(recoverRemoteRemoval({...f.args, id: prepared.id, finish: true}), /lost native reply/);
    assert.equal(f.state.snapshot().remoteRemovals[prepared.id].phase, 'removing');
    const result = await recoverRemoteRemoval({...f.args, id: prepared.id});assert.equal(result.resolved, true);assert.equal(removals, 1);
    const entry = f.state.snapshot().remoteRemovals[prepared.id];assert.equal(entry.phase, 'removed');await verifyRemoteRemovalCopy({entry, state: f.state});
    assert.equal(f.state.snapshot().materialized['a.txt'], undefined);
  } finally {await f.close();}
});
test('missing local files before recorded native intent do not complete removal', async () => {
  const f = await fixture();try {
    const prepared = await prepareRemoteRemoval(f.args);f.args.bridge.inspect = async () => ({exists: false});
    const result = await recoverRemoteRemoval({...f.args, id: prepared.id});assert.equal(result.reason, 'local-missing-before-removal-intent');
    assert.deepEqual(f.state.snapshot().materialized['a.txt'], f.args.previous);
  } finally {await f.close();}
});
test('background reconciliation removes confirmed remote omissions and retains complete cached bytes', async () => {
  const f = await fixture();try {
    let exists = true, removals = 0;f.args.bridge.inspect = async () => ({exists});
    f.args.bridge.removeRemote = async () => {removals++;exists = false;};
    const conflicts = [{path: 'a.txt', key: 'a.txt', remoteMissing: true}];
    assert.deepEqual(await reconcileRemoteRemovals({...f.args, conflicts}), []);assert.equal(removals, 1);
    const entry = Object.values(f.state.snapshot().remoteRemovals)[0];await verifyRemoteRemovalCopy({entry, state: f.state});
    assert.equal(entry.phase, 'removed');
  } finally {await f.close();}
});
test('interrupted private copy preparation resumes without overwriting the partial copy', async () => {
  const f = await fixture();try {
    const capture = f.args.bridge.capturePinnedCurrent;let partial;
    f.args.bridge.capturePinnedCurrent = async (_token, args) => {partial = args.backup;await fs.writeFile(partial, 'Pa', {flag: 'wx'});throw Error('Interrupted copy');};
    await assert.rejects(prepareRemoteRemoval(f.args), /Interrupted copy/);
    const id = Object.keys(f.state.snapshot().remoteRemovals)[0];assert.equal(f.state.snapshot().remoteRemovals[id].phase, 'observed');
    f.args.bridge.capturePinnedCurrent = capture;let exists = true;f.args.bridge.inspect = async () => ({exists});f.args.bridge.removeRemote = async () => {exists = false;};
    assert.deepEqual(await reconcileRemoteRemovals({...f.args, conflicts: [{path: 'a.txt', key: 'a.txt', remoteMissing: true}]}), []);
    assert.equal((await fs.readFile(partial)).toString(), 'Pa');
    await verifyRemoteRemovalCopy({entry: f.state.snapshot().remoteRemovals[id], state: f.state});
  } finally {await f.close();}
});
test('completed remote copies are verified and revealed while disconnected; removing history preserves the file', async () => {
  const f = await fixture();try {
    let exists = true;f.args.bridge.inspect = async () => ({exists});f.args.bridge.removeRemote = async () => {exists = false;};
    const prepared = await prepareRemoteRemoval(f.args);await recoverRemoteRemoval({...f.args, id: prepared.id, finish: true});
    const entry = f.state.snapshot().remoteRemovals[prepared.id];await f.state.forget();
    const {WindowsDriveRuntime} = require('../src/windows-drive-runtime'), {WindowsDriveService} = require('../src/windows-drive-service');
    const runtime = new WindowsDriveRuntime({state: f.state, root: f.args.root, platform: 'win32'});runtime.started = true;
    const shown = [], service = new WindowsDriveService({runtime, shell: {showItemInFolder: file => shown.push(file)}});
    assert.equal(runtime.recoveryEntries().entries[0].type, 'remote-copy');
    assert.doesNotMatch(JSON.stringify(runtime.recoveryEntries()), /storageBinding|cached|hash|applicationKey/);
    await service.request('recover', {kind: 'remote-copy', id: prepared.id, revealCopies: true});assert.deepEqual(shown, [entry.copy.file]);
    await service.request('recover', {kind: 'remote-copy', id: prepared.id, forget: true});assert.equal(runtime.recoveryEntries().count, 0);
    assert.equal((await fs.readFile(entry.copy.file)).toString(), 'Data');
  } finally {await f.close();}
});
test('unfinished remote-removal history cannot be forgotten through the recovery service', async () => {
  const f = await fixture();try {
    const prepared = await prepareRemoteRemoval(f.args);
    const {WindowsDriveRuntime} = require('../src/windows-drive-runtime'), {WindowsDriveService} = require('../src/windows-drive-service');
    const runtime = new WindowsDriveRuntime({state: f.state, root: f.args.root, platform: 'win32'});runtime.started = true;
    const service = new WindowsDriveService({runtime, shell: {}});
    await assert.rejects(service.request('recover', {kind: 'remote-remove', id: prepared.id, forget: true}), /must remain recorded/);
    await assert.rejects(runtime.forgetRemoteRemovalCopies(prepared.id), /Only completed/);
    assert.equal(f.state.snapshot().remoteRemovals[prepared.id].phase, 'preserved');
  } finally {await f.close();}
});
test('remote folders are held while their cloud prefix or tracked children remain', async () => {
  const f = await fixture();try {
    const previous = {key: 'folder/', etag: null, fileID: null, size: 0};await f.state.markMaterialized('folder', previous);
    f.args.store.listAll = async () => [{name: 'folder/child.txt'}];
    assert.equal((await prepareRemoteRemoval({...f.args, local: 'folder', previous})).reason, 'remote-present');assert.equal(f.counts().captures, 0);
    f.args.store.listAll = async () => [];await f.state.markMaterialized('folder/child.txt', {key: 'folder/child.txt', etag: 'old', size: 4});
    f.args.bridge.lockRemoteRemoval = async () => ({token: 'owned', cloud: true, directory: true, identity: JSON.stringify(previous), size: 0, onDiskBytes: 0});
    await assert.rejects(prepareRemoteRemoval({...f.args, local: 'folder', previous}), /Tracked child/);
    assert.deepEqual(f.state.snapshot().remoteRemovals, {});
  } finally {await f.close();}
});
test('automatic remote reconciliation removes children before their empty folder', async () => {
  const f = await fixture();try {
    const folder = {key: 'folder/', etag: null, fileID: null, size: 0}, child = {key: 'folder/child.txt', etag: 'old', fileID: 'v1', size: 4};
    await f.state.markMaterialized('folder', folder);await f.state.markMaterialized('folder/child.txt', child);f.args.store.listAll = async () => [];
    const existing = new Set(['folder', 'folder/child.txt']), order = [];
    f.args.bridge.inspect = async local => ({exists: existing.has(local)});
    f.args.bridge.lockRemoteRemoval = async local => {const previous = f.state.snapshot().materialized[local];return {token: 'owned', cloud: true, directory: local === 'folder', identity: JSON.stringify(previous), size: previous.size, onDiskBytes: previous.size, inSync: true, modifiedBytes: 0};};
    f.args.bridge.removeRemote = async (_token, args) => {const local = args.directory ? 'folder' : 'folder/child.txt';if(args.directory)assert(!existing.has('folder/child.txt'));order.push(local);existing.delete(local);};
    const conflicts = [{path: 'folder', key: 'folder/', remoteMissing: true}, {path: 'folder/child.txt', key: child.key, remoteMissing: true}];
    assert.deepEqual(await reconcileRemoteRemovals({...f.args, conflicts}), []);assert.deepEqual(order, ['folder/child.txt', 'folder']);
    assert.equal(f.state.snapshot().materialized.folder, undefined);
  } finally {await f.close();}
});
test('locally edited omissions remain conflicts without a recovery copy or native removal', async () => {
  const f = await fixture();try {
    const original = f.args.bridge.lockRemoteRemoval;f.args.bridge.lockRemoteRemoval = async local => ({...await original(local), inSync: false, modifiedBytes: 4});
    let removals = 0;f.args.bridge.removeRemote = async () => {removals++;};
    const result = await reconcileRemoteRemovals({...f.args, conflicts: [{path: 'a.txt', key: 'a.txt', remoteMissing: true}]});
    assert.equal(result.length, 1);assert.match(result[0].error, /clean cache/);assert.equal(removals, 0);assert.equal(f.counts().captures, 0);
    assert.deepEqual(f.state.snapshot().materialized['a.txt'], f.args.previous);assert.deepEqual(f.state.snapshot().remoteRemovals, {});
  } finally {await f.close();}
});
test('a cloud object reappearing after copy preparation never authorizes native removal', async () => {
  const f = await fixture();try {
    const prepared = await prepareRemoteRemoval(f.args);let removals = 0;f.args.store.stat = async () => f.args.previous;f.args.bridge.removeRemote = async () => {removals++;};
    const result = await recoverRemoteRemoval({...f.args, id: prepared.id, finish: true});assert.equal(result.remoteReappeared, true);assert.equal(result.resolved,true);assert.equal(removals, 0);
    const entry = f.state.snapshot().remoteRemovals[prepared.id];assert.equal(entry.phase, 'withdrawn');await verifyRemoteRemovalCopy({entry, state: f.state});
    assert.deepEqual(f.state.snapshot().materialized['a.txt'], f.args.previous);
    assert.equal(await f.state.reserveLocalFile('a.txt'), 'a.txt');
  } finally {await f.close();}
});
test('withdrawal refuses changed local bytes and cannot erase a native removal intent', async () => {
  const f = await fixture();try {
    const prepared = await prepareRemoteRemoval(f.args);f.args.store.stat = async () => f.args.previous;
    f.args.bridge.fingerprintPinned = async () => ({size: 4, hash: 'b'.repeat(64)});
    await assert.rejects(recoverRemoteRemoval({...f.args, id: prepared.id, finish: true}), /changed local bytes/);
    assert.equal(f.state.snapshot().remoteRemovals[prepared.id].phase, 'preserved');
    const {WindowsRemoteRemovalJournal} = require('../src/windows-drive-remote-removal-journal'), journal = new WindowsRemoteRemovalJournal(f.state);
    await journal.removing(prepared.id, {absent: true, clean: true, cachedBytes: 4});
    await assert.rejects(journal.withdraw(prepared.id, {present: true, clean: true}), /native removal/);
  } finally {await f.close();}
});
