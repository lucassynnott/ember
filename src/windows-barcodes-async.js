const path=require('node:path');
const {Worker}=require('node:worker_threads');
function decodeBarcodesAsync(image) {
  const file=path.join(__dirname,'windows-barcodes-worker.js').replace(/app\.asar([\\/])/,'app.asar.unpacked$1');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(file,{workerData:image});
    let settled=false;
    const timer=setTimeout(()=>{settled=true;void worker.terminate();reject(new Error('Barcode reading took too long. Try a smaller area.'));},30000);
    worker.once('message',codes=>{settled=true;clearTimeout(timer);resolve(codes);});
    worker.once('error',error=>{settled=true;clearTimeout(timer);reject(error);});
    worker.once('exit',code=>{clearTimeout(timer);if(!settled)reject(new Error(`Barcode reader exited without a result (${code}).`));});
  });
}
module.exports={decodeBarcodesAsync};
