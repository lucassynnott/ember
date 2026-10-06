const { app, protocol, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const { WindowsExport } = require('../src/windows-export');
const { runCommand } = require('../src/transcription');
const { probe } = require('../src/windows-record-tools');
protocol.registerSchemesAsPrivileged([{ scheme: 'ember-export', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.on('window-all-closed', () => {});
let directory;
const timer = setTimeout(() => { console.error('Export acceptance timed out'); app.exit(1); }, 60000);
function resultOf(child, cancel = false) {
  return new Promise((resolve, reject) => {
    let buffer = '', result;
    child.stdout.on('data', bytes => {
      buffer += bytes; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.type === 'progress' && cancel) child.stdin.write('cancel\n');
        if (['done', 'cancelled', 'error'].includes(message.type)) result = message;
      }
    });
    child.once('close', () => result?.type === 'error' ? reject(new Error(result.message)) : result ? resolve(result) : reject(new Error('Missing export result')));
  });
}
app.whenReady().then(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-export-acceptance-'));
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg', ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
  const source = path.join(directory, 'source.mp4');
  await runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  const backend = new WindowsExport({ electron: require('electron'), rendererDir: path.resolve(__dirname, '../renderer/dist'), getFfmpeg: () => ffmpeg, getFfprobe: () => ffprobe });
  const base = { width: 200, height: 120, fps: 30, clips: [[0.1,0.5,1,0],[0.6,1,2,0]], content:[20,15,160,90], view:[[0,0,0,160,90],[0.6,0,0,160,90]], audio: {volume:0.7}, sprites:[] };
  const specFile = path.join(directory, 'spec.json');
  const exportFile = async (name, spec, cancel = false) => {
    await fs.writeFile(specFile, JSON.stringify(spec));
    return resultOf(backend.start(['export','--source',source,'--spec',specFile,'--out',path.join(directory,name)]), cancel);
  };
  const mp4 = await exportFile('export.mp4', base);
  assert.equal(mp4.type, 'done'); assert.equal(mp4.width, 200); assert.equal(mp4.height, 120);
  const info = await probe(ffprobe, mp4.file);
  assert.ok(Math.abs(Number(info.format.duration)-0.6)<0.1, `duration=${info.format.duration}`);
  assert.ok(info.streams.some(stream => stream.codec_type === 'audio'));
  await runCommand(ffmpeg, ['-v','error','-i',mp4.file,'-f','null','-']);
  const decode = async (file, filter) => (await exec(ffmpeg, ['-v','error','-i',file,...(filter ? ['-vf',filter] : []),'-an','-fps_mode','passthrough','-f','rawvideo','-pix_fmt','rgb24','-'], {encoding:'buffer',maxBuffer:4e6})).stdout;
  const expected = await decode(source, 'select=' + [...Array.from({length:12},(_,i)=>i+3),18,20,22,24,26,28].map(n=>`eq(n\\,${n})`).join('+'));
  const actual = await decode(mp4.file);
  assert.equal(actual.length, 18 * 200 * 120 * 3, 'exact output frame count');
  assert.equal(expected.length, 18 * 160 * 90 * 3);
  let worstFrameError = 0;
  for (let frame = 0; frame < 18; frame++) {
    let difference = 0;
    for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) for (let channel = 0; channel < 3; channel++) {
      difference += Math.abs(expected[(frame * 160 * 90 + y * 160 + x) * 3 + channel] - actual[(frame * 200 * 120 + (y + 15) * 200 + x + 20) * 3 + channel]);
    }
    worstFrameError = Math.max(worstFrameError, difference / (160 * 90 * 3));
  }
  assert.ok(worstFrameError < 15, `cut/seek/speed frame comparison error=${worstFrameError}`);
  const gif = await exportFile('export.gif', {...base, gif:{fps:5,width:100,loop:true}});
  assert.equal(gif.type,'done'); assert.equal(gif.width,100);
  await runCommand(ffmpeg, ['-v','error','-i',gif.file,'-f','null','-']);
  const cancel = await exportFile('cancelled.mp4', {...base, clips:[[0,1,0.2,0]],view:[[0,0,0,160,90],[5,0,0,160,90]]}, true);
  assert.equal(cancel.type,'cancelled');
  await assert.rejects(fs.stat(path.join(directory,'cancelled.mp4')), {code:'ENOENT'});
  assert.equal(BrowserWindow.getAllWindows().length,0);
  assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('.export-')));
  const result={windowsExport:'passed',mp4:{duration:mp4.duration,width:mp4.width,height:mp4.height},gif:{width:gif.width,height:gif.height},cancellation:'passed',frameComparison:{frames:18,worstMeanError:worstFrameError}};
  if (process.env.EMBER_EXPORT_MEDIA_RESULT) await fs.writeFile(process.env.EMBER_EXPORT_MEDIA_RESULT,JSON.stringify(result));
  console.log(JSON.stringify(result)); clearTimeout(timer); await fs.rm(directory,{recursive:true,force:true}); app.exit(0);
}).catch(async error => {console.error(error.stack);clearTimeout(timer);if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});app.exit(1)});
