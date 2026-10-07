const test=require('node:test');const assert=require('node:assert/strict');const {Updater}=require('../src/updater');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(beforeInstall){const calls=[];const updater=new Updater({app:{isPackaged:true,getVersion:()=> '1.0'},autoUpdater:{quitAndInstall:(...args)=>calls.push(args)},beforeInstall,log:{error(){}}});updater.state.state='ready';return {updater,calls};}
test('installer waits for provider shutdown and repeated preparation shares one drain',async()=>{
 let finish,count=0;const f=fixture(async()=>{count++;await new Promise(resolve=>finish=resolve);});const installing=f.updater.install();const preparation=f.updater.prepareInstall();await tick();assert.equal(count,1);assert.deepEqual(f.calls,[]);finish();assert.equal(await installing,true);assert.equal(await preparation,true);await tick();assert.deepEqual(f.calls,[[false,true]]);assert.equal(f.updater.installPrepared,true);
});
test('failed provider shutdown leaves the download ready and prevents installation until retry succeeds',async()=>{
 let fail=true;const f=fixture(async()=>{if(fail)throw new Error('still running');});assert.equal(await f.updater.install(),false);await tick();assert.deepEqual(f.calls,[]);assert.equal(f.updater.state.state,'ready');assert.equal(f.updater.installPrepared,false);fail=false;assert.equal(await f.updater.install(),true);await tick();assert.equal(f.calls.length,1);
});
test('no downloaded update never initiates provider shutdown',async()=>{
 let calls=0;const f=fixture(async()=>calls++);f.updater.state.state='idle';assert.equal(await f.updater.install(),false);assert.equal(await f.updater.prepareInstall(),false);assert.equal(calls,0);
});
