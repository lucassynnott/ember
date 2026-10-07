using System.IO;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Security.Cryptography;
using System.Text.Json;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.Storage.CloudFilters;
using Windows.Win32.Storage.FileSystem;

// Private NDJSON transport. The Electron host owns credentials and network requests.
// Native callbacks only receive the immutable object identity and validated bytes.
[System.Runtime.Versioning.SupportedOSPlatform("windows10.0.16299")]
internal static unsafe class CloudFiles
{
    static readonly object OutputLock = new();
    static readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> Pending = new();
    static readonly CF_CALLBACK FetchCallback = Fetch;
    static readonly CF_CALLBACK CancelCallback = Cancel;
    static readonly CF_CALLBACK DeleteCallback = NotifyDelete;
    static readonly CF_CALLBACK DeleteCompletedCallback = DeleteCompleted;
    static readonly ConcurrentDictionary<string,(long Transfer,long Request)> TransferRequests = new();
    static string? root;
    static string? rootIdentity;
    static CF_CONNECTION_KEY connection;
    static bool connected;
    static volatile bool disconnecting;
    static long rootFileId;
    static int cacheOperations;
    static readonly ConcurrentDictionary<string,CancellationTokenSource> BackupCopies=new();
    sealed record UploadLock(Microsoft.Win32.SafeHandles.SafeFileHandle Handle,string? Identity,string Relative,bool Pinned=false,bool Recovery=false);
    static readonly ConcurrentDictionary<string,UploadLock> UploadLocks = new();
    static readonly ConcurrentDictionary<string,UploadLock> FolderLocks = new();
    sealed class LockedHandleView : IDisposable
    {
        readonly Microsoft.Win32.SafeHandles.SafeFileHandle owner;bool held;
        internal Microsoft.Win32.SafeHandles.SafeFileHandle Handle {get;}
        internal LockedHandleView(Microsoft.Win32.SafeHandles.SafeFileHandle value){owner=value;owner.DangerousAddRef(ref held);try{Handle=new(owner.DangerousGetHandle(),false);}catch{if(held)owner.DangerousRelease();throw;}}
        public void Dispose(){Handle.Dispose();if(held){held=false;owner.DangerousRelease();}}
    }

    static void Emit(object value) { lock(OutputLock){Console.WriteLine(JsonSerializer.Serialize(value));Console.Out.Flush();} }
    static string Text(JsonElement value,string name)=>value.GetProperty(name).GetString()??throw new InvalidOperationException("Missing "+name);
    static void Check(HRESULT value)=>Marshal.ThrowExceptionForHR(value.Value);
    internal static void Run()
    {
        Console.OutputEncoding=new UTF8Encoding(false);
        Console.InputEncoding=new UTF8Encoding(false);
        Emit(new {@event="ready",protocol=1});
        try {
            string? line;
            while((line=Console.ReadLine())!=null) {
                string? id=null;
                try {
                    if(line.Length>24*1024*1024)throw new InvalidOperationException("Cloud Files message exceeds its limit.");
                    using var document=JsonDocument.Parse(line);var message=document.RootElement;
                    id=Text(message,"id");
                    if(Pending.TryRemove(id,out var reply)){reply.TrySetResult(message.Clone());continue;}
                    switch(Text(message,"command")) {
                        case "register": Register(Text(message,"root"),Text(message,"identity"),message.TryGetProperty("notifyDelete",out var notifyDelete)&&notifyDelete.ValueKind==JsonValueKind.True);break;
                        case "create": Create(message);break;
                        case "refresh": Refresh(message);break;
                        case "lockFolder": Emit(new {id,ok=true,folder=LockFolder(Text(message,"path"))});continue;
                        case "unlockFolder": if(FolderLocks.TryRemove(Text(message,"token"),out var folderLock))folderLock.Handle.Dispose();break;
                        case "ackFolderMove": Emit(new {id,ok=true,folder=AcknowledgeFolderMove(message)});continue;
                        case "lockUpload": Emit(new {id,ok=true,upload=LockUpload(Text(message,"path"))});continue;
                        case "lockPinnedUpdate": Emit(new {id,ok=true,upload=LockUpload(Text(message,"path"),true)});continue;
                        case "lockPinnedRecovery": Emit(new {id,ok=true,upload=LockUpload(Text(message,"path"),true,true)});continue;
                        case "ackPinnedUpdate": AcknowledgePinnedUpdate(message);break;
                        case "replacePinned": StartPinnedJob(message,id,ReplacePinned);continue;
                        case "finishPinned": StartPinnedJob(message,id,FinishPinned);continue;
                        case "capturePinnedBackup": StartPinnedJob(message,id,CapturePinnedBackup);continue;
                        case "capturePinnedCurrent": StartPinnedJob(message,id,CapturePinnedCurrent);continue;
                        case "fingerprintPinned": StartPinnedJob(message,id,FingerprintPinned);continue;
                        case "cancelPinned":if(BackupCopies.TryGetValue("pinned:"+Text(message,"updateId"),out var pendingPinned))pendingPinned.Cancel();break;
                        case "unlockUpload": UnlockUpload(Text(message,"token"));break;
                        case "ackUpload": AcknowledgeUpload(message);break;
                        case "ackMove": AcknowledgeMove(message);break;
                        case "copyBackup":
                            var backupId=Text(message,"backupId");var backupCancel=new CancellationTokenSource();
                            if(BackupCopies.Count>=4||!BackupCopies.TryAdd(backupId,backupCancel)){backupCancel.Dispose();throw new IOException("A backup copy is already pending or its limit was reached.");}
                            var backupMessage=message.Clone();var backupRequest=id;
                            _=Task.Run(()=>{try{var result=CopyBackup(backupMessage,backupRequest,backupCancel.Token);Emit(new {id=backupRequest,ok=true,backup=result});}catch(Exception error){try{Emit(new {id=backupRequest,ok=false,error=error.Message});}catch{}}finally{BackupCopies.TryRemove(backupId,out _);backupCancel.Dispose();}});continue;
                        case "cancelBackup":if(BackupCopies.TryGetValue(Text(message,"backupId"),out var pendingBackup))pendingBackup.Cancel();break;
                        case "inspect": Emit(new {id,ok=true,placeholder=Inspect(Text(message,"path"))});continue;
                        case "pin": case "unpin": case "hydrate": case "dehydrate":
                            if(Interlocked.Increment(ref cacheOperations)>16){Interlocked.Decrement(ref cacheOperations);throw new IOException("Too many pending Drive cache operations.");}
                            var cacheMessage=message.Clone();var cacheId=id;
                            _=Task.Run(()=>{try{Cache(cacheMessage);Emit(new {id=cacheId,ok=true});}catch(Exception error){try{Emit(new {id=cacheId,ok=false,error=error.Message});}catch{}}finally{Interlocked.Decrement(ref cacheOperations);}});continue;
                        case "explorerPrepare": case "explorerProbe": case "explorerStatus": case "explorerRegister": case "explorerUnregister":
                            var preparing=Text(message,"command")=="explorerPrepare";
                            var probing=Text(message,"command")=="explorerProbe";
                            if(preparing&&connected)throw new IOException("Initial Explorer registration requires a disconnected provider.");
                            if(!preparing&&!probing&&(!connected||root==null||rootIdentity==null))throw new IOException("Drive is not connected.");
                            if(!OperatingSystem.IsWindowsVersionAtLeast(10,0,19041))throw new PlatformNotSupportedException("Explorer integration requires Windows 10 version 2004 or later.");
                            var explorerCommand=Text(message,"command");var explorerRoot=preparing||probing?Text(message,"folder"):root!;var explorerIdentity=preparing||probing?Text(message,"identity"):rootIdentity!;var explorerRequest=id;
                            if(Interlocked.Increment(ref cacheOperations)>16){Interlocked.Decrement(ref cacheOperations);throw new IOException("Too many pending Explorer operations.");}
                            _=Task.Run(()=>{try{
                                if(!OperatingSystem.IsWindowsVersionAtLeast(10,0,19041))throw new PlatformNotSupportedException("Explorer integration requires Windows 10 version 2004 or later.");
                                object result;
                                if(explorerCommand=="explorerPrepare")result=ExplorerRegistration.Prepare(explorerRoot,explorerIdentity);
                                else if(explorerCommand=="explorerUnregister"){ExplorerRegistration.Unregister(explorerRoot,explorerIdentity);result=new {registered=false};}
                                else result=explorerCommand=="explorerRegister"?ExplorerRegistration.Register(explorerRoot,explorerIdentity):ExplorerRegistration.Status(explorerRoot,explorerIdentity);
                                Emit(new {id=explorerRequest,ok=true,explorer=result});
                            }catch(Exception error){try{Emit(new {id=explorerRequest,ok=false,error=$"{explorerCommand}: {error.Message} (HRESULT 0x{error.HResult:X8})"});}catch{}}finally{Interlocked.Decrement(ref cacheOperations);}});continue;
                        case "disconnect": Disconnect();break;
                        case "unregister":
                            if(!connected||root==null)throw new InvalidOperationException("Drive is not connected.");
                            var ownedRoot=root;var ownedIdentity=rootIdentity!;Disconnect();if(OperatingSystem.IsWindowsVersionAtLeast(10,0,19041))ExplorerRegistration.Unregister(ownedRoot,ownedIdentity);UnregisterPhysicalRoot(ownedRoot,ownedIdentity);break;
                        default:throw new InvalidOperationException("Unknown Cloud Files command.");
                    }
                    Emit(new {id,ok=true});
                }catch(Exception error){Emit(new {id,ok=false,error=error.Message});}
            }
        }finally {
            foreach(var reply in Pending.Values)reply.TrySetException(new IOException("Cloud Files host disconnected."));
            Disconnect();
        }
    }
    static void Disconnect(){disconnecting=true;foreach(var reply in Pending.Values)reply.TrySetException(new OperationCanceledException("The Drive provider is disconnecting."));foreach(var backup in BackupCopies.Values){try{backup.Cancel();}catch(ObjectDisposedException){}}foreach(var upload in UploadLocks.Values)upload.Handle.Dispose();UploadLocks.Clear();foreach(var folder in FolderLocks.Values)folder.Handle.Dispose();FolderLocks.Clear();if(connected){Check(PInvoke.CfDisconnectSyncRoot(connection));connected=false;}root=null;}
    internal static string RootDiagnostic(string folder,string identity)
    {
        byte[] information=new byte[8192];
        fixed(byte* buffer=information){
            var status=PInvoke.CfGetSyncRootInfoByPath(folder,CF_SYNC_ROOT_INFO_CLASS.CF_SYNC_ROOT_INFO_STANDARD,buffer,(uint)information.Length,out uint returned);
            if(status.Value<0)return $"native root HRESULT 0x{status.Value:X8}";
            int start=Marshal.OffsetOf<CF_SYNC_ROOT_STANDARD_INFO>(nameof(CF_SYNC_ROOT_STANDARD_INFO.SyncRootIdentity)).ToInt32();var marker=Encoding.UTF8.GetBytes(identity);
            var owned=returned<=information.Length&&returned>=start&&((CF_SYNC_ROOT_STANDARD_INFO*)buffer)->SyncRootIdentityLength==marker.Length&&start+marker.Length<=returned&&information.AsSpan(start,marker.Length).SequenceEqual(marker);
            return $"native root registered: True; native identity matches: {owned}";
        }
    }
    internal static void VerifyRootIdentity(string folder,string identity)
    {
        byte[] information=new byte[8192];
        fixed(byte* buffer=information){
            Check(PInvoke.CfGetSyncRootInfoByPath(folder,CF_SYNC_ROOT_INFO_CLASS.CF_SYNC_ROOT_INFO_STANDARD,buffer,(uint)information.Length,out uint returned));
            int start=Marshal.OffsetOf<CF_SYNC_ROOT_STANDARD_INFO>(nameof(CF_SYNC_ROOT_STANDARD_INFO.SyncRootIdentity)).ToInt32();var marker=Encoding.UTF8.GetBytes(identity);
            if(returned>information.Length||returned<start||((CF_SYNC_ROOT_STANDARD_INFO*)buffer)->SyncRootIdentityLength!=marker.Length||start+marker.Length>returned||!information.AsSpan(start,marker.Length).SequenceEqual(marker))throw new IOException("The native sync root identity changed; it was preserved.");
        }
    }
    static void UnregisterPhysicalRoot(string folder,string identity)
    {
        byte[] information=new byte[8192];
        fixed(byte* buffer=information){
            var status=PInvoke.CfGetSyncRootInfoByPath(folder,CF_SYNC_ROOT_INFO_CLASS.CF_SYNC_ROOT_INFO_STANDARD,buffer,(uint)information.Length,out uint returned);
            // WinRT shell removal may already have removed the CF registration.
            if(status.Value==unchecked((int)0x80070186)||status.Value==unchecked((int)0x80070178))return;
            Check(status);int start=Marshal.OffsetOf<CF_SYNC_ROOT_STANDARD_INFO>(nameof(CF_SYNC_ROOT_STANDARD_INFO.SyncRootIdentity)).ToInt32();var marker=Encoding.UTF8.GetBytes(identity);
            if(returned>information.Length||returned<start||((CF_SYNC_ROOT_STANDARD_INFO*)buffer)->SyncRootIdentityLength!=marker.Length||start+marker.Length>returned||!information.AsSpan(start,marker.Length).SequenceEqual(marker))throw new IOException("The sync root identity changed; it was preserved.");
        }
        Check(PInvoke.CfUnregisterSyncRoot(folder));
    }
    static void Register(string folder,string identity,bool notifyDelete=false)
    {
        if(connected)throw new InvalidOperationException("A Drive root is already connected.");
        folder=Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar);
        if(folder==Path.GetPathRoot(folder)?.TrimEnd(Path.DirectorySeparatorChar)||!Directory.Exists(folder))throw new InvalidOperationException("Choose an existing private Drive directory.");
        if((File.GetAttributes(folder)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("A Drive root cannot be a reparse point.");
        var bytes=Encoding.UTF8.GetBytes(identity);if(bytes.Length<1||bytes.Length>4096)throw new InvalidOperationException("Invalid Drive identity.");
        bool registered=false;
        byte[] existing=new byte[8192];
        fixed(byte* buffer=existing) {
            var status=PInvoke.CfGetSyncRootInfoByPath(folder,CF_SYNC_ROOT_INFO_CLASS.CF_SYNC_ROOT_INFO_STANDARD,buffer,(uint)existing.Length,out uint returned);
            if(status.Value>=0) {
                int start=Marshal.OffsetOf<CF_SYNC_ROOT_STANDARD_INFO>(nameof(CF_SYNC_ROOT_STANDARD_INFO.SyncRootIdentity)).ToInt32();
                var info=(CF_SYNC_ROOT_STANDARD_INFO*)buffer;
                if(returned>existing.Length||returned<start||info->SyncRootIdentityLength!=bytes.Length||start+bytes.Length>returned||!existing.AsSpan(start,bytes.Length).SequenceEqual(bytes))throw new IOException("The directory belongs to another sync root.");
                registered=true;
            }
        }
        // Registration never updates or replaces another provider's root.
        if(!registered && Directory.EnumerateFileSystemEntries(folder).Any())throw new InvalidOperationException("Initial Drive registration requires an empty directory.");
        if(!registered) fixed(char* name="Ember Drive",version="1.11.3") fixed(byte* marker=bytes) {
            var registration=new CF_SYNC_REGISTRATION{StructSize=(uint)sizeof(CF_SYNC_REGISTRATION),ProviderName=new PCWSTR(name),ProviderVersion=new PCWSTR(version),SyncRootIdentity=marker,SyncRootIdentityLength=(uint)bytes.Length,ProviderId=new Guid("a08aeeaa-6ad5-4a0e-83fd-60eb1ec12830")};
            var policies=new CF_SYNC_POLICIES{StructSize=(uint)sizeof(CF_SYNC_POLICIES),Hydration=new(){Primary=CF_HYDRATION_POLICY_PRIMARY.CF_HYDRATION_POLICY_FULL},Population=new(){Primary=CF_POPULATION_POLICY_PRIMARY.CF_POPULATION_POLICY_ALWAYS_FULL},InSync=CF_INSYNC_POLICY.CF_INSYNC_POLICY_TRACK_FILE_LAST_WRITE_TIME};
            Check(PInvoke.CfRegisterSyncRoot(folder,in registration,in policies,CF_REGISTER_FLAGS.CF_REGISTER_FLAG_NONE));
        }
        try {
            var callbacks=new List<CF_CALLBACK_REGISTRATION>{new(){Type=CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_FETCH_DATA,Callback=FetchCallback},new(){Type=CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_CANCEL_FETCH_DATA,Callback=CancelCallback}};
            if(notifyDelete){callbacks.Add(new(){Type=CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_NOTIFY_DELETE,Callback=DeleteCallback});callbacks.Add(new(){Type=CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_NOTIFY_DELETE_COMPLETION,Callback=DeleteCompletedCallback});}
            callbacks.Add(new(){Type=CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_NONE});
            Check(PInvoke.CfConnectSyncRoot(folder,callbacks.ToArray(),null,CF_CONNECT_FLAGS.CF_CONNECT_FLAG_NONE,out connection));
            root=folder;rootIdentity=identity;connected=true;disconnecting=false;
            fixed(byte* buffer=existing) {
                Check(PInvoke.CfGetSyncRootInfoByPath(folder,CF_SYNC_ROOT_INFO_CLASS.CF_SYNC_ROOT_INFO_STANDARD,buffer,(uint)existing.Length,out uint returned));
                if(returned<(uint)Marshal.OffsetOf<CF_SYNC_ROOT_STANDARD_INFO>(nameof(CF_SYNC_ROOT_STANDARD_INFO.SyncRootIdentity)).ToInt32())throw new IOException("Incomplete sync root information.");
                rootFileId=((CF_SYNC_ROOT_STANDARD_INFO*)buffer)->SyncRootFileId;
            }
        }catch {if(connected)Disconnect();if(!registered)PInvoke.CfUnregisterSyncRoot(folder);throw;}
    }
    static void Create(JsonElement message)
    {
        if(!connected||root==null)throw new InvalidOperationException("Drive is not connected.");
        var parent=message.TryGetProperty("parent",out var parentValue)?parentValue.GetString()??"":"";
        var directory=root;
        if(parent.Length>0)foreach(var component in parent.Split('/')) {
            ValidateName(component);directory=Path.Combine(directory,component);
            var info=new DirectoryInfo(directory);
            if(!info.Exists||info.LinkTarget!=null)throw new IOException("The placeholder parent must be an existing Drive directory without links.");
        }
        var name=Text(message,"name");
        ValidateName(name);
        bool folder=message.TryGetProperty("kind",out var kind)&&kind.GetString()=="folder";
        var identity=Encoding.UTF8.GetBytes(Text(message,"identity"));if(identity.Length==0||identity.Length>4096)throw new InvalidOperationException("Invalid file identity.");
        long size=message.GetProperty("size").GetInt64();if(size<0||(folder&&size!=0))throw new InvalidOperationException("Invalid placeholder size.");
        var modified=DateTimeOffset.FromUnixTimeMilliseconds(message.GetProperty("modified").GetInt64()).UtcDateTime.ToFileTimeUtc();
        fixed(char* filename=name)fixed(byte* marker=identity) {
            CF_PLACEHOLDER_CREATE_INFO[] entries=[new(){RelativeFileName=new PCWSTR(filename),FileIdentity=marker,FileIdentityLength=(uint)identity.Length,FsMetadata=new(){FileSize=size,BasicInfo=new(){FileAttributes=(uint)(folder?FileAttributes.Directory:FileAttributes.Normal),CreationTime=modified,LastAccessTime=modified,LastWriteTime=modified,ChangeTime=modified}},Flags=CF_PLACEHOLDER_CREATE_FLAGS.CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC|(folder?CF_PLACEHOLDER_CREATE_FLAGS.CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION:0)}];
            Check(PInvoke.CfCreatePlaceholders(directory,entries,CF_CREATE_FLAGS.CF_CREATE_FLAG_NONE,out uint count));
            if(count!=1)throw new IOException("Windows did not create the placeholder.");Check(entries[0].Result);
        }
    }
    static void ValidateName(string name)
    {
        if(name.Length==0||name.Length>255||name is "." or ".."||name.EndsWith('.')||name.EndsWith(' ')||name.IndexOfAny(Path.GetInvalidFileNameChars())>=0||System.Text.RegularExpressions.Regex.IsMatch(name,@"^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])($|\.)",System.Text.RegularExpressions.RegexOptions.IgnoreCase))throw new InvalidOperationException("Invalid Windows placeholder name.");
    }
    static Microsoft.Win32.SafeHandles.SafeFileHandle OpenMetadata(string relative,uint access=0x80,FILE_SHARE_MODE share=FILE_SHARE_MODE.FILE_SHARE_READ|FILE_SHARE_MODE.FILE_SHARE_WRITE|FILE_SHARE_MODE.FILE_SHARE_DELETE)
    {
        if(!connected||root==null)throw new IOException("Drive is not connected.");
        var components=relative.Split('/');var local=root;
        for(int index=0;index<components.Length;index++) {
            ValidateName(components[index]);local=Path.Combine(local,components[index]);
            if(index<components.Length-1) {var directory=new DirectoryInfo(local);if(!directory.Exists||directory.LinkTarget!=null)throw new IOException("Drive parent is missing or is a link.");}
        }
        var handle=PInvoke.CreateFile(local,access,share,null,FILE_CREATION_DISPOSITION.OPEN_EXISTING,FILE_FLAGS_AND_ATTRIBUTES.FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAGS_AND_ATTRIBUTES.FILE_FLAG_BACKUP_SEMANTICS,null);
        return handle;
    }
    static object Inspect(string relative)
    {
        using var handle=OpenMetadata(relative);
        if(handle.IsInvalid) {int error=Marshal.GetLastWin32Error();if(error is 2 or 3)return new {exists=false};throw new System.ComponentModel.Win32Exception(error);}
        return InspectHandle(handle);
    }
    static object InspectHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle)
    {
        if(!PInvoke.GetFileInformationByHandle(handle,out var fileInfo))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var directory=(fileInfo.dwFileAttributes & (uint)FILE_FLAGS_AND_ATTRIBUTES.FILE_ATTRIBUTE_DIRECTORY)!=0;
        byte[] bytes=new byte[8192];
        var status=PInvoke.CfGetPlaceholderInfo(handle,CF_PLACEHOLDER_INFO_CLASS.CF_PLACEHOLDER_INFO_STANDARD,bytes,out uint returned);
        if(status.Value<0)return new {exists=true,cloud=false,directory,cloudError=$"0x{status.Value:X8}"};
        fixed(byte* buffer=bytes) {
            int start=Marshal.OffsetOf<CF_PLACEHOLDER_STANDARD_INFO>(nameof(CF_PLACEHOLDER_STANDARD_INFO.FileIdentity)).ToInt32();
            if(returned<start||returned>bytes.Length)throw new IOException("Invalid placeholder information.");
            var info=(CF_PLACEHOLDER_STANDARD_INFO*)buffer;
            if(info->FileIdentityLength>4096||start+info->FileIdentityLength>returned)throw new IOException("Invalid placeholder identity.");
            if(info->SyncRootFileId!=rootFileId)throw new IOException("Placeholder belongs to another Drive root.");
            var identity=Encoding.UTF8.GetString(bytes,start,(int)info->FileIdentityLength);
            return new {exists=true,cloud=true,directory,identity,inSync=info->InSyncState==CF_IN_SYNC_STATE.CF_IN_SYNC_STATE_IN_SYNC,modifiedBytes=info->ModifiedDataSize,validatedBytes=info->ValidatedDataSize,onDiskBytes=info->OnDiskDataSize,pinState=(int)info->PinState,fileId=info->FileId.ToString()};
        }
    }
    static object LockUpload(string relative,bool pinned=false,bool recovery=false)
    {
        if(UploadLocks.Values.Any(upload=>upload.Relative.Equals(relative,StringComparison.OrdinalIgnoreCase)))throw new IOException("This file already has an upload in progress.");
        if(UploadLocks.Count>=8)throw new IOException("Too many pending Drive uploads.");
        // FILE_READ_DATA makes this handle participate in data-sharing checks.
        // Metadata-only handles do not prevent a competing writer from opening.
        var handle=OpenMetadata(relative,pinned?0x40083u:0x40081u,pinned?0:FILE_SHARE_MODE.FILE_SHARE_READ);
        try {
            if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var local=Path.Combine(root!,relative.Replace('/',Path.DirectorySeparatorChar));var file=new FileInfo(local);
            if(file.LinkTarget!=null||(file.Attributes&FileAttributes.Directory)!=0)throw new IOException("Upload requires a local file without links.");
            var metadata=JsonSerializer.SerializeToElement(InspectHandle(handle));
            bool cloud=metadata.GetProperty("cloud").GetBoolean();
            if(!cloud&&(file.Attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Another provider's placeholder cannot be uploaded by this Drive.");
            string? identity=cloud?Text(metadata,"identity"):null;
            if(pinned&&!recovery&&(!cloud||!metadata.GetProperty("inSync").GetBoolean()||metadata.GetProperty("modifiedBytes").GetInt64()!=0||metadata.GetProperty("pinState").GetInt32()!=(int)CF_PIN_STATE.CF_PIN_STATE_PINNED))throw new IOException("Pinned replacement requires a clean pinned source.");
            string token=Guid.NewGuid().ToString("N");UploadLocks[token]=new UploadLock(handle,identity,relative,pinned,recovery);
            return new {token,cloud,identity,pinState=cloud?metadata.GetProperty("pinState").GetInt32():0,inSync=cloud&&metadata.GetProperty("inSync").GetBoolean(),modifiedBytes=cloud?metadata.GetProperty("modifiedBytes").GetInt64():0,size=file.Length,modified=new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds(),localPath=local};
        }catch{handle.Dispose();throw;}
    }
    static object LockFolder(string relative)
    {
        if(FolderLocks.Count>=8||FolderLocks.Values.Any(value=>value.Relative.Equals(relative,StringComparison.OrdinalIgnoreCase)))throw new IOException("The folder is already locked or the folder operation limit was reached.");
        // FILE_LIST_DIRECTORY makes directory sharing restrictions effective.
        var handle=OpenMetadata(relative,0x40081u,FILE_SHARE_MODE.FILE_SHARE_READ|FILE_SHARE_MODE.FILE_SHARE_WRITE);
        try{
            if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var info=JsonSerializer.SerializeToElement(InspectHandle(handle));
            if(!info.GetProperty("cloud").GetBoolean()||!info.GetProperty("directory").GetBoolean())throw new IOException("Folder moves require an owned cloud directory.");
            var identity=Text(info,"identity");using var original=JsonDocument.Parse(identity);if(!Text(original.RootElement,"key").EndsWith('/'))throw new IOException("The directory cloud identity is invalid.");
            var token=Guid.NewGuid().ToString("N");FolderLocks[token]=new UploadLock(handle,identity,relative);return new {token,identity};
        }catch{handle.Dispose();throw;}
    }
    static object AcknowledgeFolderMove(JsonElement message)
    {
        if(!FolderLocks.TryGetValue(Text(message,"token"),out var folder))throw new IOException("The folder lock is unavailable.");
        var expected=Text(message,"expectedIdentity");var info=JsonSerializer.SerializeToElement(InspectHandle(folder.Handle));
        if(expected!=folder.Identity||!info.GetProperty("cloud").GetBoolean()||!info.GetProperty("directory").GetBoolean()||Text(info,"identity")!=expected)throw new IOException("The folder source identity changed.");
        var identity=Text(message,"identity");var bytes=Encoding.UTF8.GetBytes(identity);if(bytes.Length==0||bytes.Length>4096)throw new IOException("Invalid moved folder identity.");
        using var previous=JsonDocument.Parse(expected);using var next=JsonDocument.Parse(identity);var key=Text(next.RootElement,"key");if(string.IsNullOrWhiteSpace(key)||!key.EndsWith('/')||key==Text(previous.RootElement,"key"))throw new IOException("Folder acknowledgement requires a different cloud directory key.");
        Check(PInvoke.CfUpdatePlaceholder(folder.Handle,null,bytes,ReadOnlySpan<CF_FILE_RANGE>.Empty,CF_UPDATE_FLAGS.CF_UPDATE_FLAG_MARK_IN_SYNC));return InspectHandle(folder.Handle);
    }
    static void UnlockUpload(string token){if(UploadLocks.TryRemove(token,out var upload))upload.Handle.Dispose();}
    static void AcknowledgeUpload(JsonElement message)
    {
        var token=Text(message,"token");if(!UploadLocks.TryGetValue(token,out var upload))throw new IOException("Upload lock is no longer held; local data was preserved.");
        if(upload.Pinned)throw new IOException("Pinned replacements require their own acknowledgement.");
        var bytes=Encoding.UTF8.GetBytes(Text(message,"identity"));if(bytes.Length==0||bytes.Length>4096)throw new IOException("Invalid uploaded revision identity.");
        using var identity=JsonDocument.Parse(bytes);var key=Text(identity.RootElement,"key");
        bool revision=identity.RootElement.TryGetProperty("etag",out var etag)&&etag.ValueKind==JsonValueKind.String&&!string.IsNullOrEmpty(etag.GetString());
        revision|=identity.RootElement.TryGetProperty("fileID",out var version)&&version.ValueKind==JsonValueKind.String&&!string.IsNullOrEmpty(version.GetString());
        if(!revision)throw new IOException("Upload acknowledgement requires a confirmed remote revision.");
        if(upload.Identity!=null){using var previous=JsonDocument.Parse(upload.Identity);if(Text(previous.RootElement,"key")!=key)throw new IOException("Upload acknowledgement cannot change the remote key.");}
        if(upload.Identity==null)Check(PInvoke.CfConvertToPlaceholder(upload.Handle,bytes,CF_CONVERT_FLAGS.CF_CONVERT_FLAG_MARK_IN_SYNC));
        else {
            // The read-share lock excludes data writers throughout the upload.
            using var view=new LockedHandleView(upload.Handle);using var stream=new FileStream(view.Handle,FileAccess.Read);
            Check(PInvoke.CfUpdatePlaceholder(upload.Handle,new CF_FS_METADATA{FileSize=stream.Length},bytes,ReadOnlySpan<CF_FILE_RANGE>.Empty,CF_UPDATE_FLAGS.CF_UPDATE_FLAG_MARK_IN_SYNC));
        }
        UnlockUpload(token);
    }
    static void AcknowledgeMove(JsonElement message)
    {
        var token=Text(message,"token");if(!UploadLocks.TryGetValue(token,out var upload))throw new IOException("The move lock is no longer held; local data was preserved.");
        if(upload.Pinned)throw new IOException("Pinned replacement locks cannot acknowledge a move.");
        if(upload.Identity==null)throw new IOException("The local file changed during its move and no longer has a cloud source identity; it was preserved.");
        var expected=Text(message,"expectedIdentity");if(expected!=upload.Identity)throw new IOException("The move source identity differs from its native lock.");
        var current=JsonSerializer.SerializeToElement(InspectHandle(upload.Handle));
        if(!current.GetProperty("cloud").GetBoolean()||Text(current,"identity")!=expected||current.GetProperty("modifiedBytes").GetInt64()!=0)throw new IOException("The local file changed during its move; it was preserved.");
        // A clean rename clears InSync on Windows. Verify all bytes under the
        // held read-share lock instead of treating that flag as content proof.
        var hash=message.TryGetProperty("hash",out var hashValue)&&hashValue.ValueKind==JsonValueKind.String?hashValue.GetString():null;
        if(hash==null||hash.Length!=64||!hash.All(Uri.IsHexDigit))throw new IOException("Move acknowledgement requires a verified content fingerprint.");
        var local=Path.Combine(root!,upload.Relative.Replace('/',Path.DirectorySeparatorChar));
        using(var stream=new FileStream(local,FileMode.Open,FileAccess.Read,FileShare.Read))
        {if(!Convert.ToHexString(SHA256.HashData(stream)).Equals(hash,StringComparison.OrdinalIgnoreCase))throw new IOException("The local file changed during its move; it was preserved.");}
        var bytes=Encoding.UTF8.GetBytes(Text(message,"identity"));if(bytes.Length==0||bytes.Length>4096)throw new IOException("Invalid moved revision identity.");
        using var original=JsonDocument.Parse(expected);using var replacement=JsonDocument.Parse(bytes);
        var key=Text(replacement.RootElement,"key");
        if(string.IsNullOrWhiteSpace(key)||key.EndsWith('/')||key==Text(original.RootElement,"key")||!replacement.RootElement.TryGetProperty("etag",out var etag)||etag.ValueKind!=JsonValueKind.String||string.IsNullOrEmpty(etag.GetString()))throw new IOException("Move acknowledgement requires a different key and confirmed revision.");
        Check(PInvoke.CfUpdatePlaceholder(upload.Handle,null,bytes,ReadOnlySpan<CF_FILE_RANGE>.Empty,CF_UPDATE_FLAGS.CF_UPDATE_FLAG_MARK_IN_SYNC));
        UnlockUpload(token);
    }
    static void StartPinnedJob(JsonElement message,string request,Func<JsonElement,string,CancellationToken,object> operation)
    {
        var job="pinned:"+Text(message,"updateId");var cancellation=new CancellationTokenSource();
        if(BackupCopies.Count>=4||!BackupCopies.TryAdd(job,cancellation)){cancellation.Dispose();throw new IOException("A pinned operation is already pending or its limit was reached.");}
        var input=message.Clone();
        _=Task.Run(()=>{
            object reply;try{reply=new {id=request,ok=true,replacement=operation(input,request,cancellation.Token)};}
            catch(Exception error){reply=new {id=request,ok=false,error=error.Message};}
            finally{BackupCopies.TryRemove(job,out _);cancellation.Dispose();}
            try{Emit(reply);}catch{}
        });
    }
    static UploadLock RequirePinnedLock(string token)
    {
        if(!UploadLocks.TryGetValue(token,out var upload)||!upload.Pinned||!connected||root==null)throw new IOException("The pinned file lock is unavailable; its recovery files were preserved.");return upload;
    }
    static object CapturePinnedBackup(JsonElement message,string request,CancellationToken cancellation)=>CapturePinnedCopy(message,request,cancellation,false);
    static object CapturePinnedCurrent(JsonElement message,string request,CancellationToken cancellation)=>CapturePinnedCopy(message,request,cancellation,true);
    static object CapturePinnedCopy(JsonElement message,string request,CancellationToken cancellation,bool recovery)
    {
        var token=Text(message,"token");var upload=RequirePinnedLock(token);var expected=message.TryGetProperty("expectedIdentity",out var expectedValue)&&expectedValue.ValueKind==JsonValueKind.String?expectedValue.GetString():null;
        var current=JsonSerializer.SerializeToElement(InspectHandle(upload.Handle));
        bool cloud=current.GetProperty("cloud").GetBoolean();
        if(upload.Identity!=expected||cloud&&Text(current,"identity")!=expected||recovery&&!upload.Recovery)throw new IOException("The pinned recovery source identity changed.");
        if(!recovery&&(!cloud||!current.GetProperty("inSync").GetBoolean()||current.GetProperty("modifiedBytes").GetInt64()!=0||current.GetProperty("pinState").GetInt32()!=(int)CF_PIN_STATE.CF_PIN_STATE_PINNED))throw new IOException("Offline backup requires the unchanged clean pinned source.");
        var file=Path.GetFullPath(Text(message,"backup"));var relative=Path.GetRelativePath(root!,file);
        if(!relative.StartsWith(".."+Path.DirectorySeparatorChar)&&relative!=".."&&!Path.IsPathRooted(relative))throw new IOException("Offline backup must be outside the Drive root.");
        using var view=new LockedHandleView(upload.Handle);using var source=new FileStream(view.Handle,FileAccess.Read);source.Position=0;
        long size=message.GetProperty("size").GetInt64();if(size<0||source.Length!=size)throw new IOException("The offline source size changed.");
        bool created=false;
        try{
            using(var target=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){
                created=true;using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);var buffer=new byte[8*1024*1024];int read;long copied=0;
                while((read=source.Read(buffer,0,buffer.Length))>0){cancellation.ThrowIfCancellationRequested();if(!UploadLocks.TryGetValue(token,out var active)||!ReferenceEquals(active,upload))throw new IOException("The pinned backup lock was released.");target.Write(buffer,0,read);hash.AppendData(buffer,0,read);copied+=read;Emit(new {id=request,@event="pinnedProgress",stage="backup",bytes=copied,total=size});}
                target.Flush(true);cancellation.ThrowIfCancellationRequested();if(copied!=size)throw new IOException("The offline backup was incomplete.");
                return new {file,hash=Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant(),size=copied};
            }
        }catch{if(created){try{File.Delete(file);}catch{}}throw;}
    }
    static object FingerprintPinned(JsonElement message,string request,CancellationToken cancellation)
    {
        var token=Text(message,"token");var upload=RequirePinnedLock(token);using var view=new LockedHandleView(upload.Handle);using var source=new FileStream(view.Handle,FileAccess.Read);source.Position=0;
        using var hash=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);var buffer=new byte[8*1024*1024];int read;long size=source.Length,checkedBytes=0;
        while((read=source.Read(buffer,0,buffer.Length))>0){cancellation.ThrowIfCancellationRequested();if(!UploadLocks.TryGetValue(token,out var active)||!ReferenceEquals(active,upload))throw new IOException("The pinned verification lock was released.");hash.AppendData(buffer,0,read);checkedBytes+=read;Emit(new {id=request,@event="pinnedProgress",stage="check",bytes=checkedBytes,total=size});}
        cancellation.ThrowIfCancellationRequested();if(checkedBytes!=size||source.Length!=size)throw new IOException("The pinned verification was incomplete.");return new {hash=Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant(),size,placeholder=InspectHandle(upload.Handle)};
    }
    static FileStream OpenPinnedProof(string file,string hash,long size,string driveRoot,string request,CancellationToken cancellation)
    {
        var full=Path.GetFullPath(file);var relative=Path.GetRelativePath(driveRoot,full);
        if(!relative.StartsWith(".."+Path.DirectorySeparatorChar)&&relative!=".."&&!Path.IsPathRooted(relative))throw new IOException("Pinned revision staging must be outside the Drive root.");
        var info=new FileInfo(full);if(info.LinkTarget!=null||(info.Attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0||size<0||hash.Length!=64||!hash.All(Uri.IsHexDigit))throw new IOException("Invalid pinned revision proof.");
        var stream=new FileStream(full,FileMode.Open,FileAccess.Read,FileShare.Read);
        try{
            if(stream.Length!=size)throw new IOException("The staged pinned revision size changed.");
            using var digest=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);var buffer=new byte[8*1024*1024];int read;long verified=0;
            while((read=stream.Read(buffer,0,buffer.Length))>0){cancellation.ThrowIfCancellationRequested();digest.AppendData(buffer,0,read);verified+=read;Emit(new {id=request,@event="pinnedProgress",stage="verify",bytes=verified,total=size});}
            if(!Convert.ToHexString(digest.GetHashAndReset()).Equals(hash,StringComparison.OrdinalIgnoreCase))throw new IOException("The staged pinned revision content changed.");
            stream.Position=0;return stream;
        }catch{stream.Dispose();throw;}
    }
    static object ReplacePinned(JsonElement message,string request,CancellationToken cancellation)=>ReplacePinnedContent(message,request,cancellation,false);
    static object FinishPinned(JsonElement message,string request,CancellationToken cancellation)=>ReplacePinnedContent(message,request,cancellation,true);
    static object ReplacePinnedContent(JsonElement message,string request,CancellationToken cancellation,bool recovery)
    {
        var token=Text(message,"token");if(!UploadLocks.TryGetValue(token,out var upload)||!upload.Pinned||!connected||root==null||recovery&&!upload.Recovery||!recovery&&upload.Identity==null)throw new IOException("The pinned replacement lock is unavailable; its offline backup was preserved.");
        var expected=message.TryGetProperty("expectedIdentity",out var expectedValue)&&expectedValue.ValueKind==JsonValueKind.String?expectedValue.GetString():null;if(expected!=upload.Identity)throw new IOException("The pinned source identity changed.");
        var hash=Text(message,"hash");long size=message.GetProperty("size").GetInt64(),previousSize=message.GetProperty("previousSize").GetInt64();var previousHash=Text(message,"previousHash");
        var driveRoot=root;using var source=OpenPinnedProof(Text(message,"source"),hash,size,driveRoot,request,cancellation);
        using var previous=OpenPinnedProof(Text(message,"backup"),previousHash,previousSize,driveRoot,request,cancellation);
        // A non-owning view keeps the native lock held after FileStream closes.
        using var view=new LockedHandleView(upload.Handle);
        using var target=new FileStream(view.Handle,FileAccess.ReadWrite);target.Position=0;
        if(target.Length!=previousSize||!Convert.ToHexString(SHA256.HashData(target)).Equals(previousHash,StringComparison.OrdinalIgnoreCase))throw new IOException("The local pinned source differs from its offline backup.");
        var current=JsonSerializer.SerializeToElement(InspectHandle(upload.Handle));
        bool cloud=current.GetProperty("cloud").GetBoolean();
        if(cloud&&Text(current,"identity")!=expected||!recovery&&(!cloud||!current.GetProperty("inSync").GetBoolean()||current.GetProperty("modifiedBytes").GetInt64()!=0||current.GetProperty("pinState").GetInt32()!=(int)CF_PIN_STATE.CF_PIN_STATE_PINNED))throw new IOException("The pinned source changed before replacement; it was preserved.");
        cancellation.ThrowIfCancellationRequested();if(cloud)Check(PInvoke.CfSetInSyncState(upload.Handle,CF_IN_SYNC_STATE.CF_IN_SYNC_STATE_NOT_IN_SYNC,CF_SET_IN_SYNC_FLAGS.CF_SET_IN_SYNC_FLAG_NONE));
        target.Position=0;target.SetLength(size);var buffer=new byte[8*1024*1024];int read;long copied=0;
        while((read=source.Read(buffer,0,buffer.Length))>0){cancellation.ThrowIfCancellationRequested();if(!Volatile.Read(ref connected)||!UploadLocks.TryGetValue(token,out var active)||!ReferenceEquals(active,upload))throw new IOException("Drive disconnected during pinned replacement.");target.Write(buffer,0,read);copied+=read;Emit(new {id=request,@event="pinnedProgress",stage="replace",bytes=copied,total=size});}
        target.Flush(true);cancellation.ThrowIfCancellationRequested();target.Position=0;
        if(copied!=size||target.Length!=size||!Convert.ToHexString(SHA256.HashData(target)).Equals(hash,StringComparison.OrdinalIgnoreCase))throw new IOException("Pinned replacement was incomplete; its offline backup was preserved.");
        return new {hash=hash.ToLowerInvariant(),size=copied};
    }
    static void AcknowledgePinnedUpdate(JsonElement message)
    {
        var token=Text(message,"token");if(!UploadLocks.TryGetValue(token,out var upload)||!upload.Pinned)throw new IOException("The pinned acknowledgement lock is unavailable.");
        var expected=Text(message,"expectedIdentity");var bytes=Encoding.UTF8.GetBytes(Text(message,"identity"));
        if(bytes.Length==0||bytes.Length>4096)throw new IOException("Invalid pinned revision identity.");
        using var original=JsonDocument.Parse(expected);using var identity=JsonDocument.Parse(bytes);
        if(Text(original.RootElement,"key")!=Text(identity.RootElement,"key")||!identity.RootElement.TryGetProperty("etag",out var etag)||etag.ValueKind!=JsonValueKind.String||string.IsNullOrEmpty(etag.GetString()))throw new IOException("Pinned acknowledgement requires a confirmed revision of the same object.");
        var current=JsonSerializer.SerializeToElement(InspectHandle(upload.Handle));bool cloud=current.GetProperty("cloud").GetBoolean();
        if(cloud&&Text(current,"identity")!=expected&&Text(current,"identity")!=Encoding.UTF8.GetString(bytes))throw new IOException("The local pinned identity changed; it was preserved.");
        var hash=Text(message,"hash");if(hash.Length!=64||!hash.All(Uri.IsHexDigit))throw new IOException("Pinned acknowledgement requires a content fingerprint.");
        long verifiedSize;
        using(var view=new LockedHandleView(upload.Handle))using(var stream=new FileStream(view.Handle,FileAccess.Read))
        {stream.Position=0;verifiedSize=stream.Length;if(!Convert.ToHexString(SHA256.HashData(stream)).Equals(hash,StringComparison.OrdinalIgnoreCase))throw new IOException("The local pinned bytes changed; they were preserved.");}
        // Keep Cloud Files' revision size aligned with the fully verified stream,
        // including appended bytes. Zero timestamps and attributes preserve them.
        if(cloud)Check(PInvoke.CfUpdatePlaceholder(upload.Handle,new CF_FS_METADATA{FileSize=verifiedSize},bytes,ReadOnlySpan<CF_FILE_RANGE>.Empty,CF_UPDATE_FLAGS.CF_UPDATE_FLAG_MARK_IN_SYNC));
        else Check(PInvoke.CfConvertToPlaceholder(upload.Handle,bytes,CF_CONVERT_FLAGS.CF_CONVERT_FLAG_MARK_IN_SYNC));
        Check(PInvoke.CfSetPinState(upload.Handle,CF_PIN_STATE.CF_PIN_STATE_PINNED,CF_SET_PIN_FLAGS.CF_SET_PIN_FLAG_NONE));
    }
    static object CopyBackup(JsonElement message,string request,CancellationToken cancellation)
    {
        var relative=Text(message,"path");var sourcePath=Path.GetFullPath(Text(message,"source"));var expected=message.TryGetProperty("expectedIdentity",out var expectedValue)&&expectedValue.ValueKind==JsonValueKind.String?expectedValue.GetString():null;
        var hash=Text(message,"hash");long size=message.GetProperty("size").GetInt64();
        if(size<0||hash.Length!=64||!hash.All(Uri.IsHexDigit))throw new IOException("Invalid backup content proof.");
        if(!connected||root==null)throw new IOException("Drive is not connected.");var driveRoot=root;
        var sourceRelative=Path.GetRelativePath(driveRoot,sourcePath);
        if(!sourceRelative.StartsWith(".."+Path.DirectorySeparatorChar)&&sourceRelative!=".."&&!Path.IsPathRooted(sourceRelative))throw new IOException("Backup staging must be outside the Drive root.");
        var sourceInfo=new FileInfo(sourcePath);if(sourceInfo.LinkTarget!=null||(sourceInfo.Attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0)throw new IOException("Backup staging requires a regular file without links.");
        using var source=new FileStream(sourcePath,FileMode.Open,FileAccess.Read,FileShare.Read);
        if(source.Length!=size)throw new IOException("The staged backup size changed.");
        using var fingerprint=IncrementalHash.CreateHash(HashAlgorithmName.SHA256);var hashBuffer=new byte[8*1024*1024];int hashRead;long checkedBytes=0;
        while((hashRead=source.Read(hashBuffer,0,hashBuffer.Length))>0){cancellation.ThrowIfCancellationRequested();fingerprint.AppendData(hashBuffer,0,hashRead);checkedBytes+=hashRead;Emit(new {id=request,@event="backupProgress",stage="verify",bytes=checkedBytes,total=size});}
        var actualHash=Convert.ToHexString(fingerprint.GetHashAndReset()).ToLowerInvariant();if(actualHash!=hash.ToLowerInvariant())throw new IOException("The staged backup bytes changed.");source.Position=0;cancellation.ThrowIfCancellationRequested();
        var handle=OpenMetadata(relative,0x40083,0); // Data read/write + WRITE_DAC + attributes, no data sharing.
        try {
            if(handle.IsInvalid){
                int error=Marshal.GetLastWin32Error();handle.Dispose();if(error is not (2 or 3))throw new System.ComponentModel.Win32Exception(error);
                if(expected!=null)throw new IOException("The existing backup target disappeared; it was preserved.");
                var local=Path.Combine(driveRoot,relative.Replace('/',Path.DirectorySeparatorChar));
                handle=PInvoke.CreateFile(local,0x40083,0,null,FILE_CREATION_DISPOSITION.CREATE_NEW,FILE_FLAGS_AND_ATTRIBUTES.FILE_FLAG_OPEN_REPARSE_POINT,null);
                if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }else{
                var info=JsonSerializer.SerializeToElement(InspectHandle(handle));
                if(info.GetProperty("directory").GetBoolean()||!info.GetProperty("cloud").GetBoolean()||expected==null||Text(info,"identity")!=expected||!info.GetProperty("inSync").GetBoolean()||info.GetProperty("modifiedBytes").GetInt64()!=0)throw new IOException("Local edits or another file prevent replacing this backup.");
                cancellation.ThrowIfCancellationRequested();Check(PInvoke.CfSetInSyncState(handle,CF_IN_SYNC_STATE.CF_IN_SYNC_STATE_NOT_IN_SYNC,CF_SET_IN_SYNC_FLAGS.CF_SET_IN_SYNC_FLAG_NONE));
            }
            cancellation.ThrowIfCancellationRequested();using var target=new FileStream(handle,FileAccess.ReadWrite);target.SetLength(0);
            var buffer=new byte[8*1024*1024];int read;long copied=0;
            while((read=source.Read(buffer,0,buffer.Length))>0){cancellation.ThrowIfCancellationRequested();if(!Volatile.Read(ref connected))throw new IOException("Drive disconnected during backup.");target.Write(buffer,0,read);copied+=read;Emit(new {id=request,@event="backupProgress",bytes=copied,total=size});}
            target.Flush(true);if(copied!=size||target.Length!=size)throw new IOException("Backup copying was incomplete.");
            return new {hash=actualHash,size=copied};
        }finally{handle.Dispose();}
    }
    static void Refresh(JsonElement message)
    {
        var relative=Text(message,"path");var previous=Text(message,"expectedIdentity");var identity=Encoding.UTF8.GetBytes(Text(message,"identity"));
        if(identity.Length==0||identity.Length>4096)throw new IOException("Invalid remote revision identity.");
        using var oldIdentity=JsonDocument.Parse(previous);using var newIdentity=JsonDocument.Parse(identity);
        if(Text(oldIdentity.RootElement,"key")!=Text(newIdentity.RootElement,"key"))throw new IOException("Remote refresh cannot change the object key.");
        long size=message.GetProperty("size").GetInt64();if(size<0)throw new IOException("Invalid remote file size.");
        var modified=DateTimeOffset.FromUnixTimeMilliseconds(message.GetProperty("modified").GetInt64()).UtcDateTime.ToFileTimeUtc();
        using var handle=OpenMetadata(relative,0x40080,0); // Exclusive while invalidating cached bytes.
        if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        if(!PInvoke.GetFileInformationByHandle(handle,out var fileInfo))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var directory=(fileInfo.dwFileAttributes & (uint)FILE_FLAGS_AND_ATTRIBUTES.FILE_ATTRIBUTE_DIRECTORY)!=0;
        if(directory)throw new IOException("Remote file refresh cannot replace a directory.");
        byte[] bytes=new byte[8192];Check(PInvoke.CfGetPlaceholderInfo(handle,CF_PLACEHOLDER_INFO_CLASS.CF_PLACEHOLDER_INFO_STANDARD,bytes,out uint returned));
        fixed(byte* buffer=bytes) {
            int start=Marshal.OffsetOf<CF_PLACEHOLDER_STANDARD_INFO>(nameof(CF_PLACEHOLDER_STANDARD_INFO.FileIdentity)).ToInt32();
            if(returned<start||returned>bytes.Length)throw new IOException("Invalid placeholder metadata.");
            var info=(CF_PLACEHOLDER_STANDARD_INFO*)buffer;
            if(info->FileIdentityLength>4096||start+info->FileIdentityLength>returned||info->SyncRootFileId!=rootFileId||Encoding.UTF8.GetString(bytes,start,(int)info->FileIdentityLength)!=previous)throw new IOException("Placeholder revision changed; cached bytes were preserved.");
            if(info->InSyncState!=CF_IN_SYNC_STATE.CF_IN_SYNC_STATE_IN_SYNC||info->ModifiedDataSize>0)throw new IOException("Local edits prevent remote refresh.");
            if(info->PinState==CF_PIN_STATE.CF_PIN_STATE_PINNED)throw new IOException("Pinned files need a downloaded replacement before refresh.");
        }
        var metadata=new CF_FS_METADATA{FileSize=size,BasicInfo=new(){LastWriteTime=modified}};
        Check(PInvoke.CfUpdatePlaceholder(handle,metadata,identity,ReadOnlySpan<CF_FILE_RANGE>.Empty,CF_UPDATE_FLAGS.CF_UPDATE_FLAG_VERIFY_IN_SYNC|CF_UPDATE_FLAGS.CF_UPDATE_FLAG_MARK_IN_SYNC|CF_UPDATE_FLAGS.CF_UPDATE_FLAG_DEHYDRATE));
    }
    static void Cache(JsonElement message)
    {
        var relative=Text(message,"path");var command=Text(message,"command");
        var info=JsonSerializer.SerializeToElement(Inspect(relative));
        if(!info.GetProperty("exists").GetBoolean())throw new IOException("The Drive file is missing.");
        if(!info.TryGetProperty("cloud",out var cloud)||!cloud.GetBoolean())throw new IOException("Local edits or replacement files must be synced before changing cached data.");
        if((command=="dehydrate"||command=="hydrate")&&(!info.GetProperty("inSync").GetBoolean()||info.GetProperty("modifiedBytes").GetInt64()>0))throw new IOException("Local edits must be synced before changing cached data.");
        if(command=="dehydrate"&&info.GetProperty("pinState").GetInt32()==(int)CF_PIN_STATE.CF_PIN_STATE_PINNED)throw new IOException("Pinned files cannot be removed from the cache.");
        using var handle=OpenMetadata(relative,0x40080); // WRITE_DAC permits attribute-only cloud operations without implicit reads.
        if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        switch(command) {
            case "pin": Check(PInvoke.CfSetPinState(handle,CF_PIN_STATE.CF_PIN_STATE_PINNED,CF_SET_PIN_FLAGS.CF_SET_PIN_FLAG_NONE));break;
            case "unpin": Check(PInvoke.CfSetPinState(handle,CF_PIN_STATE.CF_PIN_STATE_UNSPECIFIED,CF_SET_PIN_FLAGS.CF_SET_PIN_FLAG_NONE));break;
            case "hydrate": Check(PInvoke.CfHydratePlaceholder(handle,0,-1,CF_HYDRATE_FLAGS.CF_HYDRATE_FLAG_NONE));break;
            case "dehydrate": Check(PInvoke.CfDehydratePlaceholder(handle,0,-1,CF_DEHYDRATE_FLAGS.CF_DEHYDRATE_FLAG_NONE));break;
        }
    }
    static void Transfer(CF_CALLBACK_INFO info,long offset,long length,byte[]? data)
    {
        var operation=new CF_OPERATION_INFO{StructSize=(uint)sizeof(CF_OPERATION_INFO),Type=CF_OPERATION_TYPE.CF_OPERATION_TYPE_TRANSFER_DATA,ConnectionKey=info.ConnectionKey,TransferKey=info.TransferKey,RequestKey=info.RequestKey};
        var parameters=new CF_OPERATION_PARAMETERS{ParamSize=(uint)(Marshal.OffsetOf<CF_OPERATION_PARAMETERS>(nameof(CF_OPERATION_PARAMETERS.Anonymous)).ToInt32()+sizeof(CF_OPERATION_PARAMETERS._Anonymous_e__Union._TransferData_e__Struct))};
        parameters.TransferData.Offset=offset;parameters.TransferData.Length=length;
        parameters.TransferData.CompletionStatus=new NTSTATUS(data==null?unchecked((int)0xC0000001):0);
        fixed(byte* buffer=data){parameters.TransferData.Buffer=buffer;Check(PInvoke.CfExecute(in operation,ref parameters));}
    }
    static void Cancel(CF_CALLBACK_INFO* source,CF_CALLBACK_PARAMETERS* parameters)
    {
        foreach(var entry in TransferRequests)if(entry.Value.Transfer==source->TransferKey&&entry.Value.Request==source->RequestKey) {
            if(Pending.TryRemove(entry.Key,out var completion))completion.TrySetException(new OperationCanceledException("Windows cancelled the cloud read."));
            try{Emit(new {@event="cancelFetchData",id=entry.Key});}catch{}
        }
    }
    static (string Local,string Identity) DeleteContext(CF_CALLBACK_INFO info)
    {
        if(disconnecting||!connected||root==null||info.SyncRootFileId!=rootFileId||info.SyncRootIdentity==null||info.SyncRootIdentityLength>4096||info.FileIdentity==null||info.FileIdentityLength>4096)throw new IOException("Invalid deletion ownership metadata.");
        if(Encoding.UTF8.GetString(new ReadOnlySpan<byte>(info.SyncRootIdentity,(int)info.SyncRootIdentityLength))!=rootIdentity)throw new IOException("The deletion belongs to another Drive identity.");
        var absolute=Path.GetFullPath(info.VolumeDosName.ToString()+info.NormalizedPath.ToString());
        var relative=Path.GetRelativePath(root,absolute).Replace('\\','/');
        if(relative=="."||Path.IsPathRooted(relative))throw new IOException("Deletion cannot affect the Drive root or an external path.");
        foreach(var part in relative.Split('/'))ValidateName(part);
        var identity=Encoding.UTF8.GetString(new ReadOnlySpan<byte>(info.FileIdentity,(int)info.FileIdentityLength));
        return (relative,identity);
    }
    static void AcknowledgeDelete(CF_CALLBACK_INFO info,bool allowed)
    {
        var operation=new CF_OPERATION_INFO{StructSize=(uint)sizeof(CF_OPERATION_INFO),Type=CF_OPERATION_TYPE.CF_OPERATION_TYPE_ACK_DELETE,ConnectionKey=info.ConnectionKey,TransferKey=info.TransferKey,RequestKey=info.RequestKey};
        var parameters=new CF_OPERATION_PARAMETERS{ParamSize=(uint)(Marshal.OffsetOf<CF_OPERATION_PARAMETERS>(nameof(CF_OPERATION_PARAMETERS.Anonymous)).ToInt32()+sizeof(CF_OPERATION_PARAMETERS._Anonymous_e__Union._AckDelete_e__Struct))};
        parameters.AckDelete.Flags=CF_OPERATION_ACK_DELETE_FLAGS.CF_OPERATION_ACK_DELETE_FLAG_NONE;
        parameters.AckDelete.CompletionStatus=new NTSTATUS(allowed?0:unchecked((int)0xC0000001));
        Check(PInvoke.CfExecute(in operation,ref parameters));
    }
    static void NotifyDelete(CF_CALLBACK_INFO* source,CF_CALLBACK_PARAMETERS* parameters)
    {
        var info=*source;string? id=null;string stage="request-kind";
        try{
            if(parameters->Delete.Flags!=CF_CALLBACK_DELETE_FLAGS.CF_CALLBACK_DELETE_FLAG_NONE)throw new IOException("This deletion request is not a regular file deletion.");
            stage="ownership";var context=DeleteContext(info);stage="metadata-open";using var handle=OpenMetadata(context.Local,0x80,FILE_SHARE_MODE.FILE_SHARE_READ|FILE_SHARE_MODE.FILE_SHARE_DELETE);
            if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            stage="metadata-clean";var metadata=JsonSerializer.SerializeToElement(InspectHandle(handle));
            if(!metadata.GetProperty("cloud").GetBoolean()||metadata.GetProperty("directory").GetBoolean()||!metadata.GetProperty("inSync").GetBoolean()||metadata.GetProperty("modifiedBytes").GetInt64()!=0||Text(metadata,"identity")!=context.Identity||Text(metadata,"fileId")!=info.FileId.ToString())throw new IOException("Local edits or changed ownership prevent cloud deletion.");
            stage="cloud-confirmation";id="delete-"+Guid.NewGuid().ToString("N");var completion=new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);Pending[id]=completion;
            if(disconnecting)throw new OperationCanceledException("The Drive provider is disconnecting.");
            Emit(new {@event="notifyDelete",id,path=context.Local,identity=context.Identity,size=info.FileSize});
            if(!completion.Task.Wait(TimeSpan.FromSeconds(50)))throw new TimeoutException("Cloud deletion timed out; its recorded outcome must be checked.");
            if(!completion.Task.Result.GetProperty("ok").GetBoolean())throw new IOException("Cloud deletion was not verified; the local file was preserved.");
            stage="ack-delete";AcknowledgeDelete(info,true);
        }catch(Exception error){try{AcknowledgeDelete(info,false);}catch{}try{Emit(new {@event="deleteError",stage,error=error.Message});}catch{}}
        finally{if(id!=null)Pending.TryRemove(id,out _);}
    }
    static void DeleteCompleted(CF_CALLBACK_INFO* source,CF_CALLBACK_PARAMETERS* parameters)
    {
        try{var context=DeleteContext(*source);Emit(new {@event="deleteCompleted",path=context.Local,identity=context.Identity,size=source->FileSize});}
        catch{try{Emit(new {@event="deleteError",error="Deletion completion ownership could not be confirmed."});}catch{}}
    }
    static void Fetch(CF_CALLBACK_INFO* source,CF_CALLBACK_PARAMETERS* parameters)
    {
        var info=*source;long offset=parameters->FetchData.RequiredFileOffset,length=parameters->FetchData.RequiredLength;
        try {
            if(info.FileIdentityLength>4096||info.FileIdentity==null||offset<0||length<0||offset>info.FileSize||length>info.FileSize-offset||offset%4096!=0)throw new IOException("Invalid hydration request.");
            var identity=Encoding.UTF8.GetString(new ReadOnlySpan<byte>(info.FileIdentity,(int)info.FileIdentityLength));
            long end=Math.Min(info.FileSize,checked((checked(offset+length)+4095)/4096*4096));
            while(offset<end) {
                int count=(int)Math.Min(8*1024*1024,end-offset);string id="fetch-"+Guid.NewGuid().ToString("N");
                var completion=new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);Pending[id]=completion;TransferRequests[id]=(info.TransferKey,info.RequestKey);
                try {
                    if(disconnecting)throw new OperationCanceledException("The Drive provider is disconnecting.");
                    Emit(new {@event="fetchData",id,identity,offset,length=count});
                    if(!completion.Task.Wait(TimeSpan.FromSeconds(30)))throw new TimeoutException("Drive hydration timed out.");
                    var reply=completion.Task.Result;
                    if(!reply.GetProperty("ok").GetBoolean())throw new IOException("Drive hydration failed.");
                    var data=Convert.FromBase64String(Text(reply,"data"));if(data.Length!=count)throw new IOException("Drive hydration returned incomplete data.");
                    Transfer(info,offset,count,data);offset+=count;
                }finally {Pending.TryRemove(id,out _);TransferRequests.TryRemove(id,out _);}
            }
        }catch(Exception error) {
            try{Transfer(info,offset,Math.Max(1,Math.Min(length,info.FileSize-offset)),null);}catch{}
            try{Emit(new {@event="hydrationError",error=error.Message});}catch{}
        }
    }
}
