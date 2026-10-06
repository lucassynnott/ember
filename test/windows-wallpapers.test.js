const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { wallpaperSources, windowsWallpapers } = require('../src/windows-wallpapers');
const { runCommand } = require('../src/transcription');
const { probe } = require('../src/windows-record-tools');
test('Windows wallpaper discovery and cached full/thumbnail JPEG conversion', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'ember-wallpapers-'));
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
  const ffprobe = process.env.FFPROBE_BIN || (process.platform === 'win32' ? path.join(path.dirname(ffmpeg),'ffprobe.exe') : 'ffprobe');
  try {
    const root = path.join(temporary,'Web','Wallpaper'), nested = path.join(root,'Theme');
    await fs.mkdir(nested,{recursive:true});
    const source = path.join(nested,'Landscape.png');
    await runCommand(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=800x400','-frames:v','1',source]);
    await fs.writeFile(path.join(nested,'readme.txt'),'ignored');
    assert.deepEqual(await wallpaperSources(root),[source]);
    const directory = path.join(temporary,'cache');
    const warnings=[];
    const first = await windowsWallpapers({root,directory,ffmpeg,warn:(...args)=>warnings.push(args)});
    assert.equal(first.length,1);assert.equal(first[0].label,'Landscape');assert.equal(warnings.length,0);
    const full = path.join(directory,first[0].id+'.jpg');
    const thumb = path.join(directory,first[0].id+'.thumb.jpg');
    const metadata = await probe(ffprobe,thumb);
    assert.equal(metadata.streams[0].width,360);assert.equal(metadata.streams[0].height,180);
    const before = (await fs.stat(full)).mtimeMs;
    assert.deepEqual(await windowsWallpapers({root,directory,ffmpeg:'missing-tool'}),first);
    assert.equal((await fs.stat(full)).mtimeMs,before,'cached wallpaper does not require converter');
    assert.deepEqual(await wallpaperSources(path.join(temporary,'missing')),[]);
  } finally { await fs.rm(temporary,{recursive:true,force:true}); }
});
