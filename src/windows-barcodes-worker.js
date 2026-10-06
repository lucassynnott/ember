const {parentPort,workerData}=require('node:worker_threads');
parentPort.postMessage(require('./windows-barcodes').decodeBarcodes(workerData));
