const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ModelManager, downloadVerified } = require('../src/model-manager');
const { venvExecutable } = require('../src/platform');
const { LivePhononTranscriber } = require('../src/phonon-transcription');
const { wavToSamples } = require('../src/recordings');
(async () => {
  assert.equal(process.platform,'win32');
  const directory=path.resolve('.windows-tools/phonon-acceptance');
  const venv=path.join(directory,'venv');
  const manager=new ModelManager({supportDir:directory,phononVenv:venv});
  manager.on('progress',event=>console.log(JSON.stringify({phononInstall:event.state,message:event.message})));
  await manager.install('phonon-2');
  const audio=path.join(directory,'jfk.wav');
  await downloadVerified({url:'https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5454/samples/jfk.wav',destination:audio,expectedSize:352078,sha256:'59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e'});
  const transcriber=new LivePhononTranscriber({binaryPath:venvExecutable(venv,'fermion')});
  try {
    await transcriber.start();
    const pcm=wavToSamples(await fs.readFile(audio));assert.equal(pcm.rate,16000);
    const text=(await transcriber.transcribe(pcm.samples)).replace(/\s+/g,' ');
    assert.match(text,/ask not what your country can do for you/i);
    assert.match(text,/what you can do for your country/i);
    console.log(JSON.stringify({windowsPhonon:'passed',runtime:'CPU',authenticatedLoopback:true,speechRecognized:true}));
  } finally {await transcriber.stop();}
})().catch(error=>{console.error(error);process.exitCode=1;});
