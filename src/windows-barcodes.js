const {MultiFormatReader,RGBLuminanceSource,BinaryBitmap,HybridBinarizer,DecodeHintType,BarcodeFormat,NotFoundException,ChecksumException,FormatException}=require('@zxing/library');
function decodeBarcodes({bitmap,width,height}) {
  if (!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||bitmap.length!==width*height*4) throw new Error('Invalid barcode image dimensions.');
  const gray=new Uint8ClampedArray(width*height);
  for(let index=0;index<gray.length;index++) {
    const offset=index*4;
    gray[index]=Math.min(255,((bitmap[offset+2]+2*bitmap[offset+1]+bitmap[offset])>>2)+255-bitmap[offset+3]);
  }
  const hints=new Map([[DecodeHintType.TRY_HARDER,true]]),reader=new MultiFormatReader(),codes=[],seen=new Set();
  let scans=0;
  function scan(source,depth=0) {
    if(depth>4||codes.length>=16||++scans>64) return;
    let result;
    try { result=reader.decode(new BinaryBitmap(new HybridBinarizer(source)),hints); }
    catch(error) {
      if (!(error instanceof NotFoundException || error instanceof ChecksumException || error instanceof FormatException)) throw error;
      const w=source.getWidth(),h=source.getHeight();
      // Several QR finder patterns can prevent a whole-image decode. Overlapping
      // tiles isolate codes while retaining their quiet zones across boundaries.
      if(w>=h && w>240) {
        const slice=Math.ceil(w*0.75);
        scan(source.crop(0,0,slice,h),depth+1);
        scan(source.crop(w-slice,0,slice,h),depth+1);
      } else if(h>240) {
        const slice=Math.ceil(h*0.75);
        scan(source.crop(0,0,w,slice),depth+1);
        scan(source.crop(0,h-slice,w,slice),depth+1);
      }
      return;
    }
    const payload=result.getText(),format=result.getBarcodeFormat(),identity=`${format}:${payload}`;
    if(!seen.has(identity)) {seen.add(identity);codes.push({kind:format===BarcodeFormat.QR_CODE?'qr':BarcodeFormat[format].toLowerCase().replace(/_/g,'-'),payload});}
    const points=result.getResultPoints()||[];
    if(!points.length) return;
    const x0=Math.floor(Math.min(...points.map(point=>point.getX()))),x1=Math.ceil(Math.max(...points.map(point=>point.getX())));
    const y0=Math.floor(Math.min(...points.map(point=>point.getY()))),y1=Math.ceil(Math.max(...points.map(point=>point.getY())));
    const w=source.getWidth(),h=source.getHeight();
    if(x0>80) scan(source.crop(0,0,x0,h),depth+1);
    if(y0>80) scan(source.crop(0,0,w,y0),depth+1);
    if(w-x1>80) scan(source.crop(x1,0,w-x1,h),depth+1);
    if(h-y1>80) scan(source.crop(0,y1,w,h-y1),depth+1);
  }
  scan(new RGBLuminanceSource(gray,width,height));
  return codes;
}
module.exports={decodeBarcodes};
