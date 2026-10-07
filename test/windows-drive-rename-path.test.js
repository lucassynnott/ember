const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {caseOnlyFileRename,sourceRemovedForRename}=require('../src/windows-drive-rename-path');
test('case-only file detection excludes unchanged names, parent renames and invalid names',()=>{
 assert.equal(caseOnlyFileRename('folder/Café.txt','folder/CAFÉ.TXT'),true);
 for(const [from,local]of [['same.txt','same.txt'],['Folder/file.txt','folder/FILE.txt'],['a.txt','b.txt'],['a.txt','../A.TXT'],['con.txt','CON.TXT']])assert.equal(caseOnlyFileRename(from,local),false);
});
test('a real capitalization rename is proved by its directory entry even when Windows-style source inspection finds the alias',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-case-rename-'));
 try{const original=path.join(root,'original.txt'),renamed=path.join(root,'ORIGINAL.TXT');await fs.writeFile(original,'Keep bytes');await fs.rename(original,renamed);assert.equal(await sourceRemovedForRename({bridge:{inspect:async()=>({exists:true})},from:'original.txt',local:'ORIGINAL.TXT',localPath:renamed}),true);assert.equal(await fs.readFile(renamed,'utf8'),'Keep bytes');}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('case alias proof refuses unchanged originals, unrelated destinations and directories',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-case-preserve-')),bridge={inspect:async()=>({exists:true})};
 try{await fs.writeFile(path.join(root,'original.txt'),'Preserve original');assert.equal(await sourceRemovedForRename({bridge,from:'original.txt',local:'ORIGINAL.TXT',localPath:path.join(root,'ORIGINAL.TXT')}),false);assert.equal(await sourceRemovedForRename({bridge,from:'original.txt',local:'another.txt',localPath:path.join(root,'another.txt')}),false);await fs.mkdir(path.join(root,'FOLDER'));assert.equal(await sourceRemovedForRename({bridge,from:'folder',local:'FOLDER',localPath:path.join(root,'FOLDER')}),false);assert.equal(await fs.readFile(path.join(root,'original.txt'),'utf8'),'Preserve original');}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('ordinary renames still require the original source to be missing',async()=>{
 assert.equal(await sourceRemovedForRename({bridge:{inspect:async()=>({exists:false})},from:'before.txt',local:'after.txt'}),true);
 assert.equal(await sourceRemovedForRename({bridge:{inspect:async()=>({exists:true})},from:'before.txt',local:'after.txt'}),false);
});
test('case-only directories require their actual directory spelling and never accept a file replacement',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-folder-case-proof-')),bridge={inspect:async()=>({exists:true})};
 try{await fs.mkdir(path.join(root,'Folder'));await fs.writeFile(path.join(root,'Folder','child'),'Keep child');const args={bridge,from:'Folder',local:'FOLDER',localPath:path.join(root,'FOLDER'),directory:true};assert.equal(await sourceRemovedForRename(args),false);await fs.rename(path.join(root,'Folder'),args.localPath);assert.equal(await sourceRemovedForRename(args),true);assert.equal(await fs.readFile(path.join(args.localPath,'child'),'utf8'),'Keep child');await fs.rm(args.localPath,{recursive:true});await fs.writeFile(args.localPath,'Replacement');assert.equal(await sourceRemovedForRename(args),false);}finally{await fs.rm(root,{recursive:true,force:true});}
});
