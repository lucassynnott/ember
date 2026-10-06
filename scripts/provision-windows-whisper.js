const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const extract = require('extract-zip');
const VERSION = 'b5454';
const URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}/whisper-bin-x64.zip`;
const SHA256 = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb';
async function provision() {
  const root = path.resolve(__dirname,'../native/windows/bin');
  await fs.mkdir(root,{recursive:true});
  const staging=await fs.mkdtemp(path.join(root,'.whisper-'));
  try {
    const response=await fetch(URL);
    if (!response.ok) throw new Error(`whisper.cpp download: HTTP ${response.status}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex')!==SHA256) throw new Error('whisper.cpp archive checksum mismatch');
    const archive=path.join(staging,'runtime.zip');
    await fs.writeFile(archive,bytes);
    const extracted=path.join(staging,'runtime');
    await extract(archive,{dir:extracted});
    const locate = async folder => {
      for (const entry of await fs.readdir(folder,{withFileTypes:true})) {
        if (entry.isFile() && entry.name==='whisper-cli.exe') return folder;
        if (entry.isDirectory()) { const found=await locate(path.join(folder,entry.name)); if(found) return found; }
      }
      return null;
    };
    const output=await locate(extracted);
    if (!output) throw new Error('Whisper archive is missing whisper-cli.exe');
    await fs.access(path.join(output,'whisper-cli.exe'));
    const licenseResponse=await fetch(`https://raw.githubusercontent.com/ggml-org/whisper.cpp/${VERSION}/LICENSE`);
    if (!licenseResponse.ok) throw new Error(`whisper.cpp license: HTTP ${licenseResponse.status}`);
    const license=Buffer.from(await licenseResponse.arrayBuffer());
    if (crypto.createHash('sha256').update(license).digest('hex')!=='94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d') throw new Error('whisper.cpp license checksum mismatch');
    await fs.writeFile(path.join(output,'LICENSE'),license);
    for (const name of await fs.readdir(output)) {
      if (name.endsWith('.exe') && name!=='whisper-cli.exe') await fs.rm(path.join(output,name));
    }

    await fs.writeFile(path.join(output,'ember-source.txt'),`whisper.cpp ${VERSION}\n${URL}\nSHA256 ${SHA256}\nSource: https://github.com/ggml-org/whisper.cpp/tree/${VERSION}\n`);
    const target=path.join(root,'whisper');
    await fs.rm(target,{recursive:true,force:true});
    await fs.rename(output,target);
    console.log(`Verified Windows whisper.cpp ${VERSION}`);
  } finally { await fs.rm(staging,{recursive:true,force:true}); }
}
if (require.main===module) provision().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={provision,VERSION,URL,SHA256};
