// capture-offer-card — the custom AppKit "accept gate" card that REPLACES the
// `UNUserNotificationCenter` system notification (native/notification-helper
// .swift, now superseded — see README.md's "Native notification helper"
// section and its "Investigated, not a code bug" subsection) as the actual,
// actually-seen accept surface for a detected call.
//
// WHY THIS EXISTS: the earlier migration (terminal-notifier ->
// UNUserNotificationCenter) fixed one real bug (white-on-white banner text)
// but ran straight into a second, OS-version-specific one: macOS 26
// ("Tahoe")'s system-wide "Liquid Glass" material renders ALL notification
// banners with a translucent, washed-out look, and `UNMutableNotification
// Content` exposes no property that touches background material at all (see
// README.md's investigation — title, body, sound, interruptionLevel,
// categoryIdentifier, attachments, badge; none of these is a material knob).
// The only way to stop inheriting system chrome we don't control is to stop
// asking the system to draw the surface at all: this file draws its own
// window, the same way Granola's own "Meeting detected" UI does — a
// custom-drawn always-on-top card, immune to system notification theming by
// construction, not by configuration or a workaround.
//
// PROCESS MODEL — the same category as capture-indicator.swift (a real Cocoa
// event loop, not a bare `RunLoop.main.run()`): `NSApplication.shared` +
// `setActivationPolicy(.accessory)` (no Dock icon, no menu bar) + an
// `NSApplicationDelegate` + `app.run()`. One process per OFFER (mirrors
// notification-helper.swift's one-notification-per-invocation model, not
// capture-indicator.swift's one-process-per-CAPTURE-session model) — an
// offer and a capture are different lifecycles, and `NotificationGate
// .presentCaptureOffer()` already mints one offer per call, so this is a
// natural fit.
//
// DRAGGABLE — same manual mouseDown/mouseDragged technique
// capture-indicator.swift's `BadgeView` uses, and for the same
// empirically-proven reason: `isMovableByWindowBackground` does NOT reliably
// move this style of borderless/nonactivating panel (verified there via
// synthetic `NSApplication.sendEvent` injection — see that file's
// "DRAGGABLE" header comment; not re-derived here, just reapplied).
// `CardContentView.mouseDown`/`mouseDragged` recompute the panel's desired
// screen origin from its CURRENT frame + the event's `locationInWindow` on
// every call, anchoring to the current frame each time rather than
// accumulating a delta against the original mouseDown — the same anti-drift
// reasoning `BadgeView` documents. Button subviews (Start/Skip/the "x")
// still receive their own `mouseDown` normally via AppKit's hit-testing —
// the deepest view under the cursor wins — so dragging the card's background
// and clicking its buttons coexist without conflict, the same way
// capture-indicator.swift's popover (a plain container view plus a real
// `NSButton`) already relies on.
//
// FORCED LIGHT APPEARANCE, FIXED COLORS — this card is a deliberately fixed
// white/light surface, the same "always looks like this" promise Granola's
// own card keeps, and the whole reason this file exists is to stop
// inheriting system chrome we don't control. `panel.appearance =
// NSAppearance(named: .aqua)` forces every stock AppKit control (button
// bezels, etc.) to render in its light style regardless of the system's
// Light/Dark Mode setting, and every custom color below is a fixed RGB
// value, never a semantic/dynamic one (`.labelColor`, `.secondaryLabelColor`,
// `.windowBackgroundColor`, ...). This matters for a concrete reason, not
// just consistency: a dynamic color like `.labelColor` resolves to
// near-white under system Dark Mode — painted onto this card's own fixed
// white background, that would silently reproduce a white-on-white
// rendering, the exact contrast bug this whole line of fixes exists to get
// away from.
//
// NOTIFICATION-HELPER FULLY RETIRED, NOT KEPT AS A BACKUP — a live option
// while designing this was keeping `notification-helper.swift` running
// alongside this card as a secondary/backup signal (a system notification
// can play a sound and register even when no windows are on screen). Decided
// against: both surfaces would independently resolve the SAME
// `CaptureOfferHandle`, which is workable, but Granola's own reference
// design doesn't hedge this way, and every environment capable of showing
// this card (a live Aqua session) is also an environment where a real,
// floating, all-Spaces-visible window is not meaningfully harder to notice
// than a banner — the one gap that's real (a silent card is easy to miss if
// the user genuinely isn't looking at the screen) is covered instead by a
// short `NSSound` on appearance, immediately below, which needs no second
// process, no coordination logic, and no risk of the two surfaces ever
// disagreeing. See README.md for the fuller writeup.
//
// PROTOCOL — one card per offer, no stdin (there is nothing to command it to
// do beyond what its own buttons already drive):
//   argv:
//     capture-offer-card <callId> [source]   source omitted/"" -> unknown
//   stdout (NDJSON, one line per event):
//     {"event":"ready"}                    — window created and shown
//     {"event":"accepted","callId":"..."}  — Start clicked; exits 0
//     {"event":"declined","callId":"..."}  — Skip or "x" clicked; exits 0
//     {"event":"error","message":"..."}    — usage/setup problem; exits 1
//   SIGTERM closes the window and exits 0 — the same "no stdin protocol,
//   SIGTERM is the whole dismiss story" design notification-helper.swift
//   used (see that file's header comment), now closing a real window
//   instead of withdrawing a system notification. `NotificationGate
//   .expire()` already calls `child.kill('SIGTERM')` and awaits the
//   process's own exit — this binary satisfies that exact same
//   `SpawnedChild`-shaped contract, just with a different process behind it.
//
// BARE BINARY, NO APP BUNDLE — unlike notification-helper.swift,
// `UNUserNotificationCenter` is never touched here, so none of that file's
// app-bundle/CFBundleIdentifier/Launch-Services requirements apply. Plain
// AppKit windows work fine from a bare `swiftc`-compiled Mach-O executable —
// capture-indicator.swift already proves this in the same package. This is
// the reason `scripts/build-notification-helper.sh`'s wrapping machinery has
// no equivalent here.
//
// BRAND ICON — resolves `apps/desktop/assets/brand/icon-1024.png` via the
// same `native/bin/<binary>` -> repo-root walk capture-indicator.swift's
// `resolveIconPath()` uses; duplicated rather than shared, matching this
// package's existing convention of self-contained single-file
// `swiftc`-compiled helpers with no shared Swift module.

import AppKit
import Foundation

// MARK: - NDJSON out

func emit(_ fields: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: fields),
    let json = String(data: data, encoding: .utf8)
  else { return }
  print(json)
  // Node reads this as a child-process pipe, not a TTY — see
  // mic-detector.swift's identical comment on why an explicit flush matters.
  fflush(stdout)
}

// MARK: - Small helpers

func capitalizeFirst(_ s: String) -> String {
  guard let first = s.first else { return s }
  return first.uppercased() + s.dropFirst()
}

/// Resolves `apps/desktop/assets/brand/icon-1024.png` relative to this
/// binary's own path — identical logic to capture-indicator.swift's
/// `resolveIconPath()` (see this file's header comment, "BRAND ICON").
/// Returns nil (never throws) when it can't be found; callers fall back to a
/// plain filled circle.
func resolveIconPath() -> String? {
  let exeURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  // exeURL: <repo>/extensions/platform-callcapture/native/bin/capture-offer-card
  let repoRoot =
    exeURL
    .deletingLastPathComponent()  // .../native/bin/     (strips the executable's own filename)
    .deletingLastPathComponent()  // .../native/         (strips "bin")
    .deletingLastPathComponent()  // .../platform-callcapture/  (strips "native")
    .deletingLastPathComponent()  // .../extensions/      (strips "platform-callcapture")
    .deletingLastPathComponent()  // <repo>/              (strips "extensions")
  let iconURL = repoRoot.appendingPathComponent("apps/desktop/assets/brand/icon-1024.png")
  return FileManager.default.fileExists(atPath: iconURL.path) ? iconURL.path : nil
}

func makeLabel(text: String, font: NSFont, color: NSColor) -> NSTextField {
  let label = NSTextField(labelWithString: text)
  label.font = font
  label.textColor = color
  label.drawsBackground = false
  label.isBezeled = false
  label.isEditable = false
  label.isSelectable = false
  label.lineBreakMode = .byTruncatingTail
  return label
}

// MARK: - Layout constants

let cardSize = NSSize(width: 300, height: 176)
let screenMargin: CGFloat = 24
let cardPadding: CGFloat = 16
let cardCornerRadius: CGFloat = 14
let frameAutosaveName = "EthosCallCaptureOfferCardPosition"

/// Ethos brand blue — the same `#2f7dfa` the desktop app's own Electron-based
/// offer card (`apps/desktop/src/main/call-capture-notification-gate.ts`)
/// already uses for its "Start" action, kept identical across both surfaces
/// rather than picking a second, arbitrary blue.
let primaryBlue = NSColor(
  calibratedRed: 0x2f / 255.0, green: 0x7d / 255.0, blue: 0xfa / 255.0, alpha: 1)
/// Fixed (non-dynamic) near-black/grey — see this file's header comment
/// ("FORCED LIGHT APPEARANCE, FIXED COLORS") for why these are literal RGB
/// values rather than `.labelColor`/`.secondaryLabelColor`.
let headlineColor = NSColor(calibratedWhite: 0.09, alpha: 1)
let subtitleColor = NSColor(calibratedWhite: 0.45, alpha: 1)

// MARK: - Draggable card surface

/// Owns the card's whole visual surface: a solid white rounded-rect
/// background (the panel itself is transparent so only this shape is
/// visible — its shadow comes from the owning `NSPanel`'s `hasShadow`,
/// mirroring capture-indicator.swift's badge/popover panels) and manual
/// window dragging. See this file's header comment ("DRAGGABLE") for why
/// `isMovableByWindowBackground` isn't used. Flipped so every layout
/// calculation below reads top-down like the visual mockup, rather than
/// AppKit's default bottom-left origin.
final class CardContentView: NSView {
  override var isFlipped: Bool { true }

  private var dragOffsetInWindow: NSPoint?

  override func draw(_ dirtyRect: NSRect) {
    NSColor.white.setFill()
    NSBezierPath(roundedRect: bounds, xRadius: cardCornerRadius, yRadius: cardCornerRadius).fill()
  }

  // Manual window-background dragging — see this file's header comment
  // ("DRAGGABLE") for why `isMovableByWindowBackground` isn't used, and why
  // anchoring to the CURRENT frame on every `mouseDragged` call (rather than
  // a delta accumulated from the original `mouseDown`) is what keeps a
  // multi-step drag from drifting.
  override func mouseDown(with event: NSEvent) {
    dragOffsetInWindow = event.locationInWindow
  }

  override func mouseDragged(with event: NSEvent) {
    guard let window = window, let offset = dragOffsetInWindow else { return }
    let currentScreenLocation = NSPoint(
      x: window.frame.origin.x + event.locationInWindow.x,
      y: window.frame.origin.y + event.locationInWindow.y)
    window.setFrameOrigin(
      NSPoint(x: currentScreenLocation.x - offset.x, y: currentScreenLocation.y - offset.y))
  }

  override func mouseUp(with event: NSEvent) {
    dragOffsetInWindow = nil
  }
}

// MARK: - App delegate: owns the card window and its outcome

final class AppDelegate: NSObject, NSApplicationDelegate {
  /// Set before `app.run()` — see this file's entry point at the bottom.
  var callId: String = ""
  var source: String = ""

  private var panel: NSPanel!

  func applicationDidFinishLaunching(_ notification: Notification) {
    panel = makeCardPanel()
    // `orderFrontRegardless()`, not `makeKeyAndOrderFront(_:)` — mirrors
    // capture-indicator.swift's "NON-ACTIVATING" rule: this card must never
    // steal focus from whatever calling app (Zoom, etc.) is frontmost. A
    // nonactivating panel can still become key on a real click, so button
    // hit-testing and the drag handling above both work normally.
    panel.orderFrontRegardless()
    playAppearanceSound()
    emit(["event": "ready"])
  }

  private func defaultOrigin() -> NSPoint {
    guard let screen = NSScreen.main else { return NSPoint(x: 100, y: 100) }
    let visible = screen.visibleFrame
    return NSPoint(
      x: visible.maxX - cardSize.width - screenMargin,
      y: visible.minY + screenMargin)
  }

  private func makeCardPanel() -> NSPanel {
    let panel = NSPanel(
      contentRect: NSRect(origin: defaultOrigin(), size: cardSize),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.level = .floating
    panel.hidesOnDeactivate = false
    // Same pairing capture-indicator.swift's panels use to stay visible over
    // a calling app running fullscreen in its own macOS Space.
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    // See this file's header comment ("FORCED LIGHT APPEARANCE, FIXED
    // COLORS") — this card never re-themes with system Dark Mode.
    panel.appearance = NSAppearance(named: .aqua)

    let content = CardContentView(frame: NSRect(origin: .zero, size: cardSize))
    content.wantsLayer = true
    buildContent(in: content)
    panel.contentView = content

    // Restore the last-dropped position if one was saved; otherwise this
    // stays at the bottom-right default computed above — same "position
    // persistence" mechanism capture-indicator.swift's badge uses
    // (AppKit's own frame-autosave, not a hand-rolled listener).
    _ = panel.setFrameUsingName(frameAutosaveName)
    panel.setFrameAutosaveName(frameAutosaveName)
    return panel
  }

  private func buildContent(in content: NSView) {
    let brandIcon = resolveIconPath().flatMap { NSImage(contentsOfFile: $0) }

    // Top-right "x" dismiss — a third, equally-explicit way to decline
    // alongside Skip (see this file's header comment's PROTOCOL section).
    let closeButton = NSButton(
      frame: NSRect(x: cardSize.width - cardPadding - 18, y: 10, width: 18, height: 18))
    closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Dismiss")
    closeButton.isBordered = false
    closeButton.imageScaling = .scaleProportionallyDown
    closeButton.contentTintColor = subtitleColor
    closeButton.target = self
    closeButton.action = #selector(declineClicked)
    content.addSubview(closeButton)

    // Brand icon + headline/subtitle.
    let iconView = NSImageView(frame: NSRect(x: cardPadding, y: cardPadding, width: 28, height: 28))
    if let brandIcon = brandIcon {
      iconView.image = brandIcon
      iconView.imageScaling = .scaleProportionallyUpOrDown
    } else {
      iconView.wantsLayer = true
      iconView.layer?.backgroundColor = primaryBlue.cgColor
      iconView.layer?.cornerRadius = 14
    }
    content.addSubview(iconView)

    let textX = cardPadding + 28 + 10
    let textWidth = cardSize.width - textX - 34

    let headline = makeLabel(
      text: "Meeting detected", font: .boldSystemFont(ofSize: 14), color: headlineColor)
    headline.frame = NSRect(x: textX, y: cardPadding, width: textWidth, height: 18)
    content.addSubview(headline)

    // Empty when the daemon couldn't resolve a source app — mirrors
    // capture-indicator.swift's `initialSource` being optional. Granola's
    // own card shows the bare app name ("Zoom") with no extra wording, so
    // this does the same rather than a full sentence.
    if !source.isEmpty {
      let subtitle = makeLabel(
        text: capitalizeFirst(source), font: .systemFont(ofSize: 12), color: subtitleColor)
      subtitle.frame = NSRect(x: textX, y: cardPadding + 20, width: textWidth, height: 16)
      content.addSubview(subtitle)
    }

    // "Capture" action row — the Ethos-branded equivalent of Granola's own
    // "Take notes" element (see this file's header comment for the mapping).
    let captureIconView = NSImageView(frame: NSRect(x: cardPadding, y: 68, width: 16, height: 16))
    if let brandIcon = brandIcon {
      captureIconView.image = brandIcon
      captureIconView.imageScaling = .scaleProportionallyUpOrDown
    }
    content.addSubview(captureIconView)

    let captureLabel = makeLabel(
      text: "Capture", font: .systemFont(ofSize: 12, weight: .medium), color: headlineColor)
    captureLabel.frame = NSRect(x: cardPadding + 16 + 8, y: 68, width: 200, height: 16)
    content.addSubview(captureLabel)

    // Skip (secondary) / Start (primary) — bottom-right, matching Granola's
    // own button placement.
    let buttonY = cardSize.height - cardPadding - 30
    let startWidth: CGFloat = 90
    let skipWidth: CGFloat = 80
    let gap: CGFloat = 10
    let startX = cardSize.width - cardPadding - startWidth
    let skipX = startX - gap - skipWidth

    let skipButton = NSButton(frame: NSRect(x: skipX, y: buttonY, width: skipWidth, height: 30))
    skipButton.bezelStyle = .rounded
    skipButton.title = "Skip"
    skipButton.target = self
    skipButton.action = #selector(declineClicked)
    content.addSubview(skipButton)

    let startButton = NSButton(frame: NSRect(x: startX, y: buttonY, width: startWidth, height: 30))
    // NOT `bezelStyle = .rounded` + `bezelColor = primaryBlue` (the original
    // approach here) — confirmed live and by repro that `NSButton.bezelColor`
    // only visibly tints a `.rounded`-bezel button while its owning window
    // is KEY. This panel is deliberately never key (`.nonactivatingPanel` +
    // `orderFrontRegardless()`, so it never steals focus from whatever call
    // app is frontmost — see this file's header comment, "PROCESS MODEL"),
    // so bezelColor silently no-ops and the button fell back to a
    // near-transparent system overlay that reads as flat, washed-out grey —
    // visually near-identical to Skip. Same class of bug as the Dark-Mode
    // notification-text bug this whole card exists to escape (see header
    // comment, "FORCED LIGHT APPEARANCE, FIXED COLORS"): don't trust dynamic/
    // state-dependent system control styling, draw fixed pixels yourself.
    // Fixed the same way the icon-fallback badge above already is — a
    // layer-backed fixed `CGColor` fill, immune to key-window state because
    // CALayer compositing doesn't consult it.
    startButton.isBordered = false
    startButton.wantsLayer = true
    startButton.layer?.backgroundColor = primaryBlue.cgColor
    startButton.layer?.cornerRadius = 7
    // Explicit white attributed title rather than relying on the bezel's
    // own auto-contrast behavior — matches capture-indicator.swift's
    // transcript view, which sets `.foregroundColor` explicitly for the
    // same "don't guess, be certain" reason.
    startButton.attributedTitle = NSAttributedString(
      string: "Start",
      attributes: [
        .foregroundColor: NSColor.white,
        .font: NSFont.boldSystemFont(ofSize: 13),
      ])
    startButton.target = self
    startButton.action = #selector(startClicked)
    content.addSubview(startButton)
  }

  @objc private func startClicked() {
    emit(["event": "accepted", "callId": callId])
    exit(0)
  }

  @objc private func declineClicked() {
    emit(["event": "declined", "callId": callId])
    exit(0)
  }

  /// Covers the one real gap left by fully retiring the system notification
  /// (see this file's header comment) — a short, standard macOS alert sound,
  /// not a custom bundled asset.
  private func playAppearanceSound() {
    NSSound(named: NSSound.Name("Glass"))?.play()
  }
}

// MARK: - Entry point

guard CommandLine.arguments.count >= 2 else {
  emit(["event": "error", "message": "usage: capture-offer-card <callId> [source]"])
  exit(1)
}

let app = NSApplication.shared
// Background helper, not a user-facing app — no Dock icon, no menu bar. This
// is what keeps `orderFrontRegardless()` from ever activating Ethos or
// stealing focus from whatever call app is frontmost.
app.setActivationPolicy(.accessory)

let delegate = AppDelegate()
delegate.callId = CommandLine.arguments[1]
delegate.source = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
app.delegate = delegate

// SIGTERM: ignore the default (immediate-kill) disposition and close the
// window cleanly instead, via a dispatch source on the main queue — the same
// technique notification-helper.swift uses (see this file's header comment,
// "PROTOCOL").
signal(SIGTERM, SIG_IGN)
let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigTermSource.setEventHandler {
  exit(0)
}
sigTermSource.resume()

app.run()
