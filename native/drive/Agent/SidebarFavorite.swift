import Foundation
import CoreServices

/// Adds the mounted Ember Drive volume to Finder's sidebar Favourites. Finder only auto-lists volumes that sit on a real disk
/// device, which a network-style FSKit volume doesn't, so we register it the same way dragging it into the sidebar would.
/// LSSharedFileList is deprecated but is still how the sidebar Favourites list is edited.
enum SidebarFavorite {
    @_silgen_name("LSSharedFileListCreate") private static func lsCreate(_ a: CFAllocator?, _ type: CFString, _ opts: CFTypeRef?) -> Unmanaged<AnyObject>?
    @_silgen_name("LSSharedFileListInsertItemURL") private static func lsInsert(_ list: AnyObject, _ after: UnsafeRawPointer?, _ name: CFString?, _ icon: AnyObject?, _ url: CFURL, _ props: CFDictionary?, _ a: CFArray?) -> Unmanaged<AnyObject>?
    @_silgen_name("LSSharedFileListCopySnapshot") private static func lsSnapshot(_ list: AnyObject, _ seed: UnsafeMutablePointer<UInt32>?) -> Unmanaged<CFArray>?
    @_silgen_name("LSSharedFileListItemCopyResolvedURL") private static func lsResolve(_ item: AnyObject, _ flags: UInt32, _ err: UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?

    /// Idempotent. Adds /Volumes/Ember Drive once; does nothing if an entry already points there.
    static func ensureAdded(volume: URL = MountPointSetup.volumesURL) {
        guard let list = lsCreate(nil, "com.apple.LSSharedFileList.FavoriteItems" as CFString, nil)?.takeRetainedValue() else { return }
        let items = (lsSnapshot(list, nil)?.takeRetainedValue() as? [AnyObject]) ?? []
        let already = items.contains { item in
            guard let u = lsResolve(item, 0x1 /* no UI, no mount */, nil)?.takeRetainedValue() as URL? else { return false }
            return u.standardizedFileURL.path == volume.standardizedFileURL.path
        }
        guard !already else { return }
        let last = UnsafeRawPointer(bitPattern: 2)          // kLSSharedFileListItemLast
        _ = lsInsert(list, last, "Ember Drive" as CFString, nil, volume as CFURL, nil, nil)
    }
}
