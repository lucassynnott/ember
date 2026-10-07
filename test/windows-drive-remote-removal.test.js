const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const {WindowsDriveState} = require('../src/windows-drive-state');
const {prepareRemoteRemoval, verifyRemoteRemovalCopy} = require('../src/windows-drive-remote-removal');
async function fixture({reappeared = false, cachedBytes = 4} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-remote-copy-'));
  const state = new WindowsDriveState({directory, safeStorage: {isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString()}});
  await state.load(); await state.configure({provider: 's3', bucketName: 'test', keyID: 'test', applicationKey: 'test'});
  const previous = {key: 'a.txt', etag: 'old', fileID: 'v1', size: 4}; await state.markMaterialized('a.txt', previous);
  let checks = 0, unlocked = 0, captures = 0;
  const bridge = {lockPinnedRecovery: async () => ({token: 'owned', cloud: true, identity: JSON.stringify(previous), size: 4, inSync: true, modifiedBytes: 0, onDiskBytes: cachedBytes}),
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
    assert.deepEqual(f.counts(), {checks: 1, unlocked: 1, captures: 0}); assert.equal(f.state.snapshot().remoteRemovals, undefined);
  } finally {await f.close();}
});
