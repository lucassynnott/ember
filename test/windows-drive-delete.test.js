const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {WindowsDriveState} = require('../src/windows-drive-state');
const {WindowsDeleteJournal} = require('../src/windows-drive-delete-journal');
const {prepareDeletion, recoverDeletion, completeDeletion} = require('../src/windows-drive-delete');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-delete-journal-'));
  const safeStorage = {isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString()};
  const state = new WindowsDriveState({directory, safeStorage}); await state.load();
  const previous = {key: 'remote/file', etag: 'old', fileID: 'v1', size: 4}, local = 'file';
  await state.markMaterialized(local, previous);
  const objects = new Map([[previous.key, {name: previous.key, ...previous, data: Buffer.from('Data')}]]);
  let copies = 0, deletions = 0, localExists = true;
  const store = {
    stat: async key => objects.get(key) || null,
    read: async (key, offset, length) => objects.get(key).data.subarray(offset, offset + length),
    copy: async (source, key) => { copies++; objects.set(key, {name: key, etag: 'saved', fileID: 'trash-v1', size: source.size, data: Buffer.from(objects.get(source.name).data)}); return {CopyObjectResult: {ETag: 'saved'}, VersionId: 'trash-v1'}; },
    deleteVersion: async (key, version, options) => { assert.equal(version, ''); assert.equal(options.etag, previous.etag); deletions++; objects.delete(key); }
  };
  const bridge = {inspect: async () => ({exists: localExists})};
  return {state, previous, local, objects, store, bridge, journal: new WindowsDeleteJournal(state),
    args: {state, local, previous, store, bridge}, counts: () => ({copies, deletions}),
    removeLocal: () => {localExists = false;}, reopen: async () => {const restored = new WindowsDriveState({directory, safeStorage}); await restored.load(); return restored;},
    close: () => fs.rm(directory, {recursive: true, force: true})};
}

test('a deletion retains complete trash bytes before cloud deletion and keeps the binding until local absence', async () => {
  const f = await fixture();
  try {
    const prepared = await prepareDeletion(f.args); assert.equal(prepared.readyForLocalDeletion, true);
    assert.deepEqual(f.counts(), {copies: 1, deletions: 1}); assert.equal(f.objects.has(f.previous.key), false);
    const entry = f.state.snapshot().deletes[prepared.id]; assert.deepEqual(f.objects.get(entry.trash).data, Buffer.from('Data'));
    assert.deepEqual(f.state.snapshot().materialized.file, f.previous);
    assert.equal((await completeDeletion({...f.args, id: entry.id})).reason, 'delete-local-file-still-present');
    f.removeLocal(); assert.equal((await completeDeletion({...f.args, id: entry.id})).resolved, true);
    assert.deepEqual(f.state.snapshot().deletes, {}); assert.equal(f.state.snapshot().materialized.file, undefined);
    assert.deepEqual(f.objects.get(entry.trash).data, Buffer.from('Data'));
  } finally {await f.close();}
});

test('a lost trash-copy response survives restart and read-only recovery never repeats the copy', async () => {
  const f = await fixture();
  try {
    const copy = f.store.copy; f.store.copy = async (...args) => {await copy(...args); throw Error('Lost copy response');};
    await assert.rejects(prepareDeletion(f.args), /Lost copy response/);
    const state = await f.reopen(), id = Object.keys(state.snapshot().deletes)[0];
    for (const finish of [false, 'true']) {
      assert.equal((await recoverDeletion({...f.args, state, id, finish})).reason, 'delete-source-still-present');
      assert.deepEqual(f.counts(), {copies: 1, deletions: 0});
    }
    assert.equal((await recoverDeletion({...f.args, state, id, finish: true})).readyForLocalDeletion, true);
    assert.deepEqual(f.counts(), {copies: 1, deletions: 1});
  } finally {await f.close();}
});

test('a lost deletion response is confirmed after restart without repeating any cloud mutation', async () => {
  const f = await fixture();
  try {
    const remove = f.store.deleteVersion; f.store.deleteVersion = async (...args) => {await remove(...args); throw Error('Lost delete response');};
    await assert.rejects(prepareDeletion(f.args), /Lost delete response/);
    const state = await f.reopen(), id = Object.keys(state.snapshot().deletes)[0];
    const result = await recoverDeletion({...f.args, state, id}); assert.equal(result.readyForLocalDeletion, true); assert.equal(result.readOnlyCloudCheck, true);
    f.removeLocal(); assert.equal((await completeDeletion({...f.args, state, id})).resolved, true);
    assert.deepEqual(f.counts(), {copies: 1, deletions: 1});
  } finally {await f.close();}
});

test('changed cloud content or changed trash proof prevents deletion and preserves its journal', async () => {
  for (const change of ['source', 'trash']) {
    const f = await fixture();
    try {
      const copy = f.store.copy; f.store.copy = async (...args) => {await copy(...args); throw Error('Lost copy');};
      await assert.rejects(prepareDeletion(f.args), /Lost copy/); const id = Object.keys(f.state.snapshot().deletes)[0], entry = f.state.snapshot().deletes[id];
      if (change === 'source') f.objects.get(f.previous.key).etag = 'changed';
      else f.objects.get(entry.trash).data = Buffer.from('Edit');
      await assert.rejects(recoverDeletion({...f.args, id, finish: true}), /changed|different bytes/);
      assert.equal(f.counts().deletions, 0); assert(f.state.snapshot().deletes[id]); assert(f.objects.has(f.previous.key));
    } finally {await f.close();}
  }
});

test('missing sources before a deletion intent and reappeared sources never authorize another deletion', async () => {
  const f = await fixture();
  try {
    const id = await f.journal.begin(f.args); f.objects.delete(f.previous.key);
    assert.equal((await recoverDeletion({...f.args, id, finish: true})).reason, 'delete-source-missing-before-intent');
    assert.deepEqual(f.counts(), {copies: 0, deletions: 0});
  } finally {await f.close();}
  const second = await fixture();
  try {
    const result = await prepareDeletion(second.args);
    second.objects.set(second.previous.key, {name: second.previous.key, ...second.previous, data: Buffer.from('Data')});
    assert.equal((await recoverDeletion({...second.args, id: result.id, finish: true})).reason, 'delete-source-reappeared');
    assert.deepEqual(second.counts(), {copies: 1, deletions: 1});
  } finally {await second.close();}
});

test('held deletions refuse competing reservations uploads moves and premature completion atomically', async () => {
  const f = await fixture();
  try {
    const id = await f.journal.begin(f.args), before = f.state.snapshot();
    for (const operation of [() => f.state.reserveLocalFile('FILE'), () => f.state.reserveRemoteFile(f.previous.key),
      () => f.state.beginUpload({local: f.local, key: f.previous.key, size: 4, modified: 1, hash: 'a'.repeat(64)}),
      () => f.state.beginMove({from: f.local, local: 'other', key: 'remote/other', previous: f.previous, size: 4, modified: 1, hash: 'a'.repeat(64)})]) {
      await assert.rejects(operation(), /unfinished/i); assert.deepEqual(f.state.snapshot(), before);
    }
    await assert.rejects(f.journal.complete(id, {localMissing: true}), /completion/);
    await assert.rejects(f.journal.deleting(id), /confirmed trash/);
    await assert.rejects(f.journal.begin({...f.args, local: '../escape'}), /valid local/);
  } finally {await f.close();}
});
