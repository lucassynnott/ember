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
        var confirmed=StorageProviderSyncRootManager.GetSyncRootInformationForId(id)??throw new IOException("Windows did not confirm Explorer registration.");Verify(confirmed,folder,identity);return new {registered=true,id,path=confirmed.Path.Path};
    }
    internal static void Unregister(string folder,string identity)
    {
        var id=Id(identity);var existing=Existing(id);if(existing==null)return;Verify(existing,folder,identity);StorageProviderSyncRootManager.Unregister(id);
    }
}
