const http=require('node:http');const crypto=require('node:crypto');
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
async function cloudFixture(initial={}){
  const objects=new Map(),requests=[];let sequence=0;
  const put=(key,data)=>objects.set(key,{data:Buffer.from(data),etag:'"'+crypto.createHash('md5').update(data).digest('hex')+'"',modified:new Date()});
  for(const [key,data] of Object.entries(initial))put(key,data);
  const server=http.createServer(async(req,res)=>{
    try{
      requests.push({method:req.method,url:req.url,range:req.headers.range});if(requests.length>1000)throw new Error('Fixture request limit exceeded');
      if(!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=fixture-key/')){res.statusCode=403;res.end();return;}
      const url=new URL(req.url,'http://localhost'),key=decodeURIComponent(url.pathname.slice('/fixture-bucket/'.length));
      if(!url.pathname.startsWith('/fixture-bucket/')){res.statusCode=404;res.end();return;}
      if(req.method==='GET'&&url.searchParams.get('list-type')==='2'){
        const entries=[...objects].filter(([key])=>key.startsWith(url.searchParams.get('prefix')||''));
        res.setHeader('Content-Type','application/xml');res.end('<ListBucketResult><IsTruncated>false</IsTruncated>'+entries.map(([key,item])=>`<Contents><Key>${xml(key)}</Key><LastModified>${item.modified.toISOString()}</LastModified><ETag>${xml(item.etag)}</ETag><Size>${item.data.length}</Size></Contents>`).join('')+'</ListBucketResult>');return;
      }
      const existing=objects.get(key);
      if(req.headers['if-match']&&existing?.etag!==req.headers['if-match']||req.headers['if-none-match']==='*'&&existing){res.statusCode=412;res.end();return;}
      if(req.method==='PUT'){
        const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>16*1024*1024)throw new Error('Fixture upload limit exceeded');chunks.push(chunk);}
        put(key,Buffer.concat(chunks));sequence++;res.setHeader('ETag',objects.get(key).etag);res.end();return;
      }
      if(req.method==='DELETE'){objects.delete(key);res.statusCode=204;res.end();return;}
      if(!existing){res.statusCode=404;res.end();return;}
      res.setHeader('ETag',existing.etag);res.setHeader('Last-Modified',existing.modified.toUTCString());res.setHeader('Content-Type','application/octet-stream');
      if(req.method==='HEAD'){res.setHeader('Content-Length',existing.data.length);res.end();return;}
      if(req.method==='GET'){
        const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
        if(!match){res.setHeader('Content-Length',existing.data.length);res.end(existing.data);return;}
        const start=Number(match[1]),end=Math.min(Number(match[2]),existing.data.length-1);
        if(start>end||start>=existing.data.length){res.statusCode=416;res.end();return;}
        res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${existing.data.length}`);res.setHeader('Content-Length',end-start+1);res.end(existing.data.subarray(start,end+1));return;
      }
      res.statusCode=405;res.end();
    }catch(error){res.statusCode=500;res.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {objects,requests,get writes(){return sequence;},config:{provider:'custom',endpoint:`http://127.0.0.1:${server.address().port}`,keyID:'fixture-key',applicationKey:'fixture-secret',bucketName:'fixture-bucket'},async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
module.exports={cloudFixture};
