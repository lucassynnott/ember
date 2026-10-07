const {WindowsDeleteJournal} = require('./windows-drive-delete-journal');
const {revisionFingerprint} = require('./windows-drive-content-proof');
const same = (object, recorded) => object?.etag === recorded?.etag &&
  (object?.fileID || null) === (recorded?.fileID || null) && object?.size === recorded?.size;
const cancelled = signal => { if (signal?.aborted) throw Error('Deletion cancelled; check its recorded outcome.'); };

async function recoverDeletion({id, state, store, signal, finish = false}) {
  let entry = state.snapshot().deletes?.[id];
  if (!entry) return {resolved: true, alreadyResolved: true};
  const journal = new WindowsDeleteJournal(state);
  let cloudWrites = false, source = await store.stat(entry.key, signal), trash = await store.stat(entry.trash, signal);
  cancelled(signal);
  if (['prepared', 'copying'].includes(entry.phase)) {
    if (!source) return {resolved: false, reason: 'delete-source-missing-before-intent'};
    if (source.name !== entry.key || !same(source, entry.previous)) throw Error('The deletion source changed; it was preserved.');
    if (entry.phase === 'prepared') {
      if (finish !== true) return {resolved: false, reason: 'delete-copy-missing'};
      const hash = await revisionFingerprint(store, source, signal);
      await journal.sourceVerified(id, hash); entry = state.snapshot().deletes[id];
    }
    if (!trash) {
      if (finish !== true) return {resolved: false, reason: 'delete-copy-missing'};
      if (await revisionFingerprint(store, source, signal) !== entry.hash) throw Error('The deletion source bytes changed.');
      cancelled(signal); cloudWrites = true;
      const result = await store.copy(source, entry.trash, signal);
      trash = await store.stat(entry.trash, signal);
      if (!trash || trash.etag !== result?.CopyObjectResult?.ETag ||
          result.VersionId && trash.fileID !== result.VersionId) throw Error('The recoverable trash copy response was not confirmed.');
    }
    if (trash.name !== entry.trash || trash.size !== entry.previous.size || await revisionFingerprint(store, trash, signal) !== entry.hash) {
      throw Error('The recoverable trash copy has different bytes.');
    }
    await journal.copied(id, {key: entry.trash, etag: trash.etag, fileID: trash.fileID || null, size: trash.size, hash: entry.hash});
    entry = state.snapshot().deletes[id];
  }
  if (!['copied', 'deleting', 'deleted'].includes(entry.phase)) throw Error('Invalid deletion recovery phase.');
  trash = await store.stat(entry.trash, signal);
  if (!trash || trash.name !== entry.trash || !same(trash, entry.copied) || await revisionFingerprint(store, trash, signal) !== entry.hash) {
    throw Error('The recorded trash copy changed; deletion remains held.');
  }
  source = await store.stat(entry.key, signal); cancelled(signal);
  if (source) {
    if (entry.phase === 'deleted') return {resolved: false, reason: 'delete-source-reappeared'};
    if (source.name !== entry.key || !same(source, entry.previous)) throw Error('The cloud deletion source changed; it was preserved.');
    if (finish !== true) return {resolved: false, reason: 'delete-source-still-present'};
    if (entry.phase === 'copied') await journal.deleting(id);
    cancelled(signal); cloudWrites = true;
    await store.deleteVersion(entry.key, '', {etag: entry.previous.etag, signal});
    if (await store.stat(entry.key, signal)) throw Error('The source deletion was not confirmed.');
    await journal.deleted(id);
  } else if (entry.phase === 'deleting') {
    await journal.deleted(id);
  } else if (entry.phase !== 'deleted') {
    return {resolved: false, reason: 'delete-source-missing-before-intent'};
  }
  cancelled(signal);
  return {id, resolved: false, readyForLocalDeletion: true, reason: 'delete-local-file-still-present', readOnlyCloudCheck: !cloudWrites};
}

async function prepareDeletion({local, previous, state, store, signal}) {
  const journal = new WindowsDeleteJournal(state);
  const pending = Object.values(state.snapshot().deletes || {}).find(entry => entry.local === local);
  if (pending && (!same(pending.previous, previous) || pending.previous.key !== previous.key)) {
    throw Error('The held deletion identifies another revision.');
  }
  const id = pending?.id || await journal.begin({local, previous});
  return recoverDeletion({id, state, store, signal, finish: true});
}

async function completeDeletion({id, state, store, bridge, signal}) {
  const entry = state.snapshot().deletes?.[id];
  if (!entry) return {resolved: true, alreadyResolved: true};
  if (entry.phase !== 'deleted') return {resolved: false, reason: 'delete-cloud-transfer-unfinished'};
  const checked = await recoverDeletion({id, state, store, signal});
  if (!checked.readyForLocalDeletion) return checked;
  const info = await bridge.inspect(entry.local); cancelled(signal);
  if (info.exists !== false) return {resolved: false, reason: 'delete-local-file-still-present'};
  await new WindowsDeleteJournal(state).complete(id, {localMissing: true});
  return {resolved: true, readOnlyCloudCheck: true};
}
module.exports = {prepareDeletion, recoverDeletion, completeDeletion};
