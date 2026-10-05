// Reads text, QR codes and barcodes from an image with Apple's Vision, on this Mac. Used for
// "Grab text from screen" (an area picked with the system's crosshair) and images on the clipboard.
// Prints one JSON object and exits.
//
//   meeting-notes-grab file <image> [--fast] [--languages en-US,fr-FR]
//   meeting-notes-grab clipboard [--fast] [--languages …]
//
// {"width":…,"height":…,"lines":[{"text","x","y","w","h"}],"codes":[{"kind","payload"}]}
// Line boxes are in image pixels from the top left.

import AppKit
import Foundation
import Vision

func output(_ object: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
        print(line)
    }
    exit(0)
}

var arguments = Array(CommandLine.arguments.dropFirst())
let mode = arguments.isEmpty ? "" : arguments.removeFirst()
var source = ""
var fast = false
var languages: [String] = []
while !arguments.isEmpty {
    let argument = arguments.removeFirst()
    switch argument {
    case "--fast": fast = true
    case "--languages": languages = (arguments.isEmpty ? "" : arguments.removeFirst()).split(separator: ",").map(String.init)
    default: source = argument
    }
}

func cgImage(_ image: NSImage) -> CGImage? {
    var rect = NSRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

let image: CGImage?
switch mode {
case "file":
    image = NSImage(contentsOfFile: source).flatMap(cgImage)
case "clipboard":
    image = NSImage(pasteboard: NSPasteboard.general).flatMap(cgImage)
default:
    output(["error": "Usage: file <image> | clipboard"])
}
guard let image else { output(["error": mode == "clipboard" ? "There's no image on the clipboard." : "Couldn't read that image."]) }

let width = Double(image.width)
let height = Double(image.height)

let textRequest = VNRecognizeTextRequest()
textRequest.recognitionLevel = fast ? .fast : .accurate
textRequest.usesLanguageCorrection = !fast
if !languages.isEmpty {
    textRequest.recognitionLanguages = languages
} else if #available(macOS 13.0, *) {
    textRequest.automaticallyDetectsLanguage = true
}
let codeRequest = VNDetectBarcodesRequest()

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([textRequest, codeRequest])
} catch {
    output(["error": error.localizedDescription])
}

// Vision's boxes are normalised with the origin at the bottom left.
let lines: [[String: Any]] = (textRequest.results ?? []).compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let box = observation.boundingBox
    return [
        "text": candidate.string,
        "x": (box.minX * width).rounded(),
        "y": ((1 - box.maxY) * height).rounded(),
        "w": (box.width * width).rounded(),
        "h": (box.height * height).rounded(),
    ]
}

var seen = Set<String>()
let codes: [[String: Any]] = (codeRequest.results ?? []).compactMap { observation in
    guard let payload = observation.payloadStringValue, !payload.isEmpty, !seen.contains(payload) else { return nil }
    seen.insert(payload)
    let kind = observation.symbology == .qr ? "qr" : "barcode"
    return ["kind": kind, "payload": payload]
}

output(["width": width, "height": height, "lines": lines, "codes": codes])
