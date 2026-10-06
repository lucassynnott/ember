const test=require('node:test');const assert=require('node:assert/strict');
const {windowsName,mapDirectory}=require('../src/windows-drive-names');
test('remote Windows-invalid components stay distinct and ordinary Unicode names survive',()=>{
  assert.equal(windowsName('Café budget.txt'),'Café budget.txt');
  for(const name of ['CON.txt','LPT¹','..','trailing.','space ','a:b','a\\b','literal~003a','\u0001','unpaired\ud800'])assert.doesNotMatch(windowsName(name),/[<>:"\\|?*\x00-\x1f]|[. ]$/);
  assert.notEqual(windowsName('a:b'),windowsName('a~003ab'));
  assert.ok(windowsName('😀'.repeat(200)+'.txt').length<=230);
  assert.throws(()=>windowsName('../file'),/one remote name/);
});
test('case collisions are deterministic and persisted filenames remain stable',()=>{
  const names=['Notes.txt','notes.txt','NOTES.TXT','notes.txt'];
  const initial=mapDirectory(names);assert.equal(new Set([...initial.values()].map(v=>v.toUpperCase())).size,3);
  assert.deepEqual([...initial],[...mapDirectory(names.reverse())]);
  const prior=Object.fromEntries(mapDirectory(['notes.txt']));
  const extended=mapDirectory(['Notes.txt','notes.txt'],prior);assert.equal(extended.get('notes.txt'),'notes.txt');assert.notEqual(extended.get('Notes.txt').toUpperCase(),'NOTES.TXT');
  assert.throws(()=>mapDirectory(['notes.txt'],{'notes.txt':'../escape'}),/Invalid persisted/);
});
test('temporarily absent remote names retain reservations for surviving local files',()=>{
  const prior={'file:notes.txt':'notes.txt'};
  const next=mapDirectory([{id:'file:NOTES.TXT',name:'NOTES.TXT'}],prior);
  assert.equal(next.get('file:notes.txt'),'notes.txt');assert.notEqual(next.get('file:NOTES.TXT').toUpperCase(),'NOTES.TXT');
  const returned=mapDirectory([{id:'file:notes.txt',name:'notes.txt'},{id:'file:NOTES.TXT',name:'NOTES.TXT'}],Object.fromEntries(next));
  assert.deepEqual([...returned],[...mapDirectory([{id:'file:NOTES.TXT',name:'NOTES.TXT'},{id:'file:notes.txt',name:'notes.txt'}],Object.fromEntries(next))]);
  assert.equal(returned.get('file:notes.txt'),'notes.txt');
  assert.throws(()=>mapDirectory([],{retired:'../escape'}),/Invalid persisted/);
});
