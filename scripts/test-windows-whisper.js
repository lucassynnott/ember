const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {CATALOG,downloadVerified} = require('../src/model-manager');
const {transcribeLocally} = require('../src/transcription');
async function main() {
  assert.equal(process.platform,'win32','Whisper acceptance requires Windows');
  const entry=CATALOG.find(entry=>entry.id==='whisper-base-en');
  const file=entry.install.files[0];
  const directory=path.resolve('.windows-tools/whisper-acceptance');
  await fs.mkdir(directory,{recursive:true});
  const model=path.join(directory,file.name),audio=path.join(directory,'jfk.wav');
  await downloadVerified({url:`https://huggingface.co/${entry.install.repo}/resolve/${entry.install.revision}/${file.name}`,destination:model,expectedSize:file.size,sha256:file.sha256});
  await downloadVerified({url:'https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5454/samples/jfk.wav',destination:audio,expectedSize:352078,sha256:'59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e'});
  const text=await transcribeLocally(audio,{whisperBinary:path.resolve('native/windows/bin/whisper/whisper-cli.exe'),whisperModel:model,ffmpegBinary:path.resolve('native/windows/bin/ffmpeg.exe')});
  assert.match(text,/ask not what your country can do for you/i);
  assert.match(text,/what you can do for your country/i);
  for (const suffix of ['.16khz.wav','.transcript.txt']) {
    await assert.rejects(fs.stat(audio+suffix),{code:'ENOENT'});
  }
  console.log(JSON.stringify({windowsWhisper:'passed',model:entry.id,checksumVerified:true,speechRecognized:true,temporaryFilesRemoved:true}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
