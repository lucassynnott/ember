const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { NTN_WINDOWS_RELEASE: release } = require('../src/notion-connect');
const { downloadVerified } = require('../src/model-manager');
const { runText } = require('../src/cli-run');

(async () => {
  if (process.platform !== 'win32') throw new Error('This acceptance check requires Windows.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-notion-'));
  try {
    const archive = path.join(directory, 'ntn.tgz');
    await downloadVerified({ url: release.url, destination: archive, expectedSize: release.size, sha256: release.sha256 });
    await runText('tar.exe', ['-xzf', archive, '-C', directory, '--strip-components', String(release.stripComponents), release.entry]);
    const { stdout, stderr } = await runText(path.join(directory, release.executable), ['--version']);
    const output = `${stdout}\n${stderr}`.trim();
    if (!output.includes(release.version)) throw new Error(`Unexpected Notion CLI version: ${output}`);
    console.log(`Official Windows Notion CLI launched: ${output}`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
