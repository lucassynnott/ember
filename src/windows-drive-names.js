const crypto=require('node:crypto');
const RESERVED=/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i;
// Escape with UTF-16 units, preserving ordinary Unicode names and extensions.
// The remote key stays in file identity; a displayed name never becomes an S3 key.
function windowsName(value) {
  if(typeof value!=='string'||value.includes('/'))throw new Error('Expected one remote name component.');
  if(value==='')return '~empty';
  let name='';
  for(let index=0;index<value.length;index++){
    const char=value[index],code=value.charCodeAt(index);
    const escape=code<32||/[<>:"\\|?*~]/.test(char)||((char==='.'||char===' ')&&/^\.* *$/.test(value.slice(index)))||((code>=0xD800&&code<=0xDBFF)&&!(value.charCodeAt(index+1)>=0xDC00&&value.charCodeAt(index+1)<=0xDFFF))||((code>=0xDC00&&code<=0xDFFF)&&!(value.charCodeAt(index-1)>=0xD800&&value.charCodeAt(index-1)<=0xDBFF));
    name+=escape?'~'+code.toString(16).padStart(4,'0'):char;
  }
  if(RESERVED.test(name))name='~005f'+name;
  if(name.length>230)name=truncate(name,200)+'~'+digest(value);
  return name;
}
function truncate(value,length){let output=value.slice(0,length);if(/[\uD800-\uDBFF]$/.test(output))output=output.slice(0,-1);return output;}
function digest(value){return crypto.createHash('sha256').update(value).digest('hex').slice(0,16);}
function fold(value){return value.toUpperCase();}
function validLocal(value){return typeof value==='string'&&value.length>0&&value.length<=255&&!/[\x00-\x1f<>:"/\\|?*]/.test(value)&&!/[. ]$/.test(value)&&!RESERVED.test(value)&&value!=='.'&&value!=='..';}
// Existing mappings are persisted by the caller. Later case collisions keep the
// already materialized local name and assign a suffix to the newly discovered key.
function mapDirectory(components,existing={}) {
  const result=new Map(),used=new Set(),entries=new Map();
  for(const component of components){const id=typeof component==='string'?component:component.id,name=typeof component==='string'?component:component.name;if(typeof id!=='string'||typeof name!=='string')throw new Error('Invalid Drive name entry.');if(entries.has(id)&&entries.get(id)!==name)throw new Error('Conflicting Drive name identities.');entries.set(id,name);}
  for(const remote of [...entries.keys()].sort()){
    const local=Object.prototype.hasOwnProperty.call(existing,remote)?existing[remote]:null;
    if(local!=null){if(!validLocal(local)||used.has(fold(local)))throw new Error('Invalid persisted Drive name mapping.');used.add(fold(local));result.set(remote,local);}
  }
  for(const remote of [...entries.keys()].sort()){
    if(result.has(remote))continue;
    const base=windowsName(entries.get(remote));let local=base;
    if(used.has(fold(local)))local=truncate(base,220)+'~'+digest(remote);
    let sequence=0;while(used.has(fold(local))){if(++sequence>10000)throw new Error('Drive filename collision limit exceeded.');local=truncate(base,210)+'~'+digest(remote)+'-'+sequence;}
    if(!validLocal(local))throw new Error('Remote name could not be represented on Windows.');
    used.add(fold(local));result.set(remote,local);
  }
  return result;
}
module.exports={windowsName,mapDirectory,validLocal};
