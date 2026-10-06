import AppKit
import SwiftUI

/// A small, transient confirmation near the top of the screen (the app has no window of its own).
@MainActor
enum Toast {
    private static var panel: NSPanel?

    static func show(_ text: String, symbol: String = "checkmark.circle.fill") {
        panel?.orderOut(nil)
        let view = HStack(spacing: 8) {
            Image(systemName: symbol).foregroundStyle(Color(red: 0.98, green: 0.45, blue: 0.16))
            Text(text).font(.system(size: 13, weight: .medium))
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        let host = NSHostingView(rootView: view)
        host.setFrameSize(host.fittingSize)
        let p = NSPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isOpaque = false; p.backgroundColor = .clear; p.level = .statusBar; p.hasShadow = true
        p.contentView = host
        if let s = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main {
            p.setFrameOrigin(NSPoint(x: s.frame.midX - host.fittingSize.width / 2, y: s.frame.maxY - 90))
        }
        p.orderFrontRegardless()
        panel = p
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { [weak p] in p?.orderOut(nil) }
    }
}
