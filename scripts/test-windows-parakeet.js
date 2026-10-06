const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { CATALOG, downloadVerified } = require('../src/model-manager');
const { LiveParakeetTranscriber } = require('../src/live-transcription');
const { wavToSamples } = require('../src/recordings');
(async () => {
  assert.equal(process.platform, 'win32');
  const entry = CATALOG.find(item => item.id === 'parakeet-tdt-0.6b-v3');
  const directory = path.resolve('.windows-tools/parakeet-acceptance');
  const model = path.join(directory, entry.install.target);
  await fs.mkdir(model, { recursive: true });
  for (const file of entry.install.files) {
    await downloadVerified({ url: `https://huggingface.co/${entry.install.repo}/resolve/${entry.install.revision}/${file.name}`, destination: path.join(model, file.name), expectedSize: file.size, sha256: file.sha256 });
  }
  const audio = path.join(directory, 'jfk.wav');
  await downloadVerified({ url: 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5454/samples/jfk.wav', destination: audio, expectedSize: 352078, sha256: '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e' });
  const worker = new LiveParakeetTranscriber({ app: { isPackaged: false, getAppPath: () => path.resolve('.') }, modelPath: model });
  const timeout = setTimeout(() => { console.error('Parakeet inference timed out'); worker.child?.kill(); process.exitCode = 1; }, 180000);
  try {
    await worker.start();
    const pcm = wavToSamples(await fs.readFile(audio));
    assert.equal(pcm.rate, 16000);
    const text = (await worker.transcribe(pcm.samples)).replace(/\s+/g, ' ');
    assert.match(text, /ask not what your country can do for you/i);
    assert.match(text, /what you can do for your country/i);
    console.log(JSON.stringify({ windowsParakeet: 'passed', model: entry.id, binaryChecksumsVerified: true, speechRecognized: true }));
  } finally { clearTimeout(timeout); await worker.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
