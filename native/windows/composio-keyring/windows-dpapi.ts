import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CredentialStore } from '../core/store';
import { CredentialPersistence } from '../core/persistence';
import { KeyringError } from '../core/errors';

// Secrets travel only over stdin/stdout pipes. The command line contains a fixed script.
const script = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String($request.data)
  $entropy = [Convert]::FromBase64String($request.entropy)
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($request.action -eq 'protect') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
  } else {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
  }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { [Console]::Error.Write('Windows credential protection failed.'); exit 1 }
`;
const encoded = Buffer.from(script, 'utf16le').toString('base64');

async function transform(action: 'protect' | 'unprotect', bytes: Uint8Array, identity: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const binary = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(binary, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows credential protection timed out.')); }, 60000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('Windows credential protection could not start.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !output || !/^[A-Za-z0-9+/]*={0,2}$/.test(output)) reject(new Error('Windows credential protection failed.'));
      else resolve(Buffer.from(output, 'base64'));
    });
    child.stdin.end(JSON.stringify({ action, data: Buffer.from(bytes).toString('base64'), entropy: Buffer.from(identity).toString('base64') }));
  });
}

export class WindowsDpapiStore implements CredentialStore {
  readonly id = 'windows-dpapi';
  readonly vendor = 'Windows DPAPI CurrentUser';
  constructor(readonly directory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Ember', 'ComposioCredentials')) {}
  persistence(): CredentialPersistence { return CredentialPersistence.UntilDelete; }
  private identity(service: string, user: string): string {
    if (!service || !user) throw new KeyringError({ kind: 'Invalid', param: 'service/user', reason: 'Must not be empty.' });
    return createHash('sha256').update(JSON.stringify([service, user])).digest('hex');
  }
  private file(identity: string): string { return path.join(this.directory, identity + '.dpapi'); }
  async setSecret(service: string, user: string, secret: Uint8Array): Promise<void> {
    const identity = this.identity(service, user);
    const temporary = this.file(identity) + '.' + randomUUID() + '.tmp';
    let stage = 'protection';
    try {
      const encrypted = await transform('protect', secret, identity);
      stage = 'directory creation';
      await fs.mkdir(this.directory, { recursive: true });
      stage = 'encrypted file write';
      await fs.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      stage = 'atomic replacement';
      await fs.rename(temporary, this.file(identity));
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      const detail = stage === 'protection' && /^Windows credential protection (?:timed out|failed|could not start)\.$/.test(failure.message) ? failure.message : /^[A-Z0-9_]+$/.test(failure.code || '') ? failure.code : 'unavailable';
      throw new KeyringError({ kind: 'NoStorageAccess', cause: new Error(`Windows could not save the protected credential during ${stage}: ${detail}`) });
    }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async getSecret(service: string, user: string): Promise<Uint8Array> {
    const identity = this.identity(service, user);
    let encrypted: Buffer;
    try { encrypted = await fs.readFile(this.file(identity)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KeyringError({ kind: 'NoEntry' });
      throw new KeyringError({ kind: 'NoStorageAccess', cause: new Error('Windows could not read the protected credential.') });
    }
    try { return await transform('unprotect', encrypted, identity); }
    catch { throw new KeyringError({ kind: 'NoStorageAccess', cause: new Error('Windows could not decrypt the protected credential.') }); }
  }
  async deleteCredential(service: string, user: string): Promise<void> {
    try { await fs.unlink(this.file(this.identity(service, user))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new KeyringError({ kind: 'NoEntry' });
      throw new KeyringError({ kind: 'NoStorageAccess', cause: new Error('Windows could not remove the protected credential.') });
    }
  }
}
