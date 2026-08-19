// mic-detector — per-process CoreAudio + NSWorkspace watcher for known
// calling apps. Emits one line of newline-delimited JSON per event to
// stdout. See ../README.md, "Per-process detection" section, for the full
// contract and the empirical findings that drove this design (superseding
// the original per-DEVICE approach documented earlier in that same file).
//
// THE BUG THIS REPLACES: `kAudioDevicePropertyDeviceIsRunningSomewhere`
// (this file's original approach) is a system-wide "is ANYTHING using this
// input device" flag. Confirmed empirically in production use: Zoom keeps
// it warm in the background even after a call ends (as long as the app
// stays open), so it never returns to false and a capture would run
// unattended indefinitely. Quitting the app releases it, but "quit the app
// to stop a stuck recording" isn't an acceptable fix.
//
// THE FIX: CoreAudio has a per-PROCESS signal.
// `kAudioHardwarePropertyTranslatePIDToProcessObject` (on the system
// object) maps a `pid_t` to an `AudioObjectID` representing that process
// within the audio HAL; `kAudioProcessPropertyIsRunningInput` on that
// object answers "is THIS SPECIFIC process currently running an input
// stream" — independent of what else is using the device. Verified
// empirically (see README): this returns to false the moment a process
// stops using the mic, even while it stays alive and even while a
// DIFFERENT process keeps the device busy — exactly the property the
// device-wide flag lacked.
//
// EMPIRICAL FINDING THAT SHAPES THIS FILE'S DESIGN: unlike the device-level
// listener this file used to install (which fires reliably —
// `AudioObjectAddPropertyListenerBlock` on a Device object works exactly as
// documented), the equivalent listener on a Process object was verified NOT
// to fire in practice: registration succeeds (status `noErr`) for both
// `kAudioProcessPropertyIsRunningInput` and `kAudioProcessPropertyIsRunning`,
// across both `kAudioObjectPropertyScopeGlobal` and
// `kAudioObjectPropertyScopeInput`, but the callback was never observed to
// fire during a real transition in repeated testing — while polling the
// EXACT SAME property on the EXACT SAME object correctly observed every
// transition within one poll tick. This isn't treated as a bug in this
// file; the Core Audio Process/Tap object surface is young (introduced
// macOS 14.2+) and already carries an "API Instability Warning" in
// `audiotee`'s own README (vendored by this package for Phase 3 capture).
// Consequence: this file POLLS the per-process property — but only for the
// bounded set of currently-running KNOWN CALLING APPS (typically 0-1
// processes), and only while at least one such app is open (the poll timer
// itself is started/stopped as apps launch/quit). App PRESENCE — which
// known apps are running, and their PIDs — is fully event-driven via
// `NSWorkspace` launch/terminate notifications, with no polling at all when
// no known calling app is open. This keeps the "no measurable battery cost
// from continuous all-day background operation" property for the common
// case (no calling app running), while accepting a small, bounded,
// documented poll for the uncommon case (a calling app happens to be open).

import AppKit
import CoreAudio
import Foundation

let isoFormatter: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  return f
}()

func nowISO8601() -> String {
  isoFormatter.string(from: Date())
}

func emit(_ fields: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: fields),
    let json = String(data: data, encoding: .utf8)
  else {
    return
  }
  print(json)
  // Node reads this as a child-process pipe, not a TTY — stdio is fully
  // buffered rather than line-buffered in that case, so without an explicit
  // flush events can sit in the buffer indefinitely instead of reaching the
  // reader as they happen.
  fflush(stdout)
}

/// Known macOS calling-app process (executable) names. MUST be kept in sync
/// by hand with `src/process-prefilter.ts`'s `KNOWN_CALLING_APP_PROCESSES`
/// — Swift can't import the TS source, and this package already accepts
/// this exact duplication pattern elsewhere (see process-prefilter.ts's own
/// header comment re: extensions/watchers). Verified empirically that
/// `NSRunningApplication.executableURL?.lastPathComponent` equals the
/// process name `pgrep -x` would match for every installed app checked
/// (zoom.us, Discord, FaceTime — via each app's `CFBundleExecutable`) — this
/// is the correct match key, NOT `localizedName` or `bundleIdentifier`
/// (which vary release-to-release for some of these apps, e.g. Teams'
/// classic vs. new bundle IDs).
let knownCallingAppProcessNames: Set<String> = [
  "zoom.us",
  "Microsoft Teams",
  "Discord",
  "Skype",
  "FaceTime",
  "Webex",
  "GoToMeeting",
]

/// How often the per-process `kAudioProcessPropertyIsRunningInput` flag is
/// polled, for each currently-tracked known calling app. See this file's
/// header comment for why polling is necessary here (unlike the app
/// presence tracking below, which is event-driven).
let pollInterval: TimeInterval = 2.0

func translatePIDToProcessObject(_ pid: pid_t) -> AudioObjectID? {
  var processObjectID = AudioObjectID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var qualifierPid = pid
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &addr, UInt32(MemoryLayout<pid_t>.size), &qualifierPid,
    &size, &processObjectID)
  guard status == noErr, processObjectID != kAudioObjectUnknown else { return nil }
  return processObjectID
}

func isRunningInput(_ processObjectID: AudioObjectID) -> Bool? {
  var running: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioProcessPropertyIsRunningInput,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  let status = AudioObjectGetPropertyData(processObjectID, &addr, 0, nil, &size, &running)
  guard status == noErr else { return nil }
  return running != 0
}

func executableName(_ app: NSRunningApplication) -> String? {
  app.executableURL?.lastPathComponent
}

/// One currently-running known-calling-app instance.
final class TrackedApp {
  let pid: pid_t
  let processName: String
  var processObjectID: AudioObjectID?
  var running = false

  init(pid: pid_t, processName: String) {
    self.pid = pid
    self.processName = processName
  }

  /// Resolves the PID->ProcessObject translation if not already resolved
  /// (retried on every poll tick — self-healing for the case where a
  /// freshly-launched app hasn't registered with the audio HAL yet), then
  /// refreshes `running`. Leaves the previous value in place on a transient
  /// read failure rather than guessing.
  func refresh() {
    if processObjectID == nil {
      processObjectID = translatePIDToProcessObject(pid)
    }
    guard let id = processObjectID, let isRunning = isRunningInput(id) else { return }
    running = isRunning
  }
}

// Everything below runs on the main queue/run loop only: NSWorkspace
// notifications (requested with `queue: .main` below) and the poll timer
// (scheduled on `.main`) are therefore fully serialized against each other
// with no risk of a launch/terminate notification racing a poll tick — no
// lock is needed. This is a deliberate difference from the device-level
// listener this file used to install, which genuinely needed a dedicated
// serial queue because CoreAudio invoked that callback from its own
// internal queue.
var trackedApps: [pid_t: TrackedApp] = [:]
var pollTimer: DispatchSourceTimer?
var aggregateRunning = false

func startPollingIfNeeded() {
  guard pollTimer == nil, !trackedApps.isEmpty else { return }
  let timer = DispatchSource.makeTimerSource(queue: .main)
  timer.schedule(deadline: .now() + pollInterval, repeating: pollInterval)
  timer.setEventHandler {
    for app in trackedApps.values { app.refresh() }
    recomputeAggregate()
  }
  timer.resume()
  pollTimer = timer
}

func stopPollingIfIdle() {
  guard trackedApps.isEmpty, let timer = pollTimer else { return }
  timer.cancel()
  pollTimer = nil
}

/// "A call is active" = at least one tracked known calling app currently
/// shows running input — tracked independently per app, so two known apps
/// open at once (e.g. Zoom and Teams) only report "not in a call" once
/// BOTH show not-running-input. Emits `running_changed` only on an actual
/// aggregate transition, carrying the triggering app's raw process name as
/// `source` when transitioning to true (the Node wrapper maps this to a
/// clean label). `running: false` carries no `source` — a call ending
/// doesn't need to name an app, and with multiple apps tracked there isn't
/// a single one to name.
func recomputeAggregate() {
  let anyRunning = trackedApps.values.contains { $0.running }
  guard anyRunning != aggregateRunning else { return }
  aggregateRunning = anyRunning
  if anyRunning {
    let source = trackedApps.values.first(where: { $0.running })?.processName ?? "unknown"
    emit(["event": "running_changed", "running": true, "source": source, "at": nowISO8601()])
  } else {
    emit(["event": "running_changed", "running": false, "at": nowISO8601()])
  }
}

func handleAppLaunched(_ app: NSRunningApplication) {
  guard let name = executableName(app), knownCallingAppProcessNames.contains(name) else { return }
  guard trackedApps[app.processIdentifier] == nil else { return }
  let tracked = TrackedApp(pid: app.processIdentifier, processName: name)
  tracked.refresh()
  trackedApps[app.processIdentifier] = tracked
  startPollingIfNeeded()
  recomputeAggregate()
}

func handleAppTerminated(_ app: NSRunningApplication) {
  guard trackedApps.removeValue(forKey: app.processIdentifier) != nil else { return }
  recomputeAggregate()
  stopPollingIfIdle()
}

// --- Startup: seed the tracked-app set from whatever known calling apps
// are already running, silently (no running_changed events — this seeds
// `aggregateRunning`, then exactly one "initial" event is emitted below,
// mirroring the prior per-device contract's "initial" event so the Node
// wrapper doesn't have to guess the starting state). ---
for app in NSWorkspace.shared.runningApplications {
  guard let name = executableName(app), knownCallingAppProcessNames.contains(name) else { continue }
  guard trackedApps[app.processIdentifier] == nil else { continue }
  let tracked = TrackedApp(pid: app.processIdentifier, processName: name)
  tracked.refresh()
  trackedApps[app.processIdentifier] = tracked
}
aggregateRunning = trackedApps.values.contains { $0.running }
if aggregateRunning {
  let source = trackedApps.values.first(where: { $0.running })?.processName ?? "unknown"
  emit(["event": "initial", "running": true, "source": source, "at": nowISO8601()])
} else {
  emit(["event": "initial", "running": false, "at": nowISO8601()])
}
startPollingIfNeeded()

// --- Reactive: known-calling-app presence, fully event-driven via
// NSWorkspace. `queue: .main` pins delivery to the same queue the poll
// timer runs on (see the comment on `trackedApps` above). ---
let workspaceCenter = NSWorkspace.shared.notificationCenter
workspaceCenter.addObserver(
  forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main
) { note in
  guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
    return
  }
  handleAppLaunched(app)
}
workspaceCenter.addObserver(
  forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
) { note in
  guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
    return
  }
  handleAppTerminated(app)
}

// Runs until killed (SIGTERM) or stdin closes and the process is torn down
// by its parent — no fixed timeout.
RunLoop.main.run()
