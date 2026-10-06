import ExtensionFoundation
import Foundation
import FSKit

@main
struct DriveFSExtension: UnaryFileSystemExtension {
    var fileSystem: FSUnaryFileSystem & FSUnaryFileSystemOperations { DriveFileSystem() }
}
