// A rename protects its original binding and its destination until completion.
function pendingOperations(snapshot){
 const transfers=['uploads','folderUploads','backups','pinnedUpdates'].flatMap(name=>Object.values(snapshot[name]||{}));
 const trees=Object.values(snapshot.folderMoves||{}).flatMap(entry=>[{local:entry.from,key:entry.previousKey,tree:true},{local:entry.local,key:entry.key,tree:true}]);
 return [...trees,...transfers,...Object.values(snapshot.moves||{}).flatMap(entry=>[{...entry},{...entry,local:entry.from,key:entry.previous.key}])];
}
function operationTouches(entry,local,key){const a=entry.local.toUpperCase(),b=local.toUpperCase();return a===b||entry.key===key||entry.tree===true&&(b.startsWith(a+'/')||a.startsWith(b+'/')||typeof key==='string'&&key.startsWith(entry.key));}
module.exports={pendingOperations,operationTouches};
