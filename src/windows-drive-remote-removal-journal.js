const crypto = require('node:crypto');
const path = require('node:path');
const {validLocal} = require('./windows-drive-names');
const {sameRevision} = require('./windows-drive-delete-journal');
const {pendingOperations, operationTouches} = require('./windows-drive-pending');

// Remote absence cannot use the local-delete journal: there is no cloud source
// left to copy to trash. Keep the binding until native removal is confirmed, and
// retain complete cached bytes outside the provider root before authorizing it.
class WindowsRemoteRemovalJournal {
  constructor(state) { this.state = state; }
  async begin({local, previous, root, absent, cachedBytes}) {
    if (!local || typeof local !== 'string' || local.split('/').some(part => !validLocal(part)) ||
        !previous || typeof previous.key !== 'string' || !previous.key || previous.key.endsWith('/') ||
        typeof previous.etag !== 'string' || !previous.etag || !Number.isSafeInteger(previous.size) || previous.size < 0 ||
        previous.fileID != null && typeof previous.fileID !== 'string' ||
        !path.win32.isAbsolute(root || '') || absent !== true ||
        !Number.isSafeInteger(cachedBytes) || cachedBytes < 0 ||
        cachedBytes !== 0 && cachedBytes !== previous.size) {
      throw Error('Remote removal requires confirmed absence and an empty or complete clean cache.');
    }
    let id;
    await this.state.update(state => {
      if (!state.storageBinding || !sameRevision(state.materialized[local], previous) ||
          Object.entries(state.materialized).some(([name, value]) => name !== local && value.key === previous.key)) {
        throw Error('The remote removal binding changed or has another local alias.');
      }
      if ([...pendingOperations(state), ...Object.values(state.remoteRemovals || {}).filter(entry => entry.phase !== 'removed')].some(entry => operationTouches(entry, local, previous.key))) {
        throw Error('An unfinished operation protects the remote removal source.');
      }
      state.remoteRemovals ??= {};
      if (Object.keys(state.remoteRemovals).length >= 1000) throw Error('Resolve unfinished remote removals first.');
      id = crypto.randomUUID();
      state.remoteRemovals[id] = {id, local, key: previous.key, previous: structuredClone(previous),
        root: path.win32.normalize(root), storageBinding: state.storageBinding, driveIdentity: state.identity, cachedBytes, phase: 'observed', started: Date.now()};
    });
    return id;
  }
  #entry(state, id, phase) {
    const entry = state.remoteRemovals?.[id];
    if (!entry || entry.phase !== phase || state.storageBinding !== entry.storageBinding || state.identity !== entry.driveIdentity ||
        !sameRevision(state.materialized[entry.local], entry.previous)) {
      throw Error('The remote removal intent or storage binding changed.');
    }
    return entry;
  }
  preserved(id, {file, size, hash} = {}) {
    return this.state.update(state => {
      const entry = this.#entry(state, id, 'observed');
      if (typeof file !== 'string' || !path.win32.isAbsolute(file) || size !== entry.previous.size ||
          typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || entry.cachedBytes !== entry.previous.size) {
        throw Error('Remote removal requires a complete verified local recovery copy.');
      }
      const relative = path.win32.relative(entry.root, file);
      if (!relative || !path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\')) {
        throw Error('The recovery copy must be outside the Drive root.');
      }
      entry.copy = {file, size, hash}; entry.phase = 'preserved';
    });
  }
  removing(id, {absent, clean, cachedBytes} = {}) {
    return this.state.update(state => {
      const phase = state.remoteRemovals?.[id]?.phase;
      if (!['observed', 'preserved'].includes(phase)) throw Error('Invalid remote removal phase.');
      const entry = this.#entry(state, id, phase);
      if (absent !== true || clean !== true || cachedBytes !== entry.cachedBytes ||
          entry.cachedBytes > 0 && !entry.copy) throw Error('Remote removal lacks fresh absence, clean ownership or recoverable bytes.');
      entry.phase = 'removing';
    });
  }
  complete(id, {localMissing} = {}) {
    return this.state.update(state => {
      const entry = this.#entry(state, id, 'removing');
      if (localMissing !== true) throw Error('Remote removal completion requires confirmed native absence.');
      // Keep recovery evidence, including the retained copy, after completion.
      entry.phase = 'removed'; entry.completed = Date.now();
      delete state.materialized[entry.local];
    });
  }
}
module.exports = {WindowsRemoteRemovalJournal};
