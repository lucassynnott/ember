// Ember Record: records the screen (a display, an area of one, or a window) with the microphone
// into an MP4 on this Mac. Ember's own controls are left out of the picture; the camera bubble,
// being a window on screen, is recorded with everything else.
//
//   meeting-notes-record list
//     {"displays":[{"id","width","height","frame":[x,y,w,h]}],"windows":[{"id","app","bundle","title","frame"}]}
//   meeting-notes-record record --out <file.mp4> [--display <id>] [--rect x,y,w,h] [--window <id>]
//       [--include <id,…>] [--exclude <id,…>] [--mic default|none|<name>] [--fps 30]
//   meeting-notes-record record --out <file.mp4> --camera default|<name> [--mic …]   (camera only, no screen)
//     With the screen, --camera-track <name> also records the camera to <file>.camera.mp4, in step
//     with the screen, for the editor to place; --hide-cursor leaves the cursor out so the editor
//     can draw a smooth one from the pointer samples ([seconds, x, y, pressed, shape]).
//   meeting-notes-record export --source <file.mp4> --spec <edit.json> --out <file.mp4|gif>
//       [--camera-source <camera.mp4>] [--format mp4|gif] [--quality high|draft] [--gif-fps 15] [--gif-width 800]
//     Renders an edit from Ember's editor: the kept clips at their speeds, zoomed and framed frame by
//     frame from the spec's camera track. Prints {"type":"progress","value"} and {"type":"done",…}.
//     "cancel" on its input stops it.
//
// Rects and frames are in points, from the top left of the display (or of the main display for
// windows). While recording it reads commands, one per line: pause, resume, stop, cancel; its input
// closing stops it too. It prints JSON lines: {"type":"started"}, {"type":"level","value"},
// {"type":"done","file","thumb","wav","cursor","duration","width","height"}, {"type":"cancelled"}, {"type":"error","message"}.

import AppKit
import AVFoundation
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

/// An error with what lies under it, for the log.
func describe(_ error: Error?) -> String {
    guard let error = error as NSError? else { return "unknown" }
    var parts = ["\(error.domain) \(error.code): \(error.localizedDescription)"]
    if let reason = error.localizedFailureReason { parts.append(reason) }
    if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError { parts.append("under: \(underlying.domain) \(underlying.code) \(underlying.localizedDescription)") }
    return parts.joined(separator: " | ")
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

func ids(_ value: String) -> [CGWindowID] {
    value.split(separator: ",").compactMap { CGWindowID($0.trimmingCharacters(in: .whitespaces)) }
}

struct Options {
    var mode = ""
    var out = ""
    var display: CGDirectDisplayID? = nil
    var window: CGWindowID? = nil
    var rect: CGRect? = nil
    var include: [CGWindowID] = []
    var exclude: [CGWindowID] = []
    var mic = "default"
    var camera: String? = nil
    // With the screen: the camera as its own video beside it, and the system cursor left out.
    var cameraTrack: String? = nil
    var hideCursor = false
    var systemAudio = false
    var fps = 30
    var source = ""
    var spec = ""
    var cameraSource: String? = nil
    var backgroundVideo: String? = nil
    var systemSource: String? = nil
    var format = "mp4"
    var quality = "high"
    var gifFps = 15
    var gifWidth = 800
}

func parseOptions() -> Options {
    var options = Options()
    var arguments = Array(CommandLine.arguments.dropFirst())
    options.mode = arguments.isEmpty ? "" : arguments.removeFirst()
    func next() -> String { arguments.isEmpty ? "" : arguments.removeFirst() }
    while !arguments.isEmpty {
        switch arguments.removeFirst() {
        case "--out": options.out = next()
        case "--display": options.display = CGDirectDisplayID(next())
        case "--window": options.window = CGWindowID(next())
        case "--rect":
            let parts = next().split(separator: ",").compactMap { Double($0) }
            if parts.count == 4 { options.rect = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3]) }
        case "--include": options.include = ids(next())
        case "--exclude": options.exclude = ids(next())
        case "--mic": options.mic = next()
        case "--camera": options.camera = next()
        case "--camera-track": options.cameraTrack = next()
        case "--hide-cursor": options.hideCursor = true
        case "--system-audio": options.systemAudio = true
        case "--fps": options.fps = max(1, min(60, Int(next()) ?? 30))
        case "--source": options.source = next()
        case "--spec": options.spec = next()
        case "--camera-source": options.cameraSource = next()
        case "--background-video": options.backgroundVideo = next()
        case "--system-source": options.systemSource = next()
        case "--format": options.format = next() == "gif" ? "gif" : "mp4"
        case "--quality": options.quality = next()
        case "--gif-fps": options.gifFps = max(5, min(30, Int(next()) ?? 15))
        case "--gif-width": options.gifWidth = max(240, min(1920, Int(next()) ?? 800))
        default: break
        }
    }
    return options
}

func frameArray(_ rect: CGRect) -> [Double] {
    [rect.origin.x, rect.origin.y, rect.width, rect.height].map { Double($0) }
}

// Windows worth offering: ordinary app windows of a usable size, not Ember's own.
func listSources() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let mine = Set(["com.local.meetingnotes", "com.github.Electron"])
        let displays = content.displays.map { display -> [String: Any] in
            ["id": display.displayID, "width": display.width, "height": display.height, "frame": frameArray(display.frame)]
        }
        let windows = content.windows.compactMap { window -> [String: Any]? in
            guard window.windowLayer == 0, window.frame.width >= 240, window.frame.height >= 160,
                  let app = window.owningApplication, !mine.contains(app.bundleIdentifier) else { return nil }
            return ["id": window.windowID, "app": app.applicationName, "bundle": app.bundleIdentifier,
                    "title": window.title ?? "", "frame": frameArray(window.frame)]
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["displays": displays, "windows": windows]),
           let line = String(data: data, encoding: .utf8) {
            print(line)
        }
        exit(0)
    } catch {
        fail("Screen recording isn't allowed for Ember. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording.")
    }
}

// The microphone Ember is set to use: macOS's default, or one matched by name.
func microphone(named name: String) -> AVCaptureDevice? {
    if name == "none" { return nil }
    let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
    if name == "default" || name.isEmpty { return AVCaptureDevice.default(for: .audio) ?? devices.first }
    func normal(_ label: String) -> String {
        label.replacingOccurrences(of: #"\s+\([^)]*\)\s*$"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces).lowercased()
    }
    let wanted = normal(name)
    return devices.first { normal($0.localizedName) == wanted } ?? AVCaptureDevice.default(for: .audio)
}

// An even size no larger than 3840 on its long side, which every H.264 encoder takes.
func outputSize(_ points: CGSize, scale: CGFloat) -> (Int, Int) {
    var width = points.width * scale, height = points.height * scale
    let fit = min(1, 3840 / max(width, height))
    width *= fit; height *= fit
    return (max(2, Int(width) / 2 * 2), max(2, Int(height) / 2 * 2))
}

// The camera Ember is set to use, matched by name like the microphone.
func camera(named name: String) -> AVCaptureDevice? {
    let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external], mediaType: .video, position: .unspecified).devices
    func normal(_ label: String) -> String {
        label.replacingOccurrences(of: #"\s+\([^)]*\)\s*$"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces).lowercased()
    }
    if name != "default", !name.isEmpty, let match = devices.first(where: { normal($0.localizedName) == normal(name) }) { return match }
    return AVCaptureDevice.default(for: .video) ?? devices.first
}

/// A private copy of a picture (BGRA), row by row.
func copyPixels(_ source: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(source), height = CVPixelBufferGetHeight(source)
    var target: CVPixelBuffer?
    let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
    guard CVPixelBufferCreate(nil, width, height, CVPixelBufferGetPixelFormatType(source), attributes, &target) == kCVReturnSuccess, let target else { return nil }
    CVPixelBufferLockBaseAddress(source, .readOnly)
    CVPixelBufferLockBaseAddress(target, [])
    defer {
        CVPixelBufferUnlockBaseAddress(target, [])
        CVPixelBufferUnlockBaseAddress(source, .readOnly)
    }
    guard let from = CVPixelBufferGetBaseAddress(source), let to = CVPixelBufferGetBaseAddress(target) else { return nil }
    let fromRow = CVPixelBufferGetBytesPerRow(source), toRow = CVPixelBufferGetBytesPerRow(target)
    for row in 0..<height { memcpy(to + row * toRow, from + row * fromRow, min(fromRow, toRow)) }
    return target
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate, AVCaptureVideoDataOutputSampleBufferDelegate {
    let queue = DispatchQueue(label: "ember.record")
    let url: URL
    let width: Int
    let height: Int
    let writer: AVAssetWriter
    let videoInput: AVAssetWriterInput
    var audioInput: AVAssetWriterInput?
    var stream: SCStream?
    var capture: AVCaptureSession?
    var cameraSession: AVCaptureSession?

    var started = false
    var sessionStart = CMTime.invalid
    var lastVideo = CMTime.invalid
    var lastFrame: CMSampleBuffer?
    var stillFrame: CVPixelBuffer?
    var lastAudio = CMTime.invalid
    var paused = false
    var pausedAt = CMTime.invalid
    var offset = CMTime.zero
    var finishing = false
    var levelPeak: Float = 0
    var levelEmitted = CMTime.invalid
    // Where the pointer was and whether it was pressed, for the editor's zoom on clicks:
    // [seconds into the video, x, y (0 to 1 across the picture), pressed].
    var region: CGRect? = nil
    var pointer: [[Double]] = []
    var pointerTimer: DispatchSourceTimer?
    var cursorShape = 0.0
    var cursorTimer: Timer?
    var hideCursor = false
    // The camera's own video, when it's recorded beside the screen.
    var cameraWriter: AVAssetWriter?
    var cameraInput: AVAssetWriterInput?
    var cameraURL: URL?
    var cameraIsMain = false
    var lastCamera = CMTime.invalid
    // What the Mac plays, in its own file beside the recording.
    var systemWriter: AVAssetWriter?
    var systemInput: AVAssetWriterInput?
    var systemURL: URL?
    var lastSystem = CMTime.invalid

    init(url: URL, width: Int, height: Int, fps: Int) throws {
        self.url = url
        self.width = width
        self.height = height
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        // Not written in fragments: with them, saving failed now and then (AVFoundation -16341).
        writer.shouldOptimizeForNetworkUse = false
        let pixels = Double(width * height)
        let bitrate = Int(min(16_000_000, max(2_500_000, pixels * Double(fps) * 0.075)))
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: fps * 2,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        videoInput.expectsMediaDataInRealTime = true
        super.init()
        guard writer.canAdd(videoInput) else { throw NSError(domain: "record", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't set up the video."]) }
        writer.add(videoInput)
    }

    func addMicrophone(_ device: AVCaptureDevice) {
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 128_000,
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { return }
        writer.add(input)
        audioInput = input

        let session = AVCaptureSession()
        guard let deviceInput = try? AVCaptureDeviceInput(device: device), session.canAddInput(deviceInput) else {
            emit(["type": "warning", "message": "Couldn't open the microphone, so this recording has no sound."])
            return
        }
        session.addInput(deviceInput)
        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
        ]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        capture = session
    }

    func start(filter: SCContentFilter, sourceRect: CGRect?, fps: Int) async throws {
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        if let sourceRect { configuration.sourceRect = sourceRect }
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.showsCursor = !hideCursor
        configuration.queueDepth = 6
        if systemWriter != nil {
            configuration.capturesAudio = true
            configuration.sampleRate = 48_000
            configuration.channelCount = 2
            configuration.excludesCurrentProcessAudio = true
        }
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.colorSpaceName = CGColorSpace.sRGB
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if systemWriter != nil { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
        self.stream = stream
        capture?.startRunning()
        try await stream.startCapture()
    }

    // Where the pointer is, about 30 times a second, for zooms and the editor's cursor.
    func trackPointer(in region: CGRect) {
        self.region = region
        // Which cursor macOS is showing (arrow, hand, text…), read on the main thread.
        DispatchQueue.main.async {
            self.cursorTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                guard let self else { return }
                let shape = Double(cursorShapeIndex())
                self.queue.async { self.cursorShape = shape }
            }
        }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        // 60 times a second, so the editor's cursor moves as smoothly as yours did.
        timer.schedule(deadline: .now(), repeating: .milliseconds(16))
        timer.setEventHandler { [weak self] in self?.samplePointer() }
        timer.resume()
        pointerTimer = timer
    }

    func samplePointer() {
        keepVideoFlowing()
        guard started, !paused, !finishing, let region, let location = CGEvent(source: nil)?.location else { return }
        let at = CMTimeGetSeconds(CMTimeSubtract(CMTimeSubtract(hostNow(), offset), sessionStart))
        let x = (location.x - region.minX) / region.width
        let y = (location.y - region.minY) / region.height
        let pressed = CGEventSource.buttonState(.combinedSessionState, button: .left) ? 1.0 : 0.0
        let shape = cursorShape
        if let last = pointer.last, abs(last[1] - x) < 0.0005, abs(last[2] - y) < 0.0005, last[3] == pressed, last[4] == shape { return }
        pointer.append([(at * 1000).rounded() / 1000, (x * 10000).rounded() / 10000, (y * 10000).rounded() / 10000, pressed, shape])
    }

    func writePointer() -> String? {
        guard let region, !pointer.isEmpty else { return nil }
        let file = url.deletingPathExtension().appendingPathExtension("cursor.json")
        let object: [String: Any] = ["version": 2, "region": [region.minX, region.minY, region.width, region.height], "shapes": CURSOR_SHAPES.map { $0.name }, "cursorHidden": hideCursor, "samples": pointer]
        guard let data = try? JSONSerialization.data(withJSONObject: object), (try? data.write(to: file)) != nil else { return nil }
        return file.path
    }

    func addSystemAudio() throws {
        let file = url.deletingPathExtension().appendingPathExtension("system.m4a")
        try? FileManager.default.removeItem(at: file)
        let writer = try AVAssetWriter(outputURL: file, fileType: .m4a)
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 160_000,
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw NSError(domain: "record", code: 3, userInfo: [NSLocalizedDescriptionKey: "Couldn't set up system audio."]) }
        writer.add(input)
        systemWriter = writer
        systemInput = input
        systemURL = file
    }

    // The camera recorded beside the screen, into its own file, timed like the screen.
    func addCameraTrack(_ session: AVCaptureSession, output: AVCaptureVideoDataOutput, width: Int, height: Int) throws {
        let file = url.deletingPathExtension().appendingPathExtension("camera.mp4")
        try? FileManager.default.removeItem(at: file)
        let writer = try AVAssetWriter(outputURL: file, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 6_000_000, AVVideoMaxKeyFrameIntervalKey: 60],
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw NSError(domain: "record", code: 2, userInfo: [NSLocalizedDescriptionKey: "Couldn't set up the camera."]) }
        writer.add(input)
        cameraWriter = writer
        cameraInput = input
        cameraURL = file
        output.setSampleBufferDelegate(self, queue: queue)
        cameraSession = session
        session.startRunning()
    }

    // Camera only: frames from the camera instead of the screen.
    func startCamera(_ session: AVCaptureSession, output: AVCaptureVideoDataOutput) {
        cameraIsMain = true
        output.setSampleBufferDelegate(self, queue: queue)
        cameraSession = session
        capture?.startRunning()
        session.startRunning()
    }

    // Moves a buffer's timing back by the time spent paused, so the video plays straight through.
    func append(_ buffer: CMSampleBuffer, to input: AVAssetWriterInput, last: inout CMTime) {
        let at = CMTimeSubtract(buffer.presentationTimeStamp, offset)
        guard started, CMTimeCompare(at, sessionStart) >= 0, !last.isValid || CMTimeCompare(at, last) > 0, input.isReadyForMoreMediaData else { return }
        var count: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
        var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: max(1, count))
        if count > 0 {
            CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count)
        } else {
            timing[0] = CMSampleTimingInfo(duration: buffer.duration, presentationTimeStamp: buffer.presentationTimeStamp, decodeTimeStamp: .invalid)
        }
        for index in timing.indices {
            timing[index].presentationTimeStamp = CMTimeSubtract(timing[index].presentationTimeStamp, offset)
            timing[index].decodeTimeStamp = .invalid
            // A screen frame lasts until the next one (macOS only sends one when something changes).
            if input.mediaType == .video { timing[index].duration = .invalid }
        }
        var copy: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: buffer, sampleTimingEntryCount: timing.count, sampleTimingArray: &timing, sampleBufferOut: &copy)
        if let copy, input.append(copy) { last = at }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        if type == .audio {
            guard buffer.isValid, !finishing, !paused, started, let systemInput else { return }
            append(buffer, to: systemInput, last: &lastSystem)
            return
        }
        guard type == .screen, buffer.isValid, !finishing, !paused, buffer.imageBuffer != nil else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = attachments.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete, status != .started {
            return
        }
        appendFrame(buffer)
    }

    // macOS only sends a frame when the screen changes. While it's still, the last frame is repeated
    // every half second, so the file keeps being written (and a recording cut short still plays).
    func keepVideoFlowing() {
        guard started, !paused, !finishing, !cameraIsMain, let frame = lastFrame, lastVideo.isValid else { return }
        let now = CMTimeSubtract(hostNow(), offset)
        guard CMTimeGetSeconds(CMTimeSubtract(now, lastVideo)) >= 0.5 else { return }
        // A copy of the picture: the screen capture's own buffers are recycled, and handing one to the
        // encoder twice breaks the file.
        if stillFrame == nil, let source = frame.imageBuffer { stillFrame = copyPixels(source) }
        guard let still = stillFrame else { return }
        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: still, formatDescriptionOut: &format)
        guard let format else { return }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: hostNow(), decodeTimeStamp: .invalid)
        var copy: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: still, formatDescription: format, sampleTiming: &timing, sampleBufferOut: &copy)
        if let copy { append(copy, to: videoInput, last: &lastVideo) }
    }

    func appendFrame(_ buffer: CMSampleBuffer) {
        if !cameraIsMain {
            lastFrame = buffer
            stillFrame = nil
        }
        if !started {
            guard writer.startWriting() else { fail(writer.error?.localizedDescription ?? "Couldn't start the recording file.") }
            sessionStart = buffer.presentationTimeStamp
            writer.startSession(atSourceTime: sessionStart)
            if let cameraWriter, cameraWriter.startWriting() { cameraWriter.startSession(atSourceTime: sessionStart) }
            if let systemWriter, systemWriter.startWriting() { systemWriter.startSession(atSourceTime: sessionStart) }
            started = true
            emit(["type": "started"])
        }
        append(buffer, to: videoInput, last: &lastVideo)
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput buffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !finishing else { return }
        if output is AVCaptureVideoDataOutput {
            guard !paused, buffer.isValid, buffer.imageBuffer != nil else { return }
            if cameraIsMain {
                appendFrame(buffer)
            } else if started, let cameraInput {
                append(buffer, to: cameraInput, last: &lastCamera)
            }
            return
        }
        reportLevel(buffer)
        guard !paused, let audioInput else { return }
        append(buffer, to: audioInput, last: &lastAudio)
    }

    // The microphone's loudness about ten times a second, for the controls' meter.
    func reportLevel(_ buffer: CMSampleBuffer) {
        guard let block = buffer.dataBuffer else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr, let pointer else { return }
        let samples = UnsafeBufferPointer(start: UnsafeRawPointer(pointer).assumingMemoryBound(to: Float.self), count: length / 4)
        var sum: Float = 0
        for sample in samples { sum += sample * sample }
        levelPeak = max(levelPeak, (sum / Float(max(1, samples.count))).squareRoot())
        let now = buffer.presentationTimeStamp
        if !levelEmitted.isValid || CMTimeGetSeconds(CMTimeSubtract(now, levelEmitted)) >= 0.1 {
            emit(["type": "level", "value": min(1, Double(levelPeak) * 4)])
            levelPeak = 0
            levelEmitted = now
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { if !self.finishing { self.stop(cancel: false, reason: error.localizedDescription) } }
    }

    func hostNow() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

    func command(_ line: String) {
        queue.async {
            switch line.trimmingCharacters(in: .whitespacesAndNewlines) {
            case "pause" where !self.paused:
                self.paused = true
                self.pausedAt = self.hostNow()
            case "resume" where self.paused:
                self.offset = CMTimeAdd(self.offset, CMTimeSubtract(self.hostNow(), self.pausedAt))
                self.paused = false
            case "stop": self.stop(cancel: false)
            case "cancel": self.stop(cancel: true)
            default: break
            }
        }
    }

    // Called on the queue.
    func stop(cancel: Bool, reason: String? = nil) {
        guard !finishing else { return }
        finishing = true
        pointerTimer?.cancel()
        let end = CMTimeSubtract(paused ? pausedAt : hostNow(), offset)
        capture?.stopRunning()
        cameraSession?.stopRunning()
        DispatchQueue.main.async { self.cursorTimer?.invalidate() }
        let stream = self.stream
        Task {
            try? await stream?.stopCapture()
            self.queue.async { self.finish(cancel: cancel, end: end, reason: reason) }
        }
    }

    func finish(cancel: Bool, end: CMTime, reason: String?) {
        guard started else {
            if cancel { emit(["type": "cancelled"]); exit(0) }
            fail(reason ?? "Nothing was recorded. Check that Ember is allowed to record the screen.")
        }
        videoInput.markAsFinished()
        audioInput?.markAsFinished()
        let last = lastVideo.isValid && CMTimeCompare(lastVideo, end) > 0 ? lastVideo : end
        writer.endSession(atSourceTime: last)
        let duration = CMTimeGetSeconds(CMTimeSubtract(last, sessionStart))
        let cameraDone = DispatchGroup()
        if let cameraWriter, let cameraInput, cameraWriter.status == .writing {
            cameraDone.enter()
            cameraInput.markAsFinished()
            cameraWriter.endSession(atSourceTime: last)
            cameraWriter.finishWriting { cameraDone.leave() }
        }
        if let systemWriter, let systemInput, systemWriter.status == .writing {
            cameraDone.enter()
            systemInput.markAsFinished()
            systemWriter.endSession(atSourceTime: last)
            systemWriter.finishWriting { cameraDone.leave() }
        }
        cameraDone.wait()
        writer.finishWriting {
            if cancel {
                try? FileManager.default.removeItem(at: self.url)
                if let cameraURL = self.cameraURL { try? FileManager.default.removeItem(at: cameraURL) }
                if let systemURL = self.systemURL { try? FileManager.default.removeItem(at: systemURL) }
                emit(["type": "cancelled"])
                exit(0)
            }
            guard self.writer.status == .completed else {
                FileHandle.standardError.write(Data("finish failed: \(describe(self.writer.error))\n".utf8))
                fail(self.writer.error?.localizedDescription ?? "Couldn't save the recording.")
            }
            Task {
                let thumb = await writeThumbnail(for: self.url)
                let wav = await writeWav(for: self.url)
                var done: [String: Any] = ["type": "done", "file": self.url.path, "duration": duration, "width": self.width, "height": self.height]
                if let thumb { done["thumb"] = thumb }
                if let wav { done["wav"] = wav }
                if let cursor = self.writePointer() { done["cursor"] = cursor }
                if let cameraURL = self.cameraURL, self.cameraWriter?.status == .completed, self.lastCamera.isValid { done["camera"] = cameraURL.path }
                if let systemURL = self.systemURL, self.systemWriter?.status == .completed, self.lastSystem.isValid { done["system"] = systemURL.path }
                emit(done)
                exit(0)
            }
        }
    }
}

// A poster frame a second in, for the Recordings page.
func writeThumbnail(for url: URL) async -> String? {
    let asset = AVURLAsset(url: url)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1280, height: 1280)
    let duration = (try? await asset.load(.duration)).map(CMTimeGetSeconds) ?? 0
    let at = CMTime(seconds: min(1, duration / 2), preferredTimescale: 600)
    guard let image = try? await generator.image(at: at).image else { return nil }
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.82]) else { return nil }
    let file = url.deletingPathExtension().appendingPathExtension("jpg")
    return (try? data.write(to: file)) != nil ? file.path : nil
}

// The sound as 16 kHz mono 16-bit WAV, which Ember's transcription reads.
func writeWav(for url: URL) async -> String? {
    let asset = AVURLAsset(url: url)
    guard let track = try? await asset.loadTracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: asset) else { return nil }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ])
    guard reader.canAdd(output) else { return nil }
    reader.add(output)
    guard reader.startReading() else { return nil }
    var pcm = Data()
    while let buffer = output.copyNextSampleBuffer() {
        guard let block = buffer.dataBuffer else { continue }
        let length = CMBlockBufferGetDataLength(block)
        var bytes = Data(count: length)
        bytes.withUnsafeMutableBytes { raw in
            _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
        }
        pcm.append(bytes)
    }
    guard reader.status == .completed, !pcm.isEmpty else { return nil }
    var header = Data()
    func put(_ text: String) { header.append(text.data(using: .ascii)!) }
    func put32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
    func put16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { header.append(contentsOf: $0) } }
    put("RIFF"); put32(UInt32(36 + pcm.count)); put("WAVE")
    put("fmt "); put32(16); put16(1); put16(1); put32(16_000); put32(32_000); put16(2); put16(16)
    put("data"); put32(UInt32(pcm.count))
    let file = url.deletingPathExtension().appendingPathExtension("wav")
    return (try? (header + pcm).write(to: file)) != nil ? file.path : nil
}

func record(_ options: Options) async {
    guard !options.out.isEmpty else { fail("No output file was given.") }
    if let cameraName = options.camera {
        await recordCamera(options, name: cameraName)
        return
    }
    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
        fail("Screen recording isn't allowed for Ember. Allow it in System Settings → Privacy & Security → Screen & System Audio Recording.")
    }

    let filter: SCContentFilter
    var sourceRect: CGRect? = nil
    var points: CGSize
    // What's recorded, in global points from the top left of the main display.
    var captured: CGRect
    if let windowID = options.window {
        guard let window = content.windows.first(where: { $0.windowID == windowID }) else { fail("That window has closed.") }
        // The window, plus the camera bubble when it's over it, cropped to the window.
        let display = content.displays.first { $0.frame.intersects(window.frame) && $0.frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY)) } ?? content.displays.first
        guard let display else { fail("No display was found.") }
        let extras = content.windows.filter { options.include.contains($0.windowID) }
        filter = SCContentFilter(display: display, including: [window] + extras)
        sourceRect = window.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY).intersection(CGRect(origin: .zero, size: display.frame.size))
        points = sourceRect!.size
        captured = sourceRect!.offsetBy(dx: display.frame.minX, dy: display.frame.minY)
    } else {
        let display = content.displays.first { $0.displayID == options.display } ?? content.displays.first { $0.displayID == CGMainDisplayID() } ?? content.displays.first
        guard let display else { fail("No display was found.") }
        let excluded = content.windows.filter { options.exclude.contains($0.windowID) }
        filter = SCContentFilter(display: display, excludingWindows: excluded)
        if let rect = options.rect {
            sourceRect = rect.intersection(CGRect(origin: .zero, size: display.frame.size))
            points = sourceRect!.size
            captured = sourceRect!.offsetBy(dx: display.frame.minX, dy: display.frame.minY)
        } else {
            points = display.frame.size
            captured = display.frame
        }
    }
    guard points.width >= 16, points.height >= 16 else { fail("That area is too small to record.") }

    let (width, height) = outputSize(points, scale: CGFloat(filter.pointPixelScale))
    let recorder: Recorder
    do {
        recorder = try Recorder(url: URL(fileURLWithPath: options.out), width: width, height: height, fps: options.fps)
    } catch {
        fail(error.localizedDescription)
    }
    if let device = microphone(named: options.mic) { recorder.addMicrophone(device) }
    recorder.hideCursor = options.hideCursor
    if options.systemAudio {
        do {
            try recorder.addSystemAudio()
        } catch {
            emit(["type": "warning", "message": "Couldn't record system audio, so this recording has the microphone only."])
        }
    }
    if let name = options.cameraTrack, let (session, output, size) = openCamera(named: name) {
        do {
            try recorder.addCameraTrack(session, output: output, width: size.0, height: size.1)
        } catch {
            emit(["type": "warning", "message": "Couldn't record the camera, so this recording has the screen only."])
        }
    }
    recorder.trackPointer(in: captured)
    activeRecorder = recorder

    Thread.detachNewThread {
        while let line = readLine() { recorder.command(line) }
        recorder.command("stop")
    }
    do {
        try await recorder.start(filter: filter, sourceRect: sourceRect, fps: options.fps)
    } catch {
        fail("Couldn't start recording: \(error.localizedDescription)")
    }
}

// The cursors macOS shows most, told apart by size and hot spot. Anything else counts as the arrow.
let CURSOR_SHAPES: [(name: String, cursor: NSCursor)] = [
    ("arrow", .arrow), ("text", .iBeam), ("pointer", .pointingHand), ("grab", .openHand), ("grabbing", .closedHand),
    ("crosshair", .crosshair), ("resize-x", .resizeLeftRight), ("resize-y", .resizeUpDown), ("not-allowed", .operationNotAllowed),
]
func cursorKey(_ cursor: NSCursor) -> String {
    "\(Int(cursor.image.size.width))x\(Int(cursor.image.size.height))@\(Int(cursor.hotSpot.x)),\(Int(cursor.hotSpot.y))"
}
// Two shapes with the same size and hot spot can't be told apart (on recent macOS the arrow, which has
// no readable picture, matches "not allowed"), so a match is only trusted when it's unique, and the
// not-allowed cursor isn't recognised at all: anything unsure is the arrow.
let CURSOR_KEYS: [String: Int] = {
    var keys: [String: Int] = [:]
    var seen: [String: Int] = [:]
    for (index, shape) in CURSOR_SHAPES.enumerated() where shape.name != "not-allowed" {
        let key = cursorKey(shape.cursor)
        seen[key, default: 0] += 1
        keys[key] = index
    }
    return keys.filter { seen[$0.key] == 1 }
}()
func cursorShapeIndex() -> Int {
    guard let current = NSCursor.currentSystem else { return 0 }
    if let index = CURSOR_KEYS[cursorKey(current)] { return index }
    // The text cursor has no readable picture to match, but it's the only tall, narrow one.
    let size = current.image.size
    if size.width > 0, size.width <= 12, size.height >= 14, size.height > size.width * 1.5 { return 1 }
    return 0
}

// macOS's own cursors as PNGs, for the editor to draw: <out>/<shape>.png and cursors.json with each
// one's size and hot spot (in points; the PNGs are at the cursor's best resolution).
func writeCursors(_ out: String) -> Never {
    let folder = URL(fileURLWithPath: out)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var entries: [[String: Any]] = []
    for (name, cursor) in CURSOR_SHAPES {
        let image = cursor.image
        // Drawn at 4× so they stay sharp when drawn big. Cursors macOS draws itself (the arrow and
        // the text cursor on recent versions) have no image: the editor draws those.
        let scale: CGFloat = 4
        guard image.size.width >= 1, image.size.height >= 1 else { continue }
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(image.size.width * scale), pixelsHigh: Int(image.size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
        rep.size = image.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: CGRect(origin: .zero, size: image.size))
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { continue }
        let file = folder.appendingPathComponent("\(name).png")
        guard (try? png.write(to: file)) != nil else { continue }
        entries.append(["name": name, "file": file.path, "width": image.size.width, "height": image.size.height, "hotX": cursor.hotSpot.x, "hotY": cursor.hotSpot.y])
    }
    if let data = try? JSONSerialization.data(withJSONObject: entries, options: [.prettyPrinted]) {
        try? data.write(to: folder.appendingPathComponent("cursors.json"))
    }
    emit(["type": "done", "cursors": entries.count])
    exit(0)
}

// Brings any video into Ember as a recording: an MP4 (re-wrapped, or re-encoded if it has to be),
// with its poster frame and the 16 kHz WAV for transcribing.
func importVideo(_ source: String, to out: String) async -> Never {
    let asset = AVURLAsset(url: URL(fileURLWithPath: source))
    guard let track = try? await asset.loadTracks(withMediaType: .video).first else { fail("That file has no video Ember can read.") }
    let size = (try? await track.load(.naturalSize)) ?? .zero
    let transform = (try? await track.load(.preferredTransform)) ?? .identity
    let shown = size.applying(transform)
    let target = URL(fileURLWithPath: out)
    try? FileManager.default.removeItem(at: target)
    let presets = AVAssetExportSession.exportPresets(compatibleWith: asset)
    let preset = presets.contains(AVAssetExportPresetPassthrough) ? AVAssetExportPresetPassthrough : AVAssetExportPresetHighestQuality
    guard let session = AVAssetExportSession(asset: asset, presetName: preset) else { fail("Couldn't read that video.") }
    session.outputURL = target
    session.outputFileType = .mp4
    session.shouldOptimizeForNetworkUse = true
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in session.exportAsynchronously { done.resume() } }
    if session.status != .completed {
        // Passthrough can't put every codec in an MP4: encode it instead.
        try? FileManager.default.removeItem(at: target)
        guard let encode = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else { fail("Couldn't convert that video.") }
        encode.outputURL = target
        encode.outputFileType = .mp4
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in encode.exportAsynchronously { done.resume() } }
        guard encode.status == .completed else { fail(encode.error?.localizedDescription ?? "Couldn't convert that video.") }
    }
    let duration = CMTimeGetSeconds((try? await AVURLAsset(url: target).load(.duration)) ?? .zero)
    var done: [String: Any] = ["type": "done", "file": target.path, "duration": duration, "width": Int(abs(shown.width)), "height": Int(abs(shown.height))]
    if let thumb = await writeThumbnail(for: target) { done["thumb"] = thumb }
    if let wav = await writeWav(for: target) { done["wav"] = wav }
    emit(done)
    exit(0)
}

// The loudness of a file's sound as `count` peaks from 0 to 1, for drawing its waveform.
func printPeaks(_ source: String, count: Int) async -> Never {
    let asset = AVURLAsset(url: URL(fileURLWithPath: source))
    guard let track = try? await asset.loadTracks(withMediaType: .audio).first, let reader = try? AVAssetReader(asset: asset) else {
        print("[]")
        exit(0)
    }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 8000, AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
    ])
    reader.add(output)
    reader.startReading()
    var samples: [Int16] = []
    while let buffer = output.copyNextSampleBuffer() {
        guard let block = buffer.dataBuffer else { continue }
        let length = CMBlockBufferGetDataLength(block)
        var chunk = [Int16](repeating: 0, count: length / 2)
        chunk.withUnsafeMutableBytes { raw in _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!) }
        samples.append(contentsOf: chunk)
    }
    let buckets = max(1, min(20000, count))
    let size = max(1, samples.count / buckets)
    var peaks: [Double] = []
    var loudest = 1.0
    for index in 0..<buckets {
        let from = index * size
        if from >= samples.count { peaks.append(0); continue }
        let to = min(samples.count, from + size)
        var peak: Int32 = 0
        for sample in samples[from..<to] { peak = max(peak, abs(Int32(sample))) }
        peaks.append(Double(peak))
        loudest = max(loudest, Double(peak))
    }
    let scaled = peaks.map { (($0 / loudest) * 1000).rounded() / 1000 }
    if let data = try? JSONSerialization.data(withJSONObject: scaled), let line = String(data: data, encoding: .utf8) { print(line) }
    exit(0)
}

func openCamera(named name: String) -> (AVCaptureSession, AVCaptureVideoDataOutput, (Int, Int))? {
    guard let device = camera(named: name) else { return nil }
    let session = AVCaptureSession()
    session.beginConfiguration()
    session.sessionPreset = session.canSetSessionPreset(.hd1920x1080) ? .hd1920x1080 : .hd1280x720
    guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return nil }
    session.addInput(input)
    let output = AVCaptureVideoDataOutput()
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    output.alwaysDiscardsLateVideoFrames = true
    guard session.canAddOutput(output) else { return nil }
    session.addOutput(output)
    session.commitConfiguration()
    let dimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
    return (session, output, outputSize(CGSize(width: CGFloat(dimensions.width), height: CGFloat(dimensions.height)), scale: 1))
}

func recordCamera(_ options: Options, name: String) async {
    guard let (session, output, (width, height)) = openCamera(named: name) else {
        fail("Couldn't open the camera. Allow Ember in System Settings → Privacy & Security → Camera.")
    }
    let recorder: Recorder
    do {
        recorder = try Recorder(url: URL(fileURLWithPath: options.out), width: width, height: height, fps: options.fps)
    } catch {
        fail(error.localizedDescription)
    }
    if let microphone = microphone(named: options.mic) { recorder.addMicrophone(microphone) }
    activeRecorder = recorder
    Thread.detachNewThread {
        while let line = readLine() { recorder.command(line) }
        recorder.command("stop")
    }
    recorder.startCamera(session, output: output)
}

var activeRecorder: Recorder?

// ScreenCaptureKit needs the window server connection an app has; this helper never shows anything.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let options = parseOptions()
Task {
    switch options.mode {
    case "list": await listSources()
    case "record": await record(options)
    case "export": await exportEdit(options)
    case "cursors": writeCursors(options.out)
    case "peaks": await printPeaks(options.source, count: options.fps)
    case "import": await importVideo(options.source, to: options.out)
    default: fail("Usage: meeting-notes-record list | record --out <file.mp4> …")
    }
}
RunLoop.main.run()
