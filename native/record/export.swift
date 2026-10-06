// Ember's editor export: renders an edit frame by frame with Core Image, hardware encoded.
//
// The editor works out everything that moves (the part of the recording on screen each frame,
// where the cursor is, which captions and notes show) and hands it over as an EditSpec; this file
// only draws what it's told. Layers, bottom to top:
//   background (gradient, colour, image or a blurred copy of the video) and the video's shadow
//   the recording: blur boxes, then the frame's view of it, framed with rounded corners
//   the camera, placed and shaped
//   overlays (text, arrows, images, captions: pictures made by the editor), fading in and out
//   click ripples, then the cursor
import AppKit
import AVFoundation
import CoreImage
import CoreMedia
import Foundation

struct EditSpec: Decodable {
    struct Background: Decodable {
        let kind: String           // image | video
        let image: Int?            // a sprite, the size of the frame
        let blur: Double?          // for a video background
    }
    struct Webcam: Decodable {
        let track: [[Double]]      // per frame: [t, x, y, w, h, radius] in output pixels from the top left
        let mirror: Bool
        let shadow: Double
        let crop: [Double]         // x, y, w, h of the camera picture, 0 to 1
    }
    struct Layer: Decodable {
        let kind: String           // picture | blur
        let sprite: Int?
        let start: Double, end: Double
        let rect: [Double]         // x, y, w, h in output pixels from the top left
        let fade: Double?
        let fadeIn: Double?, fadeOut: Double?
        let motion: String?        // none | rise | pop
        let amount: Double?        // blur
        let radius: Double?
        let fill: String?
    }
    struct Effect: Decodable {
        let rect: [Double]
        let frames: [[Double]]     // [t, sprite]
    }
    struct CursorSprite: Decodable {
        let sprite: Int
        let hotX: Double, hotY: Double  // in the sprite's pixels
        let size: Double                // the sprite's height that the cursor size refers to
    }
    struct Extra: Decodable {
        let file: String
        let start: Double
        let duration: Double
        let offset: Double?
        let volume: Double
    }
    struct Audio: Decodable {
        let volume: Double?
        let systemVolume: Double?
        let muted: [[Double]]?
        let extras: [Extra]?
    }
    struct Gif: Decodable {
        let fps: Int
        let width: Int
        let loop: Bool
    }

    let clips: [[Double]]            // [start, end, speed, source] in playing order; source 0 is the recording, n is sourceFiles[n - 1]
    let sourceFiles: [String]?
    let width: Int
    let height: Int
    let fps: Int
    let content: [Double]            // where the recording sits, from the top left
    let contentMask: Int?            // its shape (white), the size of content
    let shadows: [[Double]]?         // [blur, offset, opacity]
    let background: Background?
    let view: [[Double]]             // per frame: [t, x, y, w, h] the part of the recording shown, in its pixels from the top left
    let webcam: Webcam?
    let sprites: [String]?           // PNGs, base64
    let layers: [Layer]?
    let effects: [Effect]?
    let cursorSprites: [CursorSprite]?
    let cursor: [[Double]]?          // per frame: [t, x, y, shape, size, squash, rotation, visible]
    let audio: Audio?
    let gif: Gif?
    let encoding: String?
    let motionBlur: [Double]?        // [camera, cursor] strengths; blur follows how fast each moves
}

func hexColor(_ hex: String, alpha: CGFloat = 1) -> CIColor {
    var value: UInt64 = 0
    Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
    return CIColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255, blue: CGFloat(value & 0xff) / 255, alpha: alpha)
}

/// A per-frame track at a time: between the two nearest samples, blended.
func sample(_ track: [[Double]], _ time: Double) -> [Double]? {
    guard !track.isEmpty else { return nil }
    if time <= track[0][0] { return track[0] }
    var low = 0, high = track.count - 1
    if time >= track[high][0] { return track[high] }
    while high - low > 1 {
        let middle = (low + high) / 2
        if track[middle][0] <= time { low = middle } else { high = middle }
    }
    let a = track[low], b = track[high]
    let amount = b[0] > a[0] ? (time - a[0]) / (b[0] - a[0]) : 0
    return zip(a, b).enumerated().map { index, pair in index == 0 ? time : pair.0 + (pair.1 - pair.0) * amount }
}

/// The last sample at or before a time (for values that jump, like the cursor's shape).
func step(_ track: [[Double]], _ time: Double) -> [Double]? {
    guard !track.isEmpty, time >= track[0][0] - 0.0001 else { return nil }
    var low = 0, high = track.count - 1
    if time >= track[high][0] { return track[high] }
    while high - low > 1 {
        let middle = (low + high) / 2
        if track[middle][0] <= time { low = middle } else { high = middle }
    }
    return track[low]
}

final class FrameRenderer {
    let spec: EditSpec
    let canvas: CGRect
    let content: CGRect
    let context = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, .cacheIntermediates: false])
    var sprites: [CIImage] = []
    var backdrop: CIImage?
    var contentMask: CIImage?

    init(spec: EditSpec) {
        self.spec = spec
        canvas = CGRect(x: 0, y: 0, width: CGFloat(spec.width), height: CGFloat(spec.height))
        content = FrameRenderer.rect(spec.content, height: canvas.height)
        sprites = (spec.sprites ?? []).map { base64 in
            Data(base64Encoded: base64).flatMap { CIImage(data: $0, options: [.applyOrientationProperty: false]) } ?? CIImage.empty()
        }
        if let index = spec.contentMask, index < sprites.count { contentMask = place(sprites[index], in: content) }
        if spec.background?.kind == "image", let index = spec.background?.image, index < sprites.count {
            backdrop = shadowed(place(sprites[index], in: canvas))
        }
    }

    static func rect(_ values: [Double], height: CGFloat) -> CGRect {
        guard values.count >= 4 else { return .zero }
        return CGRect(x: values[0], y: Double(height) - values[1] - values[3], width: values[2], height: values[3])
    }

    func place(_ image: CIImage, in rect: CGRect) -> CIImage {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0, rect.width > 0, rect.height > 0 else { return CIImage.empty() }
        return image
            .transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
            .transformed(by: CGAffineTransform(scaleX: rect.width / extent.width, y: rect.height / extent.height))
            .transformed(by: CGAffineTransform(translationX: rect.minX, y: rect.minY))
    }

    func cover(_ image: CIImage, in rect: CGRect) -> CIImage {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return CIImage(color: .black).cropped(to: rect) }
        let scale = max(rect.width / extent.width, rect.height / extent.height)
        let scaled = image.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY).scaledBy(x: scale, y: scale))
        return scaled.transformed(by: CGAffineTransform(translationX: rect.minX - (scaled.extent.width - rect.width) / 2, y: rect.minY - (scaled.extent.height - rect.height) / 2)).cropped(to: rect)
    }

    func faded(_ image: CIImage, _ alpha: Double) -> CIImage {
        if alpha >= 0.999 { return image }
        return image.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(max(0, alpha)))])
    }

    /// The recording's shape, darkened and blurred, under it.
    func shadowed(_ base: CIImage) -> CIImage {
        guard let mask = contentMask, let shadows = spec.shadows, !shadows.isEmpty else { return base }
        var output = base
        for shadow in shadows where shadow.count == 3 {
            let dark = mask.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: 0, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: 0, w: 0), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(shadow[2])),
            ])
            let blurred = dark.transformed(by: CGAffineTransform(translationX: 0, y: -shadow[1])).clampedToExtent().cropped(to: content.insetBy(dx: -shadow[0] * 4, dy: -shadow[0] * 4).offsetBy(dx: 0, dy: -shadow[1]))
                .applyingGaussianBlur(sigma: max(0.5, shadow[0])).cropped(to: canvas)
            output = blurred.composited(over: output)
        }
        return output
    }

    func masked(_ image: CIImage, by mask: CIImage) -> CIImage {
        image.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: CIImage.empty(), kCIInputMaskImageKey: mask])
    }

    func roundedMask(_ rect: CGRect, radius: Double) -> CIImage {
        if radius <= 0.5 { return CIImage(color: .white).cropped(to: rect) }
        return CIFilter(name: "CIRoundedRectangleGenerator", parameters: [
            "inputExtent": CIVector(cgRect: rect), "inputRadius": min(radius, Double(min(rect.width, rect.height)) / 2), "inputColor": CIColor.white,
        ])?.outputImage ?? CIImage(color: .white).cropped(to: rect)
    }

    func frame(at time: Double, screen: CIImage, camera: CIImage?, backgroundVideo: CIImage?) -> CIImage {
        let sourceHeight = screen.extent.height

        // The background (the video one moves, so it's made each frame).
        var output: CIImage
        if let backdrop {
            output = backdrop
        } else if let backgroundVideo {
            var image = cover(backgroundVideo, in: canvas)
            if let blur = spec.background?.blur, blur > 0 { image = image.clampedToExtent().applyingGaussianBlur(sigma: blur / 2).cropped(to: canvas) }
            output = shadowed(image)
        } else {
            output = CIImage(color: .black).cropped(to: canvas)
        }

        // The part of the recording on screen this frame, in its shape. Another recording's clip is
        // shown whole, letterboxed.
        let view = step(spec.view, time).flatMap { $0.count >= 6 && $0[5] > 0.5 ? $0 : nil } ?? sample(spec.view, time) ?? [time, 0, 0, Double(screen.extent.width), Double(sourceHeight)]
        var picture: CIImage
        if view.count >= 6, view[5] > 0.5 {
            let extent = screen.extent
            let scale = min(content.width / extent.width, content.height / extent.height)
            let fitted = screen.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY).scaledBy(x: scale, y: scale))
            let placed = fitted.transformed(by: CGAffineTransform(translationX: content.minX + (content.width - fitted.extent.width) / 2, y: content.minY + (content.height - fitted.extent.height) / 2))
            picture = placed.composited(over: CIImage(color: .black).cropped(to: content)).cropped(to: content)
        } else {
            let left = view[1], top = view[2], w = max(1, view[3]), h = max(1, view[4])
            let bottom = Double(sourceHeight) - top - h
            picture = screen
                .cropped(to: CGRect(x: left, y: bottom, width: w, height: h))
                .transformed(by: CGAffineTransform(translationX: -left, y: -bottom))
                .transformed(by: CGAffineTransform(scaleX: content.width / w, y: content.height / h))
                .transformed(by: CGAffineTransform(translationX: content.minX, y: content.minY))
                .cropped(to: content)
        }
        // Motion blur while the camera pans or zooms quickly.
        if let strength = spec.motionBlur?.first, strength > 0, view.count >= 5, (view.count < 6 || view[5] < 0.5),
           let before = sample(spec.view, time - 1 / Double(max(1, spec.fps))), before.count >= 5 {
            let scale = Double(content.width) / max(1, view[3])
            let dx = ((view[1] + view[3] / 2) - (before[1] + before[3] / 2)) * scale
            let dy = ((view[2] + view[4] / 2) - (before[2] + before[4] / 2)) * scale
            let pan = hypot(dx, dy)
            let zoom = abs(view[3] - before[3]) / max(1, view[3])
            if pan > 2 {
                picture = picture.clampedToExtent().applyingFilter("CIMotionBlur", parameters: [kCIInputRadiusKey: min(40, pan * strength), kCIInputAngleKey: atan2(-dy, dx)]).cropped(to: content)
            }
            if zoom > 0.002 {
                picture = picture.clampedToExtent().applyingFilter("CIZoomBlur", parameters: [kCIInputCenterKey: CIVector(x: content.midX, y: content.midY), kCIInputAmountKey: min(20, zoom * 400 * strength)]).cropped(to: content)
            }
        }
        if let contentMask { picture = masked(picture, by: contentMask) }
        output = picture.composited(over: output)

        // The camera.
        if let camera, let webcam = spec.webcam, let box = sample(webcam.track, time), box.count >= 6, box.count < 7 || (step(webcam.track, time)?[6] ?? 1) > 0.5 {
            let rect = FrameRenderer.rect(Array(box[1...4]), height: canvas.height)
            let extent = camera.extent
            let crop = webcam.crop.count == 4 ? webcam.crop : [0, 0, 1, 1]
            var face = camera.cropped(to: CGRect(x: extent.minX + crop[0] * extent.width, y: extent.minY + (1 - crop[1] - crop[3]) * extent.height, width: crop[2] * extent.width, height: crop[3] * extent.height))
            if webcam.mirror {
                let mid = face.extent.midX
                face = face.transformed(by: CGAffineTransform(translationX: mid, y: 0).scaledBy(x: -1, y: 1).translatedBy(x: -mid, y: 0))
            }
            let mask = roundedMask(rect, radius: box[5])
            face = masked(cover(face, in: rect), by: mask)
            if webcam.shadow > 0 {
                let size = Double(min(rect.width, rect.height))
                let dark = mask.applyingFilter("CIColorMatrix", parameters: [
                    "inputRVector": CIVector(x: 0, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                    "inputBVector": CIVector(x: 0, y: 0, z: 0, w: 0), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(0.55 * webcam.shadow)),
                ])
                output = dark.transformed(by: CGAffineTransform(translationX: 0, y: -size * 0.04)).applyingGaussianBlur(sigma: size * 0.06).cropped(to: canvas).composited(over: output)
            }
            output = face.composited(over: output)
        }

        // Notes and captions, in order; a blur box blurs what's under it.
        for layer in spec.layers ?? [] where time >= layer.start && time <= layer.end {
            var rect = FrameRenderer.rect(layer.rect, height: canvas.height)
            if layer.kind == "blur" {
                let mask = roundedMask(rect, radius: layer.radius ?? 0)
                let cover: CIImage
                if let fill = layer.fill { cover = CIImage(color: hexColor(fill)).cropped(to: rect) } else {
                    cover = output.clampedToExtent().applyingGaussianBlur(sigma: max(1, layer.amount ?? 10)).cropped(to: rect)
                }
                output = masked(cover, by: mask).composited(over: output)
                continue
            }
            guard let index = layer.sprite, index < sprites.count else { continue }
            let fadeIn = layer.fadeIn ?? layer.fade ?? 0, fadeOut = layer.fadeOut ?? layer.fade ?? 0
            let into = fadeIn > 0 ? min(1, (time - layer.start) / fadeIn) : 1
            let outOf = fadeOut > 0 ? min(1, (layer.end - time) / fadeOut) : 1
            let alpha = max(0, min(into, outOf))
            switch layer.motion {
            case "rise": rect = rect.offsetBy(dx: 0, dy: -CGFloat(1 - into) * rect.height * 0.4)
            case "pop":
                let scale = 0.85 + 0.15 * CGFloat(into)
                rect = rect.insetBy(dx: rect.width * (1 - scale) / 2, dy: rect.height * (1 - scale) / 2)
            default: break
            }
            output = faded(place(sprites[index], in: rect), alpha).composited(over: output)
        }

        // Click effects.
        for effect in spec.effects ?? [] {
            guard let first = effect.frames.first, let last = effect.frames.last, time >= first[0], time <= last[0], let current = step(effect.frames, time) else { continue }
            let index = Int(current[1])
            guard index < sprites.count else { continue }
            output = place(sprites[index], in: FrameRenderer.rect(effect.rect, height: canvas.height)).composited(over: output)
        }

        // The cursor: its shape jumps, its place, size and tilt glide.
        if let track = spec.cursor, let shapes = spec.cursorSprites, let point = sample(track, time), let shown = step(track, time), point.count >= 8, shown[7] > 0.5 {
            let shapeIndex = Int(shown[3])
            if shapeIndex >= 0, shapeIndex < shapes.count, shapes[shapeIndex].sprite < sprites.count {
                let shape = shapes[shapeIndex]
                let sprite = sprites[shape.sprite]
                let scale = point[4] / max(1, shape.size)
                let squash = point[5], tilt = point[6]
                // Built around the hot spot: scaled (squashed on clicks), tilted, then moved to the tip.
                let height = Double(sprite.extent.height)
                var transform = CGAffineTransform(translationX: -shape.hotX, y: -(height - shape.hotY))
                transform = transform.concatenating(CGAffineTransform(scaleX: scale * (2 - squash), y: scale * squash))
                transform = transform.concatenating(CGAffineTransform(rotationAngle: -CGFloat(tilt) * .pi / 180))
                transform = transform.concatenating(CGAffineTransform(translationX: point[1], y: Double(canvas.height) - point[2]))
                var image = sprite.transformed(by: CGAffineTransform(translationX: -sprite.extent.minX, y: -sprite.extent.minY)).transformed(by: transform)
                // A fast-moving cursor blurs along its path.
                if let strength = spec.motionBlur?.last, strength > 0, let before = sample(track, time - 1 / Double(max(1, spec.fps))), before.count >= 3 {
                    let dx = point[1] - before[1], dy = point[2] - before[2]
                    let speed = hypot(dx, dy)
                    if speed > 6 {
                        let extent = image.extent
                        image = image.applyingFilter("CIMotionBlur", parameters: [kCIInputRadiusKey: min(24, speed * 0.25 * strength), kCIInputAngleKey: atan2(-dy, dx)]).cropped(to: extent.insetBy(dx: -30, dy: -30))
                    }
                }
                output = image.composited(over: output)
            }
        }
        return output.cropped(to: canvas)
    }
}

final class EditInstruction: NSObject, AVVideoCompositionInstructionProtocol {
    let timeRange: CMTimeRange
    let enablePostProcessing = false
    let containsTweening = true
    let requiredSourceTrackIDs: [NSValue]?
    let passthroughTrackID = kCMPersistentTrackID_Invalid
    let screenTracks: [CMPersistentTrackID]
    let cameraTrack: CMPersistentTrackID?
    let backgroundTrack: CMPersistentTrackID?

    init(timeRange: CMTimeRange, screens: [CMPersistentTrackID], camera: CMPersistentTrackID?, background: CMPersistentTrackID?) {
        self.timeRange = timeRange
        screenTracks = screens
        cameraTrack = camera
        backgroundTrack = background
        requiredSourceTrackIDs = (screens + (camera.map { [$0] } ?? []) + (background.map { [$0] } ?? [])).map { NSNumber(value: $0) }
    }
}

final class EditCompositor: NSObject, AVVideoCompositing {
    static var renderer: FrameRenderer?
    let queue = DispatchQueue(label: "ember.compositor")
    var sourcePixelBufferAttributes: [String: any Sendable]? { [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA] }
    var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] { [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA] }

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        queue.async {
            guard let renderer = EditCompositor.renderer, let instruction = request.videoCompositionInstruction as? EditInstruction else {
                request.finish(with: NSError(domain: "export", code: 1, userInfo: [NSLocalizedDescriptionKey: "A frame couldn't be drawn."]))
                return
            }
            guard let output = request.renderContext.newPixelBuffer() else {
                request.finish(with: NSError(domain: "export", code: 2, userInfo: [NSLocalizedDescriptionKey: "Ran out of memory drawing a frame."]))
                return
            }
            // Between clips there can be a frame with no picture: it's drawn black rather than failing.
            let found = instruction.screenTracks.lazy.compactMap({ request.sourceFrame(byTrackID: $0) }).first
            let screen = found.map { CIImage(cvPixelBuffer: $0) } ?? CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: 16, height: 9))
            let camera = instruction.cameraTrack.flatMap { request.sourceFrame(byTrackID: $0) }.map { CIImage(cvPixelBuffer: $0) }
            let background = instruction.backgroundTrack.flatMap { request.sourceFrame(byTrackID: $0) }.map { CIImage(cvPixelBuffer: $0) }
            let image = renderer.frame(at: CMTimeGetSeconds(request.compositionTime), screen: screen, camera: camera, backgroundVideo: background)
            renderer.context.render(image, to: output, bounds: renderer.canvas, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
            request.finish(withComposedVideoFrame: output)
        }
    }

    func cancelAllPendingVideoCompositionRequests() {}
}

/// The kept clips of one track, one after another, each at its speed. With `only`, clips from other
/// sources leave a gap (silence, or no camera) instead.
func insertClips(_ clips: [[Double]], from source: AVAssetTrack, into track: AVMutableCompositionTrack, sourceDuration: CMTime, offset: Double = 0, only: Int? = nil, skipOwn: Bool = false, sources: [Int: (AVAssetTrack, CMTime)] = [:]) {
    var at = CMTime.zero
    for clip in clips where clip.count >= 3 && clip[1] > clip[0] {
        let index = clip.count >= 4 ? Int(clip[3]) : 0
        let wanted = CMTime(seconds: clip[1] - clip[0], preferredTimescale: 600)
        let length = CMTime(seconds: CMTimeGetSeconds(wanted) / clip[2], preferredTimescale: 600)
        let chosen: (AVAssetTrack, CMTime)? = index == 0 ? (source, sourceDuration) : sources[index]
        if (only != nil && index != only) || (skipOwn && index == 0) || chosen == nil {
            // An explicit gap, so later clips land at the right time.
            track.insertEmptyTimeRange(CMTimeRange(start: at, duration: length))
            at = CMTimeAdd(at, length)
            continue
        }
        let (from, fromDuration) = chosen!
        let start = CMTime(seconds: max(0, clip[0] + offset), preferredTimescale: 600)
        var end = CMTime(seconds: max(0, clip[1] + offset), preferredTimescale: 600)
        if CMTimeCompare(end, fromDuration) > 0 { end = fromDuration }
        if CMTimeCompare(end, start) > 0 {
            let range = CMTimeRange(start: start, end: end)
            if (try? track.insertTimeRange(range, of: from, at: at)) != nil, clip[2] != 1 {
                track.scaleTimeRange(CMTimeRange(start: at, duration: range.duration), toDuration: CMTime(seconds: CMTimeGetSeconds(range.duration) / clip[2], preferredTimescale: 600))
            }
        }
        at = CMTimeAdd(at, length)
    }
}


func exportEdit(_ options: Options) async {
    guard let data = FileManager.default.contents(atPath: options.spec) else { fail("Couldn't read the edit.") }
    let spec: EditSpec
    do {
        spec = try JSONDecoder().decode(EditSpec.self, from: data)
    } catch {
        fail("Couldn't read the edit: \(error)")
    }
    guard !spec.clips.isEmpty, spec.content.count == 4 else { fail("There's nothing to export.") }
    let asset = AVURLAsset(url: URL(fileURLWithPath: options.source))
    guard let sourceVideo = try? await asset.loadTracks(withMediaType: .video).first else { fail("The recording has no video.") }
    let sourceAudio = try? await asset.loadTracks(withMediaType: .audio).first
    let sourceDuration = (try? await asset.load(.duration)) ?? .positiveInfinity

    // Other recordings that clips come from.
    var otherVideo: [Int: (AVAssetTrack, CMTime)] = [:]
    var otherAudio: [Int: (AVAssetTrack, CMTime)] = [:]
    for (index, path) in (spec.sourceFiles ?? []).enumerated() {
        let other = AVURLAsset(url: URL(fileURLWithPath: path))
        // Tracks only work while their asset is alive: kept for the whole export.
        keptAssets.append(other)
        let length = (try? await other.load(.duration)) ?? .zero
        if let track = try? await other.loadTracks(withMediaType: .video).first { otherVideo[index + 1] = (track, length) }
        if let track = try? await other.loadTracks(withMediaType: .audio).first { otherAudio[index + 1] = (track, length) }
    }

    let composition = AVMutableComposition()
    // Each recording's clips in its own track (videos of different sizes don't share one); at any
    // moment exactly one of them has a picture.
    guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { fail("Couldn't set up the export.") }
    insertClips(spec.clips, from: sourceVideo, into: videoTrack, sourceDuration: sourceDuration, only: 0)
    var screenTracks: [CMPersistentTrackID] = [videoTrack.trackID]
    for (index, other) in otherVideo.sorted(by: { $0.key < $1.key }) {
        guard let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
        insertClips(spec.clips, from: other.0, into: track, sourceDuration: other.1, only: index, sources: otherVideo)
        screenTracks.append(track.trackID)
    }
    var audioTracks: [(AVMutableCompositionTrack, Double)] = []
    if let sourceAudio, let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
        insertClips(spec.clips, from: sourceAudio, into: audioTrack, sourceDuration: sourceDuration, sources: otherAudio)
        audioTracks.append((audioTrack, spec.audio?.volume ?? 1))
    } else if !otherAudio.isEmpty, let first = otherAudio.values.first, let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
        // No sound of its own, but other clips have some.
        insertClips(spec.clips, from: first.0, into: audioTrack, sourceDuration: first.1, skipOwn: true, sources: otherAudio)
        audioTracks.append((audioTrack, spec.audio?.volume ?? 1))
    }

    // The camera, cut and timed the same way.
    var cameraTrackID: CMPersistentTrackID? = nil
    if spec.webcam != nil, let path = options.cameraSource {
        let cameraAsset = AVURLAsset(url: URL(fileURLWithPath: path))
        keptAssets.append(cameraAsset)
        if let cameraVideo = try? await cameraAsset.loadTracks(withMediaType: .video).first,
           let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) {
            let cameraDuration = (try? await cameraAsset.load(.duration)) ?? sourceDuration
            insertClips(spec.clips, from: cameraVideo, into: track, sourceDuration: cameraDuration, only: 0)
            cameraTrackID = track.trackID
        }
    }

    // System audio, cut and timed like the recording.
    if let path = options.systemSource {
        let systemAsset = AVURLAsset(url: URL(fileURLWithPath: path))
        keptAssets.append(systemAsset)
        if let systemAudio = try? await systemAsset.loadTracks(withMediaType: .audio).first,
           let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            insertClips(spec.clips, from: systemAudio, into: track, sourceDuration: (try? await systemAsset.load(.duration)) ?? sourceDuration, only: 0)
            audioTracks.append((track, spec.audio?.systemVolume ?? 1))
        }
    }

    // A video background, looped to the end.
    var backgroundTrackID: CMPersistentTrackID? = nil
    if spec.background?.kind == "video", let path = options.backgroundVideo {
        let backgroundAsset = AVURLAsset(url: URL(fileURLWithPath: path))
        keptAssets.append(backgroundAsset)
        if let backgroundVideo = try? await backgroundAsset.loadTracks(withMediaType: .video).first,
           let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) {
            let length = (try? await backgroundAsset.load(.duration)) ?? .zero
            var at = CMTime.zero
            while CMTimeCompare(at, composition.duration) < 0, CMTimeGetSeconds(length) > 0.2 {
                let piece = CMTimeMinimum(length, CMTimeSubtract(composition.duration, at))
                try? track.insertTimeRange(CMTimeRange(start: .zero, duration: piece), of: backgroundVideo, at: at)
                at = CMTimeAdd(at, piece)
            }
            backgroundTrackID = track.trackID
        }
    }

    // Added audio, each where it was placed on the timeline.
    for extra in spec.audio?.extras ?? [] {
        let extraAsset = AVURLAsset(url: URL(fileURLWithPath: extra.file))
        keptAssets.append(extraAsset)
        guard let extraAudio = try? await extraAsset.loadTracks(withMediaType: .audio).first,
              let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
        let offset = max(0, extra.offset ?? 0)
        let available = CMTimeGetSeconds((try? await extraAsset.load(.duration)) ?? .zero) - offset
        let length = min(extra.duration, available, max(0, CMTimeGetSeconds(composition.duration) - extra.start))
        guard length > 0.05 else { continue }
        try? track.insertTimeRange(CMTimeRange(start: CMTime(seconds: offset, preferredTimescale: 600), duration: CMTime(seconds: length, preferredTimescale: 600)), of: extraAudio, at: CMTime(seconds: extra.start, preferredTimescale: 600))
        audioTracks.append((track, extra.volume))
    }

    // Volume and muted clips.
    let mix = AVMutableAudioMix()
    mix.inputParameters = audioTracks.enumerated().map { index, entry in
        let (track, volume) = entry
        let parameters = AVMutableAudioMixInputParameters(track: track)
        let level = Float(max(0, min(2, volume)))
        parameters.setVolume(level, at: .zero)
        if index == 0 || (options.systemSource != nil && index == 1 && sourceAudio != nil) {
            for muted in spec.audio?.muted ?? [] where muted.count == 2 && muted[1] > muted[0] {
                parameters.setVolume(0, at: CMTime(seconds: muted[0], preferredTimescale: 600))
                parameters.setVolume(level, at: CMTime(seconds: muted[1], preferredTimescale: 600))
            }
        }
        return parameters
    }

    EditCompositor.renderer = FrameRenderer(spec: spec)
    let videoComposition = AVMutableVideoComposition()
    videoComposition.customVideoCompositorClass = EditCompositor.self
    videoComposition.renderSize = CGSize(width: spec.width, height: spec.height)
    videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, spec.fps)))
    videoComposition.instructions = [EditInstruction(timeRange: CMTimeRange(start: .zero, duration: composition.duration), screens: screenTracks, camera: cameraTrackID, background: backgroundTrackID)]

    let out = URL(fileURLWithPath: options.out)
    let gif = spec.gif != nil
    let movie = gif ? out.deletingLastPathComponent().appendingPathComponent(".\(out.lastPathComponent).movie.mp4") : out
    let partial = movie.deletingLastPathComponent().appendingPathComponent(".\(movie.lastPathComponent).partial.mp4")
    try? FileManager.default.removeItem(at: partial)
    // Quality encoding uses HEVC: smaller files at the same quality, played by every current device.
    let preset = spec.encoding == "quality" && !gif ? AVAssetExportPresetHEVCHighestQuality : AVAssetExportPresetHighestQuality
    guard let session = AVAssetExportSession(asset: composition, presetName: preset) else { fail("Couldn't set up the export.") }
    session.outputURL = partial
    session.outputFileType = .mp4
    session.videoComposition = videoComposition
    if !audioTracks.isEmpty && !gif { session.audioMix = mix }
    session.audioTimePitchAlgorithm = .spectral
    session.shouldOptimizeForNetworkUse = true
    activeExport = session

    Thread.detachNewThread {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespaces) == "cancel" { session.cancelExport() }
        }
    }
    let share = gif ? 0.8 : 1.0
    let progress = DispatchSource.makeTimerSource(queue: .global())
    progress.schedule(deadline: .now(), repeating: .milliseconds(250))
    progress.setEventHandler { emit(["type": "progress", "value": Double(session.progress) * share]) }
    progress.resume()
    session.exportAsynchronously {
        progress.cancel()
        switch session.status {
        case .completed:
            try? FileManager.default.removeItem(at: movie)
            do {
                try FileManager.default.moveItem(at: partial, to: movie)
            } catch {
                fail("Couldn't save the video: \(error.localizedDescription)")
            }
            if gif {
                Task {
                    do {
                        try await writeGif(from: movie, to: out, fps: spec.gif?.fps ?? 15, width: spec.gif?.width ?? 720, loop: spec.gif?.loop ?? true)
                        try? FileManager.default.removeItem(at: movie)
                        emit(["type": "done", "file": out.path, "duration": CMTimeGetSeconds(composition.duration), "width": spec.width, "height": spec.height])
                        exit(0)
                    } catch {
                        try? FileManager.default.removeItem(at: movie)
                        fail("Couldn't make the GIF: \(error.localizedDescription)")
                    }
                }
                return
            }
            emit(["type": "done", "file": out.path, "duration": CMTimeGetSeconds(composition.duration), "width": spec.width, "height": spec.height])
            exit(0)
        case .cancelled:
            try? FileManager.default.removeItem(at: partial)
            emit(["type": "cancelled"])
            exit(0)
        default:
            try? FileManager.default.removeItem(at: partial)
            fail(session.error?.localizedDescription ?? "The export failed.")
        }
    }
}

/// A looping GIF from the exported video, at a lower frame rate and size.
func writeGif(from movie: URL, to out: URL, fps: Int, width: Int, loop: Bool) async throws {
    let asset = AVURLAsset(url: movie)
    let duration = CMTimeGetSeconds(try await asset.load(.duration))
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    generator.maximumSize = CGSize(width: width, height: width * 4)
    let count = max(1, Int(duration * Double(fps)))
    let partial = out.deletingLastPathComponent().appendingPathComponent(".\(out.lastPathComponent).partial")
    guard let destination = CGImageDestinationCreateWithURL(partial as CFURL, "com.compuserve.gif" as CFString, count, nil) else {
        throw NSError(domain: "gif", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't write the GIF."])
    }
    if loop { CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary) }
    let frameProperties = [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 1.0 / Double(fps)]] as CFDictionary
    for index in 0..<count {
        let time = CMTime(seconds: Double(index) / Double(fps), preferredTimescale: 600)
        if let image = try? await generator.image(at: time).image { CGImageDestinationAddImage(destination, image, frameProperties) }
        if index % 5 == 0 { emit(["type": "progress", "value": 0.8 + 0.2 * Double(index) / Double(count)]) }
    }
    guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "gif", code: 2, userInfo: [NSLocalizedDescriptionKey: "Couldn't finish the GIF."]) }
    try? FileManager.default.removeItem(at: out)
    try FileManager.default.moveItem(at: partial, to: out)
}

var activeExport: AVAssetExportSession?
var keptAssets: [AVAsset] = []
