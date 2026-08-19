// capture-indicator — the floating on-screen recording badge (plan/phases/
// call-capture-desktop-ux.md). Gives visual confirmation that a capture is
// actually in progress once the OS-notification accept gate has fired —
// today there is otherwise zero on-screen feedback between "clicked accept"
// and "the transcript artifact appeared later." This is the CLI-daemon
// (`ethos serve`/`ethos gateway`) analog of the desktop app's Electron-based
// `apps/desktop/src/main/call-capture-pill.ts` — that surface already has a
// `BrowserWindow` available; a bare Node CLI process does not, so this is a
// real native AppKit window instead.
//
// PROCESS MODEL — this is a different category from this package's other
// native helpers (`mic-detector.swift`/`mic-capture.swift`), which are
// headless CLI tools driven by a bare `RunLoop.main.run()`. Those never
// create a window, so the plain Core Foundation run loop is enough to keep
// the process alive while CoreAudio/AVFoundation callbacks fire. A VISIBLE,
// DRAGGABLE, HOVER-TRACKING `NSWindow` needs the real Cocoa event loop —
// mouse tracking (`NSTrackingArea`), manual window dragging (see this
// file's "DRAGGABLE" comment below), and button hit-testing are all
// delivered through `NSApplication.sendEvent(_:)`, which only runs once
// `NSApp.run()` is pumping. Concretely this means: `NSApplication.shared`, an
// `NSApplicationDelegate`, `setActivationPolicy(.accessory)` (no Dock icon,
// no menu bar — this process is a background helper, not an app the user
// switches to), and `app.run()` in place of `RunLoop.main.run()`. Nothing
// else about the process changes: NDJSON in/out, killed by SIGTERM,
// launched/torn down by the Node parent exactly like the other helpers.
//
// STDIN/STDOUT PROTOCOL — this is the first helper in the package that reads
// commands INBOUND (the others only ever write outbound). Same NDJSON
// convention, just reversed direction, one JSON object per line:
//
//   Node -> Swift (stdin):
//     {"command":"transcript_append","speaker":"you"|"other","text":"..."}
//     {"command":"audio_level","speaker":"you"|"other","level":<number 0.0-1.0>}
//     {"command":"hide"}
//   Swift -> Node (stdout):
//     {"event":"ready"}                  — window created and shown
//     {"event":"end_requested"}          — the popover's "End" button was clicked
//     {"event":"error","message":"..."}  — non-fatal problem worth logging
//
// `hide` closes the window and exits the process — the daemon spawns a
// fresh process per capture (`show()` spawns, `hide()`/EOF/SIGTERM tears
// down), the same "one process per session" lifecycle
// `mic-capture.swift`/`tap-capture.ts` already use, rather than one
// long-lived indicator process reused across calls.
//
// stdin is read on a dedicated background thread via the blocking
// `readLine()` (simpler than a `DispatchSourceRead` + manual line-buffering,
// and there's no PCM byte-alignment concern here — every line is a short
// JSON command). Each parsed line is hopped onto the main queue before
// touching any AppKit object, since UI must only ever be touched from the
// main thread; GCD's main queue is serviced correctly by the Cocoa run loop
// once `NSApp.run()` is active, so this needs no extra plumbing.
//
// END BUTTON — clicking it emits `end_requested` and keeps the process (and
// window) running; it does NOT self-terminate. The daemon decides when
// capture has actually finished tearing down and sends `hide` once it has —
// see daemon.ts's header comment ("CANCELLATION") for why an end-requested
// click reuses the exact same cancellation path `call_ended` already uses,
// rather than a second one.
//
// DRAGGABLE — `isMovableByWindowBackground` was tried first and does NOT
// reliably move this panel: verified by posting synthetic mouseDown/
// mouseDragged/mouseUp events through the real `NSApplication.sendEvent`
// dispatch path (not just constructing them) — the events are dequeued and
// delivered (proving delivery isn't the problem), but the panel's frame
// never changes, on a `.borderless` panel with or without
// `.nonactivatingPanel` in its style mask. So `BadgeView` tracks the drag
// itself instead: `mouseDown(with:)` records the click's window-local
// offset, `mouseDragged(with:)` recomputes the panel's desired screen
// origin from its CURRENT frame + the event's `locationInWindow` on every
// call (not a delta accumulated against the original mouseDown) — anchoring
// to the current frame each time is what keeps a multi-step drag from
// drifting, since `locationInWindow` is itself reported relative to
// wherever the panel currently is. `NSTrackingArea` (used for hover) never
// consumes `mouseDown`, so hover-tracking and dragging still coexist
// without conflict.
//
// POSITION PERSISTENCE — uses AppKit's own built-in frame-autosave
// mechanism (`NSWindow.setFrameUsingName(_:)` /
// `setFrameAutosaveName(_:)`), not a hand-rolled `windowDidMove` listener
// debounced into `UserDefaults`. AppKit already does exactly this — save on
// every frame change, restore by name at next launch — so reimplementing it
// would just be a worse copy of a solved problem.
//
// FULLSCREEN-SPACE VISIBILITY — `collectionBehavior` includes
// `.canJoinAllSpaces` + `.fullScreenAuxiliary` alongside `level = .floating`,
// the same pairing `call-capture-pill.ts`/`call-capture-notification-gate.ts`
// already use (via Electron's `setVisibleOnAllWorkspaces(true, {
// visibleOnFullScreen: true })`) to solve the identical problem: the calling
// app (Zoom, etc.) is often running fullscreen in its own Space, and the
// indicator must still be visible there.
//
// NON-ACTIVATING — both windows are `NSPanel`s with `.nonactivatingPanel` in
// their style mask, and are shown via `orderFrontRegardless()`, never
// `makeKeyAndOrderFront(_:)`. This mirrors Electron's `showInactive()` in the
// desktop pill: the indicator must never steal focus from whatever call app
// is frontmost. A nonactivating panel can still become key on a real click
// (so the "End" button's hit-testing/tracking works normally) without
// activating the owning app itself.
//
// BADGE ICON — the badge draws the real Ethos mark
// (`apps/desktop/assets/brand/icon-1024.png`, the same PNG the desktop app's
// own `.icns` is built from), clipped to a circle, rather than a plain
// colored dot. Resolved from this binary's own path
// (`CommandLine.arguments[0]`) by walking up to the repo root — this binary
// only ever runs from the monorepo checkout (dev-compiled via `swiftc`, the
// same posture every other native helper in this package already has; none
// of them special-case a bundled/published layout either). Missing/unreadable
// falls back to the plain circle rather than failing — this is decoration,
// never load-bearing.
//
// `BadgeView.wantsLayer = true` — the badge is a custom-drawn, non-opaque,
// shadowed, borderless panel; layer-backing its content view is Apple's
// standing recommendation for this exact combination, and is the fix for
// the class of bug where a live-tested badge showed as blank/white. This
// couldn't be reproduced pixel-for-pixel in a scripted/headless verification
// pass (every render technique available without Screen Recording
// permission — off-screen bitmaps, a live-window-attached render, and a
// render through the real `app.run()` entry point — painted the icon
// correctly with or without this line), so treat this as defensive
// hardening for the reported symptom, not a confirmed repro-then-fix.
//
// SOURCE ARG + "WAITING" PLACEHOLDER — `argv[1]`, when present, is the
// clean source label the daemon already resolved for this call (e.g.
// "zoom" — see `process-prefilter.ts`'s `sourceLabelForProcessName`,
// threaded through `daemon.ts`'s `handleAccepted` into
// `CallCaptureIndicatorPort.show(source)`). STT runs on fixed ~8s windows
// (see this package's README), so there is a real multi-second gap between
// "capture started" and "the first transcript entry exists." Rather than
// show an empty popover during that gap, the transcript view starts with a
// "Call started on <Source> — waiting for transcript…" placeholder, cleared
// (not appended alongside) the moment the first real `transcript_append`
// arrives.
//
// LEVEL METER — `audio_level` arrives far more often than `transcript_append`
// (~100-200ms vs the ~8s STT window), so the popover also shows a small,
// always-live level meter above the transcript text — visual proof capture
// is working from the very first reading, well before either the placeholder
// clears or any transcript text exists. Two thin bars, one per speaker
// ("You"/"Other"), rather than a single combined bar: this feature already
// distinguishes the two everywhere else (separate labeled transcript lines),
// and a per-speaker meter is a direct visual extension of that, not a new
// idea. Incoming raw readings are smoothed with a simple exponential moving
// average (`levelSmoothingAlpha`) before being drawn — at this cadence,
// drawing the raw value straight through reads as flicker, not a meter.
// Colors are the same fixed white-at-alpha values this file already inlines
// elsewhere (badge stroke, transcript text) — no new color introduced; see
// capture-offer-card.swift's header comment ("FORCED LIGHT APPEARANCE, FIXED
// COLORS") for why this package never uses dynamic/semantic `NSColor`s.

import AppKit
import Foundation

// MARK: - NDJSON out

func emit(_ fields: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: fields),
    let json = String(data: data, encoding: .utf8)
  else { return }
  print(json)
  // Node reads this as a child-process pipe, not a TTY — fully buffered
  // rather than line-buffered, so without an explicit flush an event can sit
  // in the buffer instead of reaching the reader promptly. Same reasoning as
  // mic-detector.swift's `emit`.
  fflush(stdout)
}

// MARK: - Layout constants

let badgeSize = NSSize(width: 48, height: 48)
/// Height of the two-row per-speaker level meter strip, plus the gap between
/// it and the transcript scroll view below it — see this file's header
/// comment ("LEVEL METER"). `popoverSize.height` grows by exactly this much
/// versus the pre-meter layout, so the transcript area keeps its original
/// size rather than being crushed to make room.
let meterStripHeight: CGFloat = 36
let meterGap: CGFloat = 6
// Width grew from 300 to 450 to widen the audio-level meter's visible
// pixel swing to roughly 1.6x (see `AudioLevelMeterView`'s "LEVEL METER"
// comment below), per user feedback that the movement read as too subtle.
// The meter's fill width is `trackRect.width * perceptualLevel` — a direct
// multiple of the space available to the track — so widening the swing
// without touching the already-tuned sqrt(level)*1.1 perceptual curve
// means widening the track itself, and the track already spans the full
// width available inside the popover (`popoverSize.width - padding * 2 -
// labelWidth`, no unused horizontal space to reclaim from elsewhere in
// this layout). The transcript area, button, and meter widths all derive
// from `popoverSize.width` already, so they grow in step automatically;
// none of them sit beside the meter, so growing the popover's width alone
// (not its height) can't overlap or clip anything below it.
let popoverSize = NSSize(width: 450, height: 220 + meterStripHeight + meterGap)
let popoverGap: CGFloat = 8
let screenMargin: CGFloat = 24
let frameAutosaveName = "EthosCallCaptureIndicatorPosition"
/** How long to wait, after the cursor leaves both the badge and the
 * popover, before actually closing the popover — long enough to cross the
 * small gap between them without flickering shut, mirroring
 * `call-capture-pill.ts`'s identical `HOVER_CLOSE_DEBOUNCE_MS`. */
let hoverCloseDebounceSeconds: TimeInterval = 0.15

// MARK: - Hover-tracking view

/// Base view for both the badge and the popover content: reports
/// mouseEntered/mouseExited via a closure rather than requiring a delegate,
/// since both windows need the same behavior with different handlers.
class HoverTrackingView: NSView {
  var onHoverChange: ((Bool) -> Void)?
  private var trackingArea: NSTrackingArea?

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let existing = trackingArea { removeTrackingArea(existing) }
    let area = NSTrackingArea(
      rect: bounds,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self, userInfo: nil)
    addTrackingArea(area)
    trackingArea = area
  }

  override func mouseEntered(with event: NSEvent) { onHoverChange?(true) }
  override func mouseExited(with event: NSEvent) { onHoverChange?(false) }
}

/// The small circular badge. Draws the real Ethos icon clipped to a circle
/// when resolvable (see this file's header comment, "BADGE ICON"); falls
/// back to a plain colored dot otherwise. Exact size/animation is still
/// expected to be iterated on once the user sees it live.
final class BadgeView: HoverTrackingView {
  var icon: NSImage?
  /** The click's offset from the panel's origin, in window-local
   * coordinates, captured at `mouseDown` — see this file's header comment
   * ("DRAGGABLE"). */
  private var dragOffsetInWindow: NSPoint?

  override func draw(_ dirtyRect: NSRect) {
    NSColor.clear.set()
    dirtyRect.fill()
    let circleRect = bounds.insetBy(dx: 2, dy: 2)
    let path = NSBezierPath(ovalIn: circleRect)
    if let icon = icon {
      NSGraphicsContext.saveGraphicsState()
      path.addClip()
      // `draw(in:)` scales to exactly fill `circleRect`; the source PNG is
      // square (1024x1024) and the destination is square too, so this never
      // distorts the aspect ratio.
      icon.draw(in: circleRect, from: .zero, operation: .sourceOver, fraction: 1.0)
      NSGraphicsContext.restoreGraphicsState()
    } else {
      NSColor.systemRed.withAlphaComponent(0.92).setFill()
      path.fill()
    }
    path.lineWidth = 1.5
    NSColor.white.withAlphaComponent(0.85).setStroke()
    path.stroke()
  }

  // Manual window-background dragging — see this file's header comment
  // ("DRAGGABLE") for why `isMovableByWindowBackground` isn't used.
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

/// Resolves `apps/desktop/assets/brand/icon-1024.png` relative to this
/// binary's own path — see this file's header comment ("BADGE ICON").
/// Returns nil (never throws) when it can't be found; the badge falls back
/// to a plain circle.
func resolveIconPath() -> String? {
  let exeURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  // exeURL: <repo>/extensions/platform-callcapture/native/bin/capture-indicator
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

func capitalizeFirst(_ s: String) -> String {
  guard let first = s.first else { return s }
  return first.uppercased() + s.dropFirst()
}

/// Two thin per-speaker level bars ("You" on top, "Other" below) — see this
/// file's header comment ("LEVEL METER"). Purely a renderer: callers set
/// `youLevel`/`otherLevel` (already smoothed, already clamped to 0.0-1.0)
/// and this redraws itself. Colors are the same fixed white-at-alpha values
/// this file already uses elsewhere — never a dynamic/semantic `NSColor`.
final class AudioLevelMeterView: NSView {
  var youLevel: Double = 0 { didSet { needsDisplay = true } }
  var otherLevel: Double = 0 { didSet { needsDisplay = true } }

  private let trackColor = NSColor.white.withAlphaComponent(0.18)
  private let fillColor = NSColor.white.withAlphaComponent(0.85)
  private let labelColor = NSColor.white.withAlphaComponent(0.7)
  private let labelWidth: CGFloat = 34
  private let barHeight: CGFloat = 6

  override func draw(_ dirtyRect: NSRect) {
    let rowHeight = bounds.height / 2
    drawRow(
      label: "You", level: youLevel,
      in: NSRect(x: 0, y: rowHeight, width: bounds.width, height: rowHeight))
    drawRow(
      label: "Other", level: otherLevel,
      in: NSRect(x: 0, y: 0, width: bounds.width, height: rowHeight))
  }

  private func drawRow(label: String, level: Double, in rect: NSRect) {
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 9), .foregroundColor: labelColor,
    ]
    let labelText = label as NSString
    let labelSize = labelText.size(withAttributes: attrs)
    labelText.draw(
      at: NSPoint(x: rect.minX, y: rect.midY - labelSize.height / 2), withAttributes: attrs)

    let trackRect = NSRect(
      x: rect.minX + labelWidth, y: rect.midY - barHeight / 2,
      width: rect.width - labelWidth, height: barHeight)
    let trackPath = NSBezierPath(
      roundedRect: trackRect, xRadius: barHeight / 2, yRadius: barHeight / 2)
    trackColor.setFill()
    trackPath.fill()

    let clampedLevel = max(0, min(1, level))
    guard clampedLevel > 0.02, trackRect.width > 0 else { return }
    let fillRect = NSRect(
      x: trackRect.minX, y: trackRect.minY,
      width: trackRect.width * CGFloat(clampedLevel), height: trackRect.height)
    let fillPath = NSBezierPath(roundedRect: fillRect, xRadius: barHeight / 2, yRadius: barHeight / 2)
    fillColor.setFill()
    fillPath.fill()
  }
}

// MARK: - App delegate: owns both windows and the transcript buffer

final class AppDelegate: NSObject, NSApplicationDelegate {
  /// The clean source label from `argv[1]` (e.g. "zoom"), set before
  /// `app.run()` — see this file's header comment ("SOURCE ARG +
  /// 'WAITING' PLACEHOLDER").
  var initialSource: String?

  private var badgeWindow: NSPanel!
  private var popoverWindow: NSPanel!
  private var transcriptTextView: NSTextView!
  private var audioLevelMeterView: AudioLevelMeterView!
  private var badgeHovered = false
  private var popoverHovered = false
  private var closeWorkItem: DispatchWorkItem?
  /** Whether a real `transcript_append` has landed yet — until it has, the
   * popover shows the "waiting for transcript" placeholder instead. */
  private var hasReceivedTranscript = false
  /** Exponential-moving-average smoothed level per speaker — see this file's
   * header comment ("LEVEL METER"). Raw readings arrive too fast (~100-200ms)
   * to draw unsmoothed without visible flicker. */
  private var youLevelSmoothed: Double = 0
  private var otherLevelSmoothed: Double = 0
  private let levelSmoothingAlpha: Double = 0.3

  func applicationDidFinishLaunching(_ notification: Notification) {
    badgeWindow = makeBadgeWindow()
    popoverWindow = makePopoverWindow()
    showWaitingPlaceholder()
    // `orderFrontRegardless()`, not `makeKeyAndOrderFront(_:)` — see this
    // file's header comment ("NON-ACTIVATING").
    badgeWindow.orderFrontRegardless()
    emit(["event": "ready"])
  }

  // MARK: Window construction

  private func defaultBadgeOrigin() -> NSPoint {
    guard let screen = NSScreen.main else { return NSPoint(x: 100, y: 100) }
    let visible = screen.visibleFrame
    return NSPoint(
      x: visible.maxX - badgeSize.width - screenMargin,
      y: visible.minY + screenMargin)
  }

  private func makeOverlayPanel(size: NSSize, origin: NSPoint) -> NSPanel {
    let panel = NSPanel(
      contentRect: NSRect(origin: origin, size: size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.level = .floating
    panel.hidesOnDeactivate = false
    // See this file's header comment ("FULLSCREEN-SPACE VISIBILITY").
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    return panel
  }

  private func makeBadgeWindow() -> NSPanel {
    let panel = makeOverlayPanel(size: badgeSize, origin: defaultBadgeOrigin())

    let view = BadgeView(frame: NSRect(origin: .zero, size: badgeSize))
    // Layer-backs the badge's custom drawing — see this file's header
    // comment ("BADGE ICON") for why this matters for a borderless,
    // non-opaque, shadowed panel.
    view.wantsLayer = true
    if let iconPath = resolveIconPath() {
      view.icon = NSImage(contentsOfFile: iconPath)
    }
    view.onHoverChange = { [weak self] hovering in
      self?.badgeHovered = hovering
      if hovering {
        self?.showPopover()
      } else {
        self?.scheduleHideCheck()
      }
    }
    panel.contentView = view

    // Restore the last-dropped position if one was saved; otherwise this
    // stays at the bottom-right default computed above. See this file's
    // header comment ("POSITION PERSISTENCE").
    _ = panel.setFrameUsingName(frameAutosaveName)
    panel.setFrameAutosaveName(frameAutosaveName)
    return panel
  }

  private func makePopoverWindow() -> NSPanel {
    // Positioned relative to the (possibly-restored) badge origin, not the
    // unconditional default — the popover always anchors to wherever the
    // badge actually ended up.
    let badgeOrigin = badgeWindow?.frame.origin ?? defaultBadgeOrigin()
    let origin = NSPoint(
      x: badgeOrigin.x + badgeSize.width - popoverSize.width,
      y: badgeOrigin.y + badgeSize.height + popoverGap)
    let panel = makeOverlayPanel(size: popoverSize, origin: origin)
    panel.backgroundColor = NSColor.black.withAlphaComponent(0.85)

    let container = HoverTrackingView(frame: NSRect(origin: .zero, size: popoverSize))
    container.onHoverChange = { [weak self] hovering in
      self?.popoverHovered = hovering
      if hovering {
        self?.cancelHideCheck()
      } else {
        self?.scheduleHideCheck()
      }
    }

    let buttonHeight: CGFloat = 28
    let padding: CGFloat = 8
    // Height is reduced by exactly the meter strip's footprint
    // (meterStripHeight + meterGap) versus the pre-meter layout —
    // popoverSize.height grew by that same amount above, so the transcript
    // area itself keeps its original size. See this file's header comment
    // ("LEVEL METER").
    let scrollFrame = NSRect(
      x: padding, y: padding * 2 + buttonHeight,
      width: popoverSize.width - padding * 2,
      height: popoverSize.height - padding * 3 - buttonHeight - meterStripHeight - meterGap)
    let scrollView = NSScrollView(frame: scrollFrame)
    scrollView.hasVerticalScroller = true
    scrollView.drawsBackground = false
    scrollView.autoresizingMask = [.width, .height]

    let textView = NSTextView(frame: NSRect(origin: .zero, size: scrollFrame.size))
    textView.isEditable = false
    textView.isSelectable = true
    textView.drawsBackground = false
    textView.textColor = .white
    textView.font = NSFont.systemFont(ofSize: 12)
    textView.autoresizingMask = [.width]
    textView.textContainer?.widthTracksTextView = true
    scrollView.documentView = textView
    transcriptTextView = textView

    let endButton = NSButton(
      frame: NSRect(x: padding, y: padding, width: popoverSize.width - padding * 2, height: buttonHeight))
    endButton.title = "End"
    endButton.bezelStyle = .rounded
    endButton.target = self
    endButton.action = #selector(endButtonClicked)

    // Sits directly above the transcript area, at the top of the popover —
    // see this file's header comment ("LEVEL METER") for why it's visible
    // and updating before any real transcript text exists.
    let meterFrame = NSRect(
      x: padding, y: scrollFrame.maxY + meterGap,
      width: popoverSize.width - padding * 2, height: meterStripHeight)
    let meterView = AudioLevelMeterView(frame: meterFrame)
    audioLevelMeterView = meterView

    container.addSubview(scrollView)
    container.addSubview(endButton)
    container.addSubview(meterView)
    panel.contentView = container
    return panel
  }

  // MARK: Hover show/hide (combined region, debounced close)

  private func showPopover() {
    cancelHideCheck()
    positionPopoverAboveBadge()
    popoverWindow.orderFrontRegardless()
  }

  private func positionPopoverAboveBadge() {
    let badgeFrame = badgeWindow.frame
    let origin = NSPoint(
      x: badgeFrame.maxX - popoverSize.width,
      y: badgeFrame.maxY + popoverGap)
    popoverWindow.setFrameOrigin(origin)
  }

  private func scheduleHideCheck() {
    cancelHideCheck()
    let item = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      if !self.badgeHovered && !self.popoverHovered {
        self.popoverWindow.orderOut(nil)
      }
    }
    closeWorkItem = item
    DispatchQueue.main.asyncAfter(deadline: .now() + hoverCloseDebounceSeconds, execute: item)
  }

  private func cancelHideCheck() {
    closeWorkItem?.cancel()
    closeWorkItem = nil
  }

  // MARK: Waiting-for-transcript placeholder

  private func waitingMessage() -> String {
    let label = initialSource.map { "Call started on \(capitalizeFirst($0))" } ?? "Call started"
    return "\(label) — waiting for transcript…"
  }

  private func showWaitingPlaceholder() {
    guard let textView = transcriptTextView, let storage = textView.textStorage else { return }
    let italicFont = NSFontManager.shared.convert(
      NSFont.systemFont(ofSize: 12), toHaveTrait: .italicFontMask)
    let attrs: [NSAttributedString.Key: Any] = [
      .font: italicFont, .foregroundColor: NSColor.white.withAlphaComponent(0.7),
    ]
    storage.append(NSAttributedString(string: waitingMessage(), attributes: attrs))
  }

  // MARK: Commands from stdin

  func appendTranscript(speaker: String, text: String) {
    guard let textView = transcriptTextView, let storage = textView.textStorage else { return }
    // The first real entry replaces the "waiting for transcript" placeholder
    // rather than appending after it — see this file's header comment
    // ("SOURCE ARG + 'WAITING' PLACEHOLDER").
    if !hasReceivedTranscript {
      hasReceivedTranscript = true
      storage.deleteCharacters(in: NSRange(location: 0, length: storage.length))
    }
    let label = speaker == "you" ? "You: " : "Other: "
    let labelAttrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.boldSystemFont(ofSize: 12), .foregroundColor: NSColor.white,
    ]
    let textAttrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.white,
    ]
    let line = NSMutableAttributedString(string: label, attributes: labelAttrs)
    line.append(NSAttributedString(string: text + "\n", attributes: textAttrs))
    storage.append(line)
    textView.scrollToEndOfDocument(nil)
  }

  /// Applies the exponential moving average and redraws the relevant bar —
  /// see this file's header comment ("LEVEL METER"). `level` is expected
  /// pre-normalized to 0.0-1.0 by the caller, but is clamped defensively
  /// anyway since this reads directly off the wire.
  func updateAudioLevel(speaker: String, level: Double) {
    let clamped = max(0, min(1, level))
    // Perceptual curve — raw RMS levels for normal conversational speech sit
    // low relative to full-scale/clipping audio, so a linear map onto bar
    // width barely moves the meter. sqrt() compresses the low-to-mid range
    // outward (typical speech reads as visibly larger) while still
    // saturating at 1.0 for genuinely loud audio; the 1.1x gain on top gives
    // typical speech a further nudge without routinely pinning the meter at
    // max. Same curve/constants as call-capture-pill.ts's
    // __ethosUpdateAudioLevel, so both platforms read the same for the same
    // input level. Applied BEFORE the EMA below (not after): the EMA then
    // smooths the already-perceptually-scaled value, so the bar's
    // frame-to-frame motion stays proportionate to what's drawn instead of
    // smoothing a linear value and warping the result afterward.
    let perceptual = min(1, sqrt(clamped) * 1.1)
    if speaker == "you" {
      youLevelSmoothed = levelSmoothingAlpha * perceptual + (1 - levelSmoothingAlpha) * youLevelSmoothed
      audioLevelMeterView?.youLevel = youLevelSmoothed
    } else {
      otherLevelSmoothed = levelSmoothingAlpha * perceptual + (1 - levelSmoothingAlpha) * otherLevelSmoothed
      audioLevelMeterView?.otherLevel = otherLevelSmoothed
    }
  }

  /// `hide` (and stdin EOF — see the bottom of this file) route here. The
  /// daemon sends this once IT has actually finished tearing down capture,
  /// never as an immediate reaction to the "End" button click itself — see
  /// this file's header comment ("END BUTTON").
  func handleHide() {
    NSApp.terminate(nil)
  }

  @objc private func endButtonClicked() {
    emit(["event": "end_requested"])
  }
}

// MARK: - stdin command parsing

func handleStdinLine(_ delegate: AppDelegate, _ line: String) {
  let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8),
    let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let command = obj["command"] as? String
  else { return }
  switch command {
  case "transcript_append":
    let speaker = obj["speaker"] as? String ?? "other"
    let text = obj["text"] as? String ?? ""
    delegate.appendTranscript(speaker: speaker, text: text)
  case "audio_level":
    let speaker = obj["speaker"] as? String ?? "other"
    let level = obj["level"] as? Double ?? 0
    delegate.updateAudioLevel(speaker: speaker, level: level)
  case "hide":
    delegate.handleHide()
  default:
    emit(["event": "error", "message": "unrecognized command: \(command)"])
  }
}

// MARK: - Entry point

let app = NSApplication.shared
// Background helper, not a user-facing app — no Dock icon, no menu bar.
// This is what keeps `orderFrontRegardless()` from ever activating Ethos or
// stealing focus from whatever call app is frontmost.
app.setActivationPolicy(.accessory)

let delegate = AppDelegate()
// argv[1] is the clean source label (e.g. "zoom"), when the caller supplies
// one — see this file's header comment ("SOURCE ARG + 'WAITING'
// PLACEHOLDER"). Must be set before `app.run()` so it's available by the
// time `applicationDidFinishLaunching` builds the placeholder.
if CommandLine.arguments.count > 1, !CommandLine.arguments[1].isEmpty {
  delegate.initialSource = CommandLine.arguments[1]
}
app.delegate = delegate

// Blocking `readLine()` on a dedicated background thread — see this file's
// header comment ("STDIN/STDOUT PROTOCOL") for why this is simpler than a
// DispatchSourceRead here. Every line is hopped onto the main queue before
// touching AppKit.
DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine(strippingNewline: true) {
    let captured = line
    DispatchQueue.main.async {
      handleStdinLine(delegate, captured)
    }
  }
  // stdin closed (parent process gone, or explicitly closed the pipe) —
  // treat exactly like an explicit `hide`. Runs until killed (SIGTERM),
  // told to hide, or stdin closes — matching the "no fixed timeout"
  // contract this package's other native helpers already document.
  DispatchQueue.main.async {
    delegate.handleHide()
  }
}

app.run()
