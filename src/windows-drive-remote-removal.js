const fs = require('node:fs/promises');
const path = require('node:path');
const {fingerprintFile} = require('./windows-drive-recovery');
const {sameRevision} = require('./windows-drive-delete-journal');
const {WindowsRemoteRemovalJournal} = require('./windows-drive-remote-removal-journal');
const cancelled = signal => {if (signal?.aborted) throw Error('Remote removal cancelled; recovery files were preserved.');};

async function verifyRemoteRemovalCopy({entry, state, signal}) {
  if (!entry.copy) throw Error('The remote removal recovery copy is missing.');
  const parent = path.join(state.directory, 'remote-removals'), directory = path.join(parent, entry.id);
  if (entry.copy.file !== path.join(directory, 'cached')) throw Error('The recovery copy path does not match its intent.');
  for (const folder of [parent, directory]) {
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('The recovery directory was replaced.');
  }
  if (await fs.realpath(directory) !== path.join(await fs.realpath(parent), entry.id)) throw Error('The recovery directory ownership changed.');
  const stat = await fs.lstat(entry.copy.file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.previous.size || stat.size !== entry.copy.size ||
      await fingerprintFile(entry.copy.file, signal) !== entry.copy.hash) throw Error('The remote removal recovery bytes changed.');
  cancelled(signal); return entry.copy;
}

// This preparation stage never deletes local files or mutates cloud objects.
// Native removal must consume the recorded intent under the same ownership lock.
async function prepareRemoteRemoval({local, previous, root, state, store, bridge, signal}) {
  cancelled(signal);
  if (await store.stat(previous.key, signal)) return {readyForNativeRemoval: false, reason: 'remote-present'};
  let lock; const journal = new WindowsRemoteRemovalJournal(state);
  try {
    lock = await bridge.lockPinnedRecovery(local); cancelled(signal);
    const represented = lock.cloud ? {...JSON.parse(lock.identity), size: lock.size} : null;
    if (!sameRevision(represented, previous) || !lock.inSync || lock.modifiedBytes !== 0 ||
        !Number.isSafeInteger(lock.onDiskBytes) || lock.onDiskBytes < 0 ||
        lock.onDiskBytes !== 0 && lock.onDiskBytes !== previous.size) throw Error('Remote removal requires the unchanged clean cache under its native lock.');
    const id = await journal.begin({local, previous, root, absent: true, cachedBytes: lock.onDiskBytes});
    if (lock.onDiskBytes > 0) {
      const directory = path.join(state.directory, 'remote-removals', id);
      await fs.mkdir(path.dirname(directory), {recursive: true}); await fs.mkdir(directory);
      const file = path.join(directory, 'cached');
      const proof = await bridge.capturePinnedCurrent(lock.token, {updateId: id, backup: file, expectedIdentity: lock.identity, size: previous.size, signal});
      await journal.preserved(id, {file, size: proof.size, hash: proof.hash});
      await verifyRemoteRemovalCopy({entry: state.snapshot().remoteRemovals[id], state, signal});
    }
    cancelled(signal);
    if (await store.stat(previous.key, signal)) return {id, readyForNativeRemoval: false, reason: 'remote-reappeared'};
    // No removing transition until the native removal operation exists and can
    // revalidate the locked identity and retained copy immediately before use.
    return {id, readyForNativeRemoval: true, recoveryPrepared: true, readOnlyCloudCheck: true};
  } finally {if (lock) await bridge.unlockUpload(lock.token);}
}
module.exports = {prepareRemoteRemoval, verifyRemoteRemovalCopy};
