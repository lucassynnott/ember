using System.IO;
using System.Security.Principal;
using Windows.Security.Cryptography;
using Windows.Storage;
using Windows.Storage.Provider;

[System.Runtime.Versioning.SupportedOSPlatform("windows10.0.19041")]
internal static class ExplorerRegistration
{
    static readonly Guid Provider=new("a08aeeaa-6ad5-4a0e-83fd-60eb1ec12830");
    static string Id(string identity)=>"EmberDrive!"+(WindowsIdentity.GetCurrent().User?.Value??throw new IOException("Windows user identity is unavailable."))+"!"+Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(identity))).ToLowerInvariant();
    static StorageProviderSyncRootInfo? Existing(string id)=>StorageProviderSyncRootManager.GetCurrentSyncRoots().FirstOrDefault(info=>string.Equals(info.Id,id,StringComparison.OrdinalIgnoreCase));
    static void Verify(StorageProviderSyncRootInfo info,string folder,string identity)
    {
        var context=CryptographicBuffer.ConvertBinaryToString(BinaryStringEncoding.Utf8,info.Context);
        if(info.ProviderId!=Provider||!Path.GetFullPath(info.Path.Path).TrimEnd(Path.DirectorySeparatorChar).Equals(Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase)||context!=identity)throw new IOException("The Explorer registration belongs to a different Drive root; it was preserved.");
    }
    internal static object Status(string folder,string identity)
    {
        var id=Id(identity);var info=Existing(id);if(info==null)return new {registered=false,id};Verify(info,folder,identity);return new {registered=true,id,path=info.Path.Path};
    }
    internal static object Register(string folder,string identity)
    {
        if(!StorageProviderSyncRootManager.IsSupported())throw new PlatformNotSupportedException("Windows does not support Explorer cloud-provider registration.");
        var id=Id(identity);var existing=Existing(id);
        if(existing!=null){Verify(existing,folder,identity);return new {registered=true,id,path=existing.Path.Path};}
        // Never replace another provider's shell registration for this folder.
        foreach(var candidate in StorageProviderSyncRootManager.GetCurrentSyncRoots())if(Path.GetFullPath(candidate.Path.Path).Equals(Path.GetFullPath(folder),StringComparison.OrdinalIgnoreCase))throw new IOException("Another Explorer provider already owns this folder.");
        var info=new StorageProviderSyncRootInfo {
            Id=id,Path=StorageFolder.GetFolderFromPathAsync(folder).AsTask().GetAwaiter().GetResult(),
            DisplayNameResource="Ember Drive",IconResource=Environment.ProcessPath+",0",Version="1.11.3",ProviderId=Provider,
            HydrationPolicy=StorageProviderHydrationPolicy.Full,PopulationPolicy=StorageProviderPopulationPolicy.AlwaysFull,
            InSyncPolicy=StorageProviderInSyncPolicy.FileLastWriteTime,HardlinkPolicy=StorageProviderHardlinkPolicy.None,
            ShowSiblingsAsGroup=false,Context=CryptographicBuffer.ConvertStringToBinary(identity,BinaryStringEncoding.Utf8)
        };
        StorageProviderSyncRootManager.Register(info);
        // Read the exact registration back through the keyed API. Shell enumeration
        // can normalize the identifier and is not the acknowledgement of Register.
        // The shell cache is invalidated asynchronously (also accounted for in
        // Microsoft's CloudMirror sample). Retry only observation, never Register.
        Exception? last=null;
        for(int attempt=0;attempt<30;attempt++){
            StorageProviderSyncRootInfo? confirmed=null;
            try{confirmed=StorageProviderSyncRootManager.GetSyncRootInformationForId(id);}catch(Exception error){last=error;}
            if(confirmed!=null){Verify(confirmed,folder,identity);return new {registered=true,id,path=confirmed.Path.Path};}
            Thread.Sleep(100);
        }
        using var registry=Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager\"+id);
        using var users=registry?.OpenSubKey("UserSyncRoots");var sid=WindowsIdentity.GetCurrent().User?.Value;var registeredPath=sid==null?null:users?.GetValue(sid) as string;
        var pathMatches=registeredPath!=null&&Path.GetFullPath(registeredPath).TrimEnd(Path.DirectorySeparatorChar).Equals(Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase);
        throw new IOException($"Windows did not confirm Explorer registration (HRESULT 0x{last?.HResult??0:X8}; shell key present: {registry!=null}; user entries: {users?.ValueCount??0}; user path matches: {pathMatches}; fields: {string.Join(',',registry?.GetValueNames()??[])}).",last);
    }
    internal static object Prepare(string folder,string identity)
    {
        folder=Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar);
        if(string.IsNullOrWhiteSpace(identity)||System.Text.Encoding.UTF8.GetByteCount(identity)>4096||folder==Path.GetPathRoot(folder)?.TrimEnd(Path.DirectorySeparatorChar)||!Directory.Exists(folder)||(File.GetAttributes(folder)&System.IO.FileAttributes.ReparsePoint)!=0||Directory.EnumerateFileSystemEntries(folder).Any())throw new IOException("Initial Explorer registration requires a private empty directory.");
        return Register(folder,identity);
    }
    internal static void Unregister(string folder,string identity)
    {
        var id=Id(identity);var existing=Existing(id);if(existing==null)return;Verify(existing,folder,identity);StorageProviderSyncRootManager.Unregister(id);
    }
}
