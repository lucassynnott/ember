const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const extract = require('extract-zip');
const VERSION = 'b11454';
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${VERSION}/llama-${VERSION}-bin-win-cpu-x64.zip`;
const SHA256 = '41e4910dbf94d1d67bc951e3a04f5761be1953eb79c001e4aabe4ac1bccbdf6c';
async function provision() {
  const root = path.resolve(__dirname,'../native/windows/bin');
  await fs.mkdir(root,{recursive:true});
  const staging=await fs.mkdtemp(path.join(root,'.llama-'));
  try {
    const response=await fetch(URL);
    if (!response.ok) throw new Error(`llama.cpp download: HTTP ${response.status}`);
    const bytes=Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex')!==SHA256) throw new Error('llama.cpp archive checksum mismatch');
    const archive=path.join(staging,'runtime.zip');
    await fs.writeFile(archive,bytes);
    const output=path.join(staging,'runtime');
    await extract(archive,{dir:output});
    await fs.access(path.join(output,'llama-server.exe'));
    const licenseResponse=await fetch(`https://raw.githubusercontent.com/ggml-org/llama.cpp/${VERSION}/LICENSE`);
    if (!licenseResponse.ok) throw new Error(`llama.cpp license: HTTP ${licenseResponse.status}`);
    const license=Buffer.from(await licenseResponse.arrayBuffer());
    if (crypto.createHash('sha256').update(license).digest('hex')!=='94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d') throw new Error('llama.cpp license checksum mismatch');
    await fs.writeFile(path.join(output,'LICENSE'),license);
    for (const name of await fs.readdir(output)) {
      if (name.endsWith('.exe') && name!=='llama-server.exe') await fs.rm(path.join(output,name));
    }

    await fs.writeFile(path.join(output,'ember-source.txt'),`llama.cpp ${VERSION}\n${URL}\nSHA256 ${SHA256}\nSource: https://github.com/ggml-org/llama.cpp/tree/${VERSION}\n`);
    const target=path.join(root,'llama');
    await fs.rm(target,{recursive:true,force:true});
    await fs.rename(output,target);
    console.log(`Verified Windows llama.cpp ${VERSION}`);
  } finally { await fs.rm(staging,{recursive:true,force:true}); }
}
if (require.main===module) provision().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={provision,VERSION,URL,SHA256};
