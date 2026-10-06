const path = require('node:path');
const { createWorker } = require('tesseract.js');
function physical(file) { return file.replace(/app\.asar([\\/])/,'app.asar.unpacked$1'); }
class WindowsOcr {
  constructor({decodeImage=null}={}) { this.decodeImage=decodeImage;this.worker=null;this.pending=Promise.resolve();this.closed=false; }
  read(image) {
    if (this.closed) return Promise.reject(new Error('Screen text reader is closed.'));
    const operation=this.pending.then(async()=>{
      const barcodeImage=this.decodeImage ? await this.decodeImage(image) : null;
      this.worker ||= createWorker('eng',1,{
        langPath:physical(path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')),'4.0.0_best_int')),
        corePath:physical(path.dirname(require.resolve('tesseract.js-core/package.json'))),
        workerPath:physical(require.resolve('tesseract.js/src/worker-script/node/index.js')),
        cacheMethod:'none',gzip:true,
      });
      const codesPromise=barcodeImage ? require('./windows-barcodes-async').decodeBarcodesAsync(barcodeImage) : Promise.resolve([]);
      const dataPromise=this.worker.then(worker=>worker.recognize(image,{}, {text:true,blocks:true}));
      const [{data},codes]=await Promise.all([dataPromise,codesPromise]);
      const lines=[];
      for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) for (const line of paragraph.lines || []) {
        const box=line.bbox;
        if (box && line.text.trim()) lines.push({text:line.text.trim(),x:box.x0,y:box.y0,w:box.x1-box.x0,h:box.y1-box.y0});
      }
      return {lines,codes};
    });
    this.pending=operation.catch(()=>{});
    return operation;
  }
  async close() { this.closed=true;await this.pending; if(this.worker) await (await this.worker).terminate();this.worker=null; }
}
module.exports={WindowsOcr};
