// A rename protects its original binding and its destination until completion.
function pendingOperations(snapshot){
 const transfers=['uploads','folderUploads','backups','pinnedUpdates'].flatMap(name=>Object.values(snapshot[name]||{}));
 return [...transfers,...Object.values(snapshot.moves||{}).flatMap(entry=>[{...entry},{...entry,local:entry.from,key:entry.previous.key}])];
}
function operationTouches(entry,local,key){return entry.local.toUpperCase()===local.toUpperCase()||entry.key===key;}
module.exports={pendingOperations,operationTouches};
