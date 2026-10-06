const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { LivePhononTranscriber, encodeWav, findFermionBinary } = require("../src/phonon-transcription");

test("encodes 16 kHz mono float PCM as a WAV file", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1]);
  const wav = encodeWav(samples);
  assert.equal(wav.length, 44 + samples.length * 4);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 3);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readFloatLE(44 + 4), 0.5);
});

function speechSamples(sentence) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonon-test-"));
  const aiff = path.join(directory, "speech.aiff");
  const raw = path.join(directory, "speech.caf");
  spawnSync("say", ["-o", aiff, sentence]);
  spawnSync("afconvert", ["-f", "caff", "-d", "LEF32@16000", "-c", "1", aiff, raw]);
  const data = fs.readFileSync(raw);
  const offset = data.indexOf("data") + 16; // CAF data chunk: size (8) + edit count (4)
  const bytes = data.subarray(offset);
  fs.rmSync(directory, { recursive: true, force: true });
  const samples = new Float32Array(bytes.length / 4);
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readFloatLE(index * 4);
  return samples;
}

test("transcribes live segments through a local Phonon-2 server", async (t) => {
  const binaryPath = await findFermionBinary();
  if (process.platform !== "darwin" || !binaryPath) {
    t.skip("Phonon-2 runtime is not installed; run npm run setup:local");
    return;
  }
  const transcriber = new LivePhononTranscriber({ binaryPath });
  try {
    await transcriber.start();
    const text = await transcriber.transcribe(speechSamples("The budget review moves to Thursday afternoon."));
    assert.match(text.toLowerCase(), /budget review/);
    assert.match(text.toLowerCase(), /thursday/);
  } finally {
    await transcriber.stop();
  }
  assert.equal(fs.existsSync(transcriber.socketPath), false);
});

test('Windows Phonon uses an authenticated loopback server and preserves PCM transport', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'phonon-loopback-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const fixture=path.join(directory,'server.cjs');
  fs.writeFileSync(fixture,`const http=require('node:http');const args=process.argv;const value=name=>args[args.indexOf(name)+1];const key=value('--api-key');http.createServer((request,response)=>{if(request.headers.authorization!=='Bearer '+key){response.writeHead(401);response.end('{}');return;}if(request.url==='/health'){response.end(JSON.stringify({status:'ok'}));return;}const chunks=[];request.on('data',bytes=>chunks.push(bytes));request.on('end',()=>{const body=Buffer.concat(chunks);if(!body.includes(Buffer.from('WAVE'))){response.writeHead(400);response.end('{}');return;}response.end(JSON.stringify({text:'Windows microphone segment'}));});}).listen(Number(value('--port')),value('--host'));`);
  let argumentsUsed;
  let spawned = 0;
  const transcriber=new LivePhononTranscriber({binaryPath:'fixture',platform:'win32',spawnProcess:(_binary,args,options)=>{spawned++;argumentsUsed=args;return require('node:child_process').spawn(process.execPath,[fixture,...args],options);}});
  try {
    const first = transcriber.start();
    const second = transcriber.start();
    assert.equal(first, second, 'concurrent starts must await the same readiness operation');
    await Promise.all([first, second]);
    assert.equal(spawned, 1, 'concurrent starts must launch only one server');
    assert.ok(argumentsUsed.includes('--api-key'));
    assert.ok(!argumentsUsed.includes('--unix-socket'));
    assert.equal(transcriber.transport.host,'127.0.0.1');
    const unauthorized=await fetch(`http://127.0.0.1:${transcriber.transport.port}/health`);
    assert.equal(unauthorized.status,401);
    assert.equal(await transcriber.transcribe(new Float32Array([0,0.5,-0.5])), 'Windows microphone segment');
  } finally { await transcriber.stop(); }
  assert.equal(transcriber.child,null);
  await assert.rejects(fetch(`http://127.0.0.1:${transcriber.transport.port}/health`));
});

test('A Phonon server that exits cleanly before readiness fails promptly', {timeout:5000}, async () => {
  const transcriber=new LivePhononTranscriber({binaryPath:'fixture',platform:'win32',spawnProcess:(_binary,_args,options)=>require('node:child_process').spawn(process.execPath,['-e','process.exit(0)'],options)});
  try {await assert.rejects(transcriber.start(),/exited with code 0/);}
  finally {await transcriber.stop();}
});


test('Stopping concurrent Phonon startup rejects both callers and leaves no server', {timeout:5000}, async () => {
  let spawnedResolve;
  const spawned = new Promise(resolve => { spawnedResolve = resolve; });
  const transcriber = new LivePhononTranscriber({binaryPath:'fixture',platform:'win32',spawnProcess:(_binary,_args,options)=>{
    const child = require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);
    spawnedResolve(child);
    return child;
  }});
  const first = transcriber.start();
  const second = transcriber.start();
  // Install rejection handlers before stop to avoid unhandled rejections.
  const failures = Promise.all([assert.rejects(first,/startup cancelled/),assert.rejects(second,/startup cancelled/)]);
  const child = await spawned;
  await transcriber.stop();
  await failures;
  assert.equal(transcriber.child,null);
  assert.equal(transcriber.startPromise,null);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
