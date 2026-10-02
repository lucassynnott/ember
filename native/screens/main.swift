// Watches a call's window while it records and saves what's shared on screen: slides, documents,
// anything with real text on it. A frame is kept only when it has changed noticeably since the last
// one and Apple's Vision finds enough text on it, so a grid of faces is never saved.
//
//   meeting-notes-screens --bundle us.zoom.xos --out <folder> [--title <regex>] [--display] [--interval 2]
//
// Prints one JSON line per saved slide: {"type":"slide","index":1,"file":"…","text":"…","at":ms}

import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

struct Options {
    var bundle = ""
    var titlePattern: String? = nil
    var display = false
    var out = ""
    var interval: Double = 2
    var debug = false
}

func parseOptions() -> Options {
    var options = Options()
    var arguments = Array(CommandLine.arguments.dropFirst())
    while !arguments.isEmpty {
        let flag = arguments.removeFirst()
        switch flag {
        case "--bundle": options.bundle = arguments.isEmpty ? "" : arguments.removeFirst()
        case "--title": options.titlePattern = arguments.isEmpty ? nil : arguments.removeFirst()
        case "--display": options.display = true
        case "--debug": options.debug = true
        case "--out": options.out = arguments.isEmpty ? "" : arguments.removeFirst()
        case "--interval": options.interval = Double(arguments.isEmpty ? "2" : arguments.removeFirst()) ?? 2
        default: break
        }
    }
    return options
}

func debugLog(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

// A small greyscale thumbnail. Two of them differ when anything visible changes, even a slide
// with the same layout as the one before.
func thumbnail(_ image: CGImage) -> [UInt8] {
    let width = 48, height = 27
    var pixels = [UInt8](repeating: 0, count: width * height)
    guard let context = CGContext(
        data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
    else { return pixels }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return pixels
}

// Average difference per pixel, 0 to 255.
func difference(_ left: [UInt8], _ right: [UInt8]) -> Double {
    guard left.count == right.count, !left.isEmpty else { return 255 }
    var total = 0
    for index in 0..<left.count { total += abs(Int(left[index]) - Int(right[index])) }
    return Double(total) / Double(left.count)
}

func recognizeText(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    // Fast is accurate enough for slides and documents, and .accurate can stall on some macOS builds.
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = true
    try? VNImageRequestHandler(cgImage: image).perform([request])
    let observations = request.results ?? []
    return observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

func words(_ text: String) -> Set<String> {
    Set(text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count > 2 })
}

func saveJPEG(_ image: CGImage, to url: URL) -> Bool {
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.78]) else { return false }
    return (try? data.write(to: url)) != nil
}

// ScreenCaptureKit needs the window server connection an app has; this helper never shows anything.
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)

let options = parseOptions()
guard !options.out.isEmpty, options.display || !options.bundle.isEmpty else {
    FileHandle.standardError.write(Data("Usage: meeting-notes-screens --bundle <id> --out <folder> [--title <regex>] [--display]\n".utf8))
    exit(2)
}
try? FileManager.default.createDirectory(atPath: options.out, withIntermediateDirectories: true)
let titleRegex = options.titlePattern.flatMap { try? NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }

// Stop when the app closes our input.
Thread.detachNewThread {
    while readLine() != nil {}
    exit(0)
}

var lastThumbnail: [UInt8]? = nil
// Every slide saved so far, so flipping back to an earlier one doesn't save it twice.
var savedWords: [Set<String>] = []
var index = 0

func capture() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        let size: CGSize
        if options.display {
            guard let display = content.displays.first else { return }
            filter = SCContentFilter(display: display, excludingWindows: [])
            size = CGSize(width: display.width, height: display.height)
        } else {
            let candidates = content.windows.filter { window in
                guard window.owningApplication?.bundleIdentifier == options.bundle, window.frame.width >= 480, window.frame.height >= 320 else { return false }
                guard let regex = titleRegex else { return true }
                let title = window.title ?? ""
                return regex.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)) != nil
            }
            if options.debug {
                let mine = content.windows.filter { $0.owningApplication?.bundleIdentifier == options.bundle }
                debugLog("windows=\(content.windows.count) fromApp=\(mine.map { "\($0.title ?? "-") \(Int($0.frame.width))x\(Int($0.frame.height))" }) candidates=\(candidates.count)")
            }
            guard let window = candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { return }
            filter = SCContentFilter(desktopIndependentWindow: window)
            size = window.frame.size
        }
        let configuration = SCStreamConfiguration()
        let scale = min(1, 1600 / max(size.width, 1))
        configuration.width = Int(size.width * scale * 2)
        configuration.height = Int(size.height * scale * 2)
        configuration.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)

        let small = thumbnail(image)
        let change = lastThumbnail.map { difference($0, small) } ?? 255
        defer { lastThumbnail = small }
        // An unchanged picture is skipped. Anything else is read (about 0.1 s) and the text decides,
        // since two slides with the same layout can look alike at thumbnail size.
        if change < 0.25 { return }

        let text = recognizeText(image)
        let found = words(text)
        // A slide or document has real text; a gallery of faces doesn't.
        guard text.count >= 60, found.count >= 8 else { return }
        let seen = savedWords.contains { earlier in
            Double(found.intersection(earlier).count) / Double(max(1, found.union(earlier).count)) > 0.8
        }
        if seen { return }

        index += 1
        let file = URL(fileURLWithPath: options.out).appendingPathComponent(String(format: "slide-%03d.jpg", index))
        guard saveJPEG(image, to: file) else { return }
        savedWords.append(found)
        emit(["type": "slide", "index": index, "file": file.path, "text": String(text.prefix(4000)), "at": Int64(Date().timeIntervalSince1970 * 1000)])
    } catch {
        emit(["type": "error", "message": error.localizedDescription])
    }
}

// Off the main thread: Vision does work on the main queue and would wait forever on a busy one.
Task.detached {
    while true {
        await capture()
        try? await Task.sleep(nanoseconds: UInt64(options.interval * 1_000_000_000))
    }
}
RunLoop.main.run()
