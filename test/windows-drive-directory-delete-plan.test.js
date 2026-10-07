const test=require('node:test'),assert=require('node:assert/strict');
const {planDirectoryDeletion}=require('../src/windows-drive-directory-delete-plan');
const args=()=>({local:'Folder',previous:{key:'cloud/Folder/'},materialized:{Folder:{key:'cloud/Folder/',size:0,remoteConfirmed:true}},objects:[{name:'cloud/Folder/',etag:'dir',size:0},{name:'cloud/Folder/.ghost-keep',etag:'marker',fileID:'v1',size:0},{name:'unrelated/file',etag:'other',size:5}],pending:[]});
test('empty directory planning includes exactly the directory object and its empty-folder marker',()=>{
 const input=args(),before=structuredClone(input),plan=planDirectoryDeletion(input);assert.deepEqual(plan.sources,[{name:'cloud/Folder/',etag:'dir',fileID:null,size:0},{name:'cloud/Folder/.ghost-keep',etag:'marker',fileID:'v1',size:0}]);assert.deepEqual(input,before);plan.previous.key='changed';assert.equal(input.materialized.Folder.key,'cloud/Folder/');
 input.objects=[];assert.deepEqual(planDirectoryDeletion(input).sources,[],'an inferred empty prefix may have no physical cloud marker');
});
test('cloud children and changed or unverified marker revisions refuse empty directory deletion',()=>{
 for(const object of [{name:'cloud/Folder/child',etag:'child',size:0},{name:'cloud/Folder/Empty/.ghost-keep',etag:'nested',size:0},{name:'cloud/Folder/.ghost-keep',etag:'marker',size:1},{name:'cloud/Folder/',size:0}]){const input=args();input.objects=input.objects.filter(existing=>existing.name!==object.name);input.objects.push(object);const before=structuredClone(input);assert.throws(()=>planDirectoryDeletion(input));assert.deepEqual(input,before);}
});
test('local child bindings aliases and case-insensitive descendants preserve the directory',()=>{
 for(const [local,key] of [['Folder/file','cloud/Folder/file'],['FOLDER/Child','other/child'],['Other','cloud/Folder/'],['Elsewhere','cloud/Folder/unknown']]){const input=args();input.materialized[local]={key};assert.throws(()=>planDirectoryDeletion(input),/child or alias/);}
 const input=args();input.materialized.Folder.remoteConfirmed=false;assert.throws(()=>planDirectoryDeletion(input),/not confirmed/);
});
test('pending parent or child operations block deletion while unrelated transfers remain usable',()=>{
 for(const pending of [[{local:'Folder/file',key:'cloud/Folder/file'}],[{local:'FOLDER/child',key:'other'}],[{local:'Other',key:'cloud/Folder/new'}],[{local:'Folder',key:'cloud/Folder/',tree:true}],[{local:'Parent',key:'cloud/',tree:true}]]){const input=args();input.pending=pending;assert.throws(()=>planDirectoryDeletion(input),/unfinished operation/);}
 const input=args();input.pending=[{local:'Elsewhere',key:'elsewhere/'}];assert.equal(planDirectoryDeletion(input).sources.length,2);
});
test('a confirmed parent directory does not prevent deleting its empty nested child',()=>{
 const input=args();input.local='Parent/Folder';input.materialized={'Parent':{key:'cloud/',remoteConfirmed:true},'Parent/Folder':input.materialized.Folder};assert.equal(planDirectoryDeletion(input).sources.length,2);
 input.materialized['parent/folder']={key:'unrelated/'};assert.throws(()=>planDirectoryDeletion(input),/child or alias/);
});
