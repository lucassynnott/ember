const crypto = require('node:crypto');
const {validLocal} = require('./windows-drive-names');
const {TRASH} = require('./windows-drive-store');
const {pendingOperations, operationTouches} = require('./windows-drive-pending');
const sameRevision = (a, b) => a?.key === b?.key && a?.etag === b?.etag &&
  (a?.fileID || null) === (b?.fileID || null) && a?.size === b?.size;
const validHash = hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash);

class WindowsDeleteJournal {
  constructor(state) { this.state = state; }
  async begin({local, previous}) {
    if (typeof local !== 'string' || !local || local.split('/').some(part => !validLocal(part)) ||
        !previous || typeof previous.key !== 'string' || !previous.key || previous.key.endsWith('/') ||
        previous.key.startsWith(TRASH) || typeof previous.etag !== 'string' || !previous.etag ||
        previous.fileID != null && typeof previous.fileID !== 'string' || !Number.isSafeInteger(previous.size) || previous.size < 0) {
      throw Error('Deletion requires a recorded file revision and valid local path.');
    }
    let id;
    await this.state.update(state => {
      if (!sameRevision(state.materialized[local], previous) ||
          Object.entries(state.materialized).some(([name, value]) => name !== local && value.key === previous.key)) {
        throw Error('The deletion source binding changed or has another local alias.');
      }
      if (pendingOperations(state).some(entry => operationTouches(entry, local, previous.key))) {
        throw Error('An unfinished operation protects the deletion source.');
      }
      state.deletes ??= {};
      if (Object.keys(state.deletes).length >= 1000) throw Error('Resolve unfinished deletions before deleting more files.');
      id = crypto.randomUUID();
      const started = Date.now(), stamp = new Date(started).toISOString().slice(0, 10).replaceAll('-', '');
      const trash = TRASH + stamp + '/' + id + '/' + previous.key;
      if (Buffer.byteLength(trash) > 1024) throw Error('The recoverable trash key exceeds the storage limit.');
      state.deletes[id] = {id, local, key: previous.key, previous: structuredClone(previous), trash, started, phase: 'prepared'};
    });
    return id;
  }
  sourceVerified(id, hash) {
    return this.state.update(state => {
      const entry = state.deletes?.[id];
      if (!entry || entry.phase !== 'prepared' || !validHash(hash)) throw Error('Invalid deletion source proof.');
      entry.hash = hash; entry.phase = 'copying';
    });
  }
  copied(id, proof) {
    return this.state.update(state => {
      const entry = state.deletes?.[id];
      if (!entry || entry.phase !== 'copying' || proof?.key !== entry.trash || typeof proof.etag !== 'string' || !proof.etag ||
          proof.size !== entry.previous.size || !validHash(proof.hash) || proof.hash !== entry.hash) {
        throw Error('The complete recoverable trash copy is not confirmed.');
      }
      entry.copied = structuredClone(proof); entry.phase = 'copied';
    });
  }
  deleting(id) {
    return this.state.update(state => {
      const entry = state.deletes?.[id];
      if (!entry || entry.phase !== 'copied' || !entry.copied) throw Error('Deletion requires a confirmed trash copy.');
      entry.phase = 'deleting';
    });
  }
  deleted(id) {
    return this.state.update(state => {
      const entry = state.deletes?.[id];
      if (!entry || entry.phase !== 'deleting') throw Error('A deletion outcome requires its recorded intent.');
      entry.phase = 'deleted';
    });
  }
  complete(id, {localMissing} = {}) {
    return this.state.update(state => {
      const entry = state.deletes?.[id];
      if (!entry || entry.phase !== 'deleted' || localMissing !== true ||
          !sameRevision(state.materialized[entry.local], entry.previous)) {
        throw Error('Deletion completion requires the original binding and confirmed local absence.');
      }
      delete state.materialized[entry.local]; delete state.deletes[id];
    });
  }
}
module.exports = {WindowsDeleteJournal, sameRevision};
