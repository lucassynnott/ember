import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WindowsDpapiStore } from '../.windows-tools/composio-source/ts/packages/cli-keyring/src/stores/windows-dpapi';
import { createDefaultStore } from '../.windows-tools/composio-source/ts/packages/cli-keyring/src/index';

if (process.platform !== 'win32') throw new Error('Windows DPAPI acceptance requires Windows.');
assert.equal((await createDefaultStore()).id, 'windows-dpapi');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-keyring-'));
const store = new WindowsDpapiStore(directory);
const service = 'ember-acceptance';
const user = 'test-user';
const secret = Buffer.from('Synthetic credential — Unicode ✓\0binary', 'utf8');
try {
  await assert.rejects(store.getSecret(service, user), error => error.kind === 'NoEntry');
  await store.setSecret(service, user, secret);
  const files = await fs.readdir(directory);
  assert.equal(files.length, 1);
  const encrypted = await fs.readFile(path.join(directory, files[0]));
  assert.ok(!encrypted.includes(secret), 'Credential file must not contain plaintext');
  assert.notDeepEqual(encrypted, secret);
  assert.deepEqual(Buffer.from(await new WindowsDpapiStore(directory).getSecret(service, user)), secret);
  await assert.rejects(store.getSecret(service, 'another-user'), error => error.kind === 'NoEntry');
  const replacement = Buffer.from('Synthetic replacement');
  await store.setSecret(service, user, replacement);
  assert.deepEqual(Buffer.from(await store.getSecret(service, user)), replacement);
  await fs.writeFile(path.join(directory, files[0]), Buffer.from('corrupted ciphertext'));
  await assert.rejects(store.getSecret(service, user), error => error.kind === 'NoStorageAccess');
  await store.deleteCredential(service, user);
  await assert.rejects(store.getSecret(service, user), error => error.kind === 'NoEntry');
  await assert.rejects(store.deleteCredential(service, user), error => error.kind === 'NoEntry');
  assert.equal((await fs.readdir(directory)).length, 0);
  console.log('Windows DPAPI credential persistence, replacement, corruption and deletion passed.');
} finally { await fs.rm(directory, { recursive: true, force: true }); }
