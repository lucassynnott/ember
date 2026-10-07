const path=require('node:path');
const {DriveIpcServer,endpointFor,daemonToken}=require('./windows-drive-ipc');
const {WindowsDriveService}=require('./windows-drive-service');
const {WindowsDriveBackupScheduler}=require('./windows-drive-backup-scheduler');

async function run({profile=null,sessionData=null}={}){
  const {app,safeStorage,shell}=require('electron');
  if(process.platform!=='win32')throw new Error('The Drive daemon requires Windows.');
  if(profile){if(!path.isAbsolute(profile))throw new Error('Invalid Drive profile.');app.setPath('userData',profile);}
  if(sessionData||profile){const directory=sessionData||profile;if(!path.isAbsolute(directory))throw new Error('Invalid Drive encryption profile.');app.setPath('sessionData',directory);}
  // No windows or app-wide single-instance lock: the named pipe is the exclusive
  // owner of this profile's Drive, independent of Ember's visible app process.
  app.on('window-all-closed',()=>{});
  await app.whenReady();
  const directory=path.join(app.getPath('userData'),'windows-drive'),token=await daemonToken(directory,safeStorage);
  let server,shutdown=null,shutdownComplete=false,exitRequested=false;
  const snapshot=()=>({status:service.status,mountPath:service.mountPath});
  const service=new WindowsDriveService({app,safeStorage,shell,onStatus:()=>server?.publish('status',snapshot()),onEvent:(name,data)=>server?.publish(name,data)});
  const backups=new WindowsDriveBackupScheduler({profile:app.getPath('userData'),runtime:service.runtime,onStatus:scan=>service.runtime.backupStatus(scan),onError:error=>console.error('Drive scheduled backup:',error.message)});
  const stop=service.stop.bind(service);service.stop=async()=>{await backups.stop();return stop();};
  server=new DriveIpcServer({endpoint:endpointFor(app.getPath('userData')),token,snapshot,dispatch:async(command,args)=>{
    switch(command){
      case 'shutdown':{
        if(!shutdown){shutdown=(async()=>{await server.drain();try{await service.stop();}catch(error){server.resume();shutdown=null;throw error;}shutdownComplete=true;return {stopped:true,pid:process.pid};})();}
        return shutdown;
      }
      case 'shutdownExit':if(!shutdownComplete||args.pid!==process.pid)throw new Error('Drive shutdown has not been confirmed.');if(!exitRequested){exitRequested=true;setImmediate(()=>app.quit());}return true;
      case 'snapshot':return snapshot();
      case 'request':return service.request(args.command,args.args||{});
      case 'backup':return service.backUp(args.file,args.relative);
      default:throw new Error('Invalid Drive daemon command.');
    }
  }});
  try{await server.listen();}catch(error){if(error.code==='EADDRINUSE'){app.quit();return;}throw error;}
  // A mount/network failure leaves the authenticated control process available
  // so the user can inspect settings, change credentials or mount again.
  try{await service.start();}catch(error){service.runtime.status={...service.status,mounted:false,path:null,error:error.message,message:error.message};server.publish('status',snapshot());}
  backups.start();
  app.on('before-quit',()=>{void server.close();void service.stop();});
  return {server,service};
}
module.exports={run};
if(require.main===module){const index=process.argv.indexOf('--ember-drive-profile'),sessionIndex=process.argv.indexOf('--ember-drive-session-data');run({profile:index<0?null:process.argv[index+1],sessionData:sessionIndex<0?null:process.argv[sessionIndex+1]}).catch(error=>{console.error(error.message);require('electron').app.exit(1);});}
