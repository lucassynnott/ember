const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runCommand } = require('./transcription');
async function wallpaperSources(root, depth = 0) {
  if (depth > 4) return [];
  const entries = await fs.readdir(root, {withFileTypes:true}).catch(error => {
    if (['ENOENT','EACCES','EPERM'].includes(error.code)) return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await wallpaperSources(file, depth + 1));
    else if (entry.isFile() && /\.(jpe?g|png|webp)$/i.test(entry.name)) files.push(file);
  }
  return files.sort();
}
async function exists(file) { try { return (await fs.stat(file)).size > 0; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function jpeg(ffmpeg, source, target, size) {
  if (await exists(target)) return;
  const temporary = `${target}.${crypto.randomUUID()}.tmp.jpg`;
  try {
    await runCommand(ffmpeg, ['-nostdin','-v','error','-i',source,'-frames:v','1','-vf',`scale=w='min(${size},iw)':h='min(${size},ih)':force_original_aspect_ratio=decrease`,'-q:v','3','-y',temporary]);
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, {force:true}); }
}
async function windowsWallpapers({ directory, ffmpeg, root = path.join(process.env.SystemRoot || 'C:\\Windows', 'Web', 'Wallpaper'), warn = console.warn }) {
  await fs.mkdir(directory, {recursive:true});
  const wallpapers = [];
  for (const source of await wallpaperSources(root)) {
    const label = path.basename(source, path.extname(source));
    const slug = label.toLowerCase().replace(/[^\w]+/g,'-').replace(/^-|-$/g,'') || 'wallpaper';
    const id = `${slug}-${crypto.createHash('sha256').update(source).digest('hex').slice(0,12)}`;
    try {
      const full = path.join(directory, `${id}.jpg`), thumb = path.join(directory, `${id}.thumb.jpg`);
      await jpeg(ffmpeg, source, full, 3200);
      await jpeg(ffmpeg, full, thumb, 360);
      wallpapers.push({id,label,url:`ember-media://wallpaper/${id}/image`,thumb:`ember-media://wallpaper/${id}/thumb`});
    } catch (error) { warn('Wallpaper:', label, error.message); }
  }
  return wallpapers;
}
module.exports = {wallpaperSources, windowsWallpapers};
