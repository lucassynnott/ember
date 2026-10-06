// Pinned upstream FFmpeg binaries. Preserve their license and build/source notes.
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createGunzip } = require("node:zlib");
const destination = path.resolve(__dirname, "../native/windows/bin");
const base = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1";
const files = [
  ["ffmpeg-win32-x64.gz", "ffmpeg.exe", "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77", "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00"],
  ["ffprobe-win32-x64.gz", "ffprobe.exe", "f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d", "3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4"],
  ["win32-x64.LICENSE", "FFmpeg.LICENSE", "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"],
  ["win32-x64.README", "FFmpeg.README", "a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311"],
];
async function hash(file) {
  const sum = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) sum.update(chunk);
  return sum.digest("hex");
}
async function provision() {
  await fsp.mkdir(destination, { recursive: true });
  for (const [asset, name, checksum, outputChecksum] of files) {
    const target = path.join(destination, name);
    if (fs.existsSync(target) && await hash(target) === (outputChecksum || checksum)) continue;
    const part = `${target}.part`;
    try {
      const response = await fetch(`${base}/${asset}`);
      if (!response.ok || !response.body) throw new Error(`Download ${asset}: HTTP ${response.status}`);
      const sum = crypto.createHash("sha256");
      const measure = new Transform({ transform(chunk, _encoding, done) { sum.update(chunk); done(null, chunk); } });
      const streams = [Readable.fromWeb(response.body), measure];
      if (asset.endsWith(".gz")) streams.push(createGunzip());
      streams.push(fs.createWriteStream(part, { mode: 0o700 }));
      await pipeline(...streams);
      if (sum.digest("hex") !== checksum || await hash(part) !== (outputChecksum || checksum)) throw new Error(`Checksum mismatch: ${asset}`);
      await fsp.rename(part, target);
      console.log(`Verified ${name}`);
    } finally { await fsp.rm(part, { force: true }); }
  }
}
if (require.main === module) provision().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { provision };
