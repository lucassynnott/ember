const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {WindowsDriveState} = require('../src/windows-drive-state');
const {WindowsRemoteRemovalJournal} = require('../src/windows-drive-remote-removal-journal');
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-remote-removal-'));
  const safeStorage = {isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => v.toString()};
  const reopen = async () => {const state = new WindowsDriveState({directory, safeStorage}); await state.load(); return state;};
  const state = await reopen();
  await state.configure({provider: 's3', bucketName: 'test', keyID: 'test', applicationKey: 'test'});
  const previous = {key: 'folder/a.txt', etag: 'revision', fileID: 'v1', size: 4};
  await state.markMaterialized('a.txt', previous);
  return {state, reopen, journal: new WindowsRemoteRemovalJournal(state), args: {local: 'a.txt', previous, root: 'C:\\Ember Drive', absent: true, cachedBytes: 4}, close: () => fs.rm(directory, {recursive: true, force: true})};
}
test('cached remote removals retain their binding and recovery evidence across restart', async () => {
  const f = await fixture(); try {
    const id = await f.journal.begin(f.args);
    await assert.rejects(f.journal.removing(id, {absent: true, clean: true, cachedBytes: 4}), /recoverable/);
    await assert.rejects(f.journal.preserved(id, {file: 'C:\\Ember Drive\\copy', size: 4, hash: 'a'.repeat(64)}), /outside/);
    await f.journal.preserved(id, {file: 'C:\\Private Recovery\\copy', size: 4, hash: 'a'.repeat(64)});
    const restored = await f.reopen(), journal = new WindowsRemoteRemovalJournal(restored);
    assert.equal(restored.snapshot().remoteRemovals[id].phase, 'preserved');
    await assert.rejects(journal.removing(id, {absent: false, clean: true, cachedBytes: 4}), /fresh absence/);
    await assert.rejects(journal.removing(id, {absent: true, clean: false, cachedBytes: 4}), /clean ownership/);
    await journal.removing(id, {absent: true, clean: true, cachedBytes: 4});
    await assert.rejects(journal.complete(id, {localMissing: false}), /native absence/);
    assert.deepEqual(restored.snapshot().materialized['a.txt'], f.args.previous);
    await journal.complete(id, {localMissing: true});
    const final = (await f.reopen()).snapshot();
    assert.equal(final.materialized['a.txt'], undefined);
    assert.equal(final.remoteRemovals[id].phase, 'removed');
    assert.equal(final.remoteRemovals[id].copy.hash, 'a'.repeat(64));
  } finally {await f.close();}
});
test('remote-removal journal refuses partial cache, aliases, duplicate intents and storage changes', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.journal.begin({...f.args, cachedBytes: 2}), /complete clean cache/);
    await f.state.markMaterialized('alias.txt', f.args.previous);
    await assert.rejects(f.journal.begin(f.args), /alias/);
    await f.state.update(s => {delete s.materialized['alias.txt'];});
    const id = await f.journal.begin({...f.args, cachedBytes: 0});
    await assert.rejects(f.journal.begin(f.args), /unfinished operation/);
    await f.state.update(s => {s.storageBinding = 'changed';});
    await assert.rejects(f.journal.removing(id, {absent: true, clean: true, cachedBytes: 0}), /storage binding/);
  } finally {await f.close();}
});
