import Foundation
import FSKit
import DriveCore
import os

private let log = Logger(subsystem: "com.local.meetingnotes.drive.fs", category: "fs")

@objc
final class DriveFileSystem: FSUnaryFileSystem, FSUnaryFileSystemOperations {
    private static let containerID = FSContainerIdentifier(uuid: UUID(uuidString: "3F1530F1-58C3-49ED-9BB6-A98598949F6C")!)

    func probeResource(resource: FSResource, replyHandler: @escaping (FSProbeResult?, (any Error)?) -> Void) {
        guard resource is FSGenericURLResource else { replyHandler(.notRecognized, nil); return }
        replyHandler(.usable(name: "Ember Drive", containerID: Self.containerID), nil)
    }

    func loadResource(resource: FSResource, options: FSTaskOptions, replyHandler: @escaping (FSVolume?, (any Error)?) -> Void) {
        guard let paths = SharedPaths.appGroupPaths(), let config = paths.loadConfig() else {
            log.error("no shared config; open Ember and set up Ember Drive first")
            replyHandler(nil, NSError(domain: NSPOSIXErrorDomain, code: Int(POSIXErrorCode.ENOENT.rawValue)))
            return
        }
        containerStatus = .ready
        replyHandler(DriveVolume(config: config, paths: paths), nil)
    }

    func unloadResource(resource: FSResource, options: FSTaskOptions) async throws {}
}
