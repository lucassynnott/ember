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
    static readonly ConcurrentDictionary<string,(long Transfer,long Request)> TransferRequests = new();
    static string? root;
    static string? rootIdentity;
    static CF_CONNECTION_KEY connection;
    static bool connected;
    static long rootFileId;
    static int cacheOperations;
    static readonly ConcurrentDictionary<string,CancellationTokenSource> BackupCopies=new();
    sealed record UploadLock(Microsoft.Win32.SafeHandles.SafeFileHandle Handle,string? Identity,string Relative);
    static readonly Dictionary<string,UploadLock> UploadLocks = new();
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
                        case "register": Register(Text(message,"root"),Text(message,"identity"));break;
                        case "create": Create(message);break;
                        case "refresh": Refresh(message);break;
                        case "lockUpload": Emit(new {id,ok=true,upload=LockUpload(Text(message,"path"))});continue;
                        case "unlockUpload": UnlockUpload(Text(message,"token"));break;
                        case "ackUpload": AcknowledgeUpload(message);break;
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
                        case "explorerPrepare": case "explorerStatus": case "explorerRegister": case "explorerUnregister":
                            var preparing=Text(message,"command")=="explorerPrepare";
                            if(preparing&&connected)throw new IOException("Initial Explorer registration requires a disconnected provider.");
                            if(!preparing&&(!connected||root==null||rootIdentity==null))throw new IOException("Drive is not connected.");
                            if(!OperatingSystem.IsWindowsVersionAtLeast(10,0,19041))throw new PlatformNotSupportedException("Explorer integration requires Windows 10 version 2004 or later.");
                            var explorerCommand=Text(message,"command");var explorerRoot=preparing?Text(message,"folder"):root!;var explorerIdentity=preparing?Text(message,"identity"):rootIdentity!;var explorerRequest=id;
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
    static void Disconnect(){foreach(var backup in BackupCopies.Values){try{backup.Cancel();}catch(ObjectDisposedException){}}foreach(var upload in UploadLocks.Values)upload.Handle.Dispose();UploadLocks.Clear();if(connected){Check(PInvoke.CfDisconnectSyncRoot(connection));connected=false;}root=null;}
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
    static void Register(string folder,string identity)
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
            CF_CALLBACK_REGISTRATION[] callbacks=[new(){Type=CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_FETCH_DATA,Callback=FetchCallback},new(){Type=CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_CANCEL_FETCH_DATA,Callback=CancelCallback},new(){Type=CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_NONE}];
            Check(PInvoke.CfConnectSyncRoot(folder,callbacks,null,CF_CONNECT_FLAGS.CF_CONNECT_FLAG_NONE,out connection));
            root=folder;rootIdentity=identity;connected=true;
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
    static object LockUpload(string relative)
    {
        if(UploadLocks.Values.Any(upload=>upload.Relative.Equals(relative,StringComparison.OrdinalIgnoreCase)))throw new IOException("This file already has an upload in progress.");
        if(UploadLocks.Count>=8)throw new IOException("Too many pending Drive uploads.");
        // FILE_READ_DATA makes this handle participate in data-sharing checks.
        // Metadata-only handles do not prevent a competing writer from opening.
        var handle=OpenMetadata(relative,0x40081,FILE_SHARE_MODE.FILE_SHARE_READ);
        try {
            if(handle.IsInvalid)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var local=Path.Combine(root!,relative.Replace('/',Path.DirectorySeparatorChar));var file=new FileInfo(local);
            if(file.LinkTarget!=null||(file.Attributes&FileAttributes.Directory)!=0)throw new IOException("Upload requires a local file without links.");
            var metadata=JsonSerializer.SerializeToElement(InspectHandle(handle));
            bool cloud=metadata.GetProperty("cloud").GetBoolean();
            if(!cloud&&(file.Attributes&FileAttributes.ReparsePoint)!=0)throw new IOException("Another provider's placeholder cannot be uploaded by this Drive.");
            string? identity=cloud?Text(metadata,"identity"):null;
            string token=Guid.NewGuid().ToString("N");UploadLocks[token]=new UploadLock(handle,identity,relative);
            return new {token,cloud,identity,size=file.Length,modified=new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds(),localPath=local};
        }catch{handle.Dispose();throw;}
    }
    static void UnlockUpload(string token){if(UploadLocks.Remove(token,out var upload))upload.Handle.Dispose();}
    static void AcknowledgeUpload(JsonElement message)
    {
        var token=Text(message,"token");if(!UploadLocks.TryGetValue(token,out var upload))throw new IOException("Upload lock is no longer held; local data was preserved.");
        var bytes=Encoding.UTF8.GetBytes(Text(message,"identity"));if(bytes.Length==0||bytes.Length>4096)throw new IOException("Invalid uploaded revision identity.");
        using var identity=JsonDocument.Parse(bytes);var key=Text(identity.RootElement,"key");
        bool revision=identity.RootElement.TryGetProperty("etag",out var etag)&&etag.ValueKind==JsonValueKind.String&&!string.IsNullOrEmpty(etag.GetString());
        revision|=identity.RootElement.TryGetProperty("fileID",out var version)&&version.ValueKind==JsonValueKind.String&&!string.IsNullOrEmpty(version.GetString());
        if(!revision)throw new IOException("Upload acknowledgement requires a confirmed remote revision.");
        if(upload.Identity!=null){using var previous=JsonDocument.Parse(upload.Identity);if(Text(previous.RootElement,"key")!=key)throw new IOException("Upload acknowledgement cannot change the remote key.");}
        if(upload.Identity==null)Check(PInvoke.CfConvertToPlaceholder(upload.Handle,bytes,CF_CONVERT_FLAGS.CF_CONVERT_FLAG_MARK_IN_SYNC));
        else Check(PInvoke.CfUpdatePlaceholder(upload.Handle,null,bytes,ReadOnlySpan<CF_FILE_RANGE>.Empty,CF_UPDATE_FLAGS.CF_UPDATE_FLAG_MARK_IN_SYNC));
        UnlockUpload(token);
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
