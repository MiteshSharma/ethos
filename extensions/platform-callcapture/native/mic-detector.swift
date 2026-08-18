// mic-detector — watches the current default input device's
// kAudioDevicePropertyDeviceIsRunningSomewhere and emits one line of
// newline-delimited JSON per event to stdout. Event-driven (CoreAudio
// property-listener callbacks), no polling. See ../README.md for the full
// contract this binary implements and how the Node wrapper consumes it.
//
// Error stream: on failure this process writes a single
// {"event":"error","message":"..."} line to STDOUT — the same stream as every
// other event — and exits non-zero. stdout was chosen (not stderr) so the
// Node wrapper only has to read one NDJSON stream to see every event,
// including failures. See README "Error stream" for the rationale.

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

func emitError(_ message: String) -> Never {
  emit(["event": "error", "message": message])
  exit(1)
}

func defaultInputDevice() -> AudioDeviceID? {
  var deviceID = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  let status = AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID)
  return status == noErr ? deviceID : nil
}

func isRunningSomewhere(_ deviceID: AudioDeviceID) -> Bool? {
  var running: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  let status = AudioObjectGetPropertyData(deviceID, &addr, 0, nil, &size, &running)
  guard status == noErr else { return nil }
  return running != 0
}

// Serializes every CoreAudio callback plus the two `AudioObjectGetPropertyData`
// reads triggered from those callbacks, so `lastRunning`/`deviceID` on
// `DeviceWatcher` are never touched from two threads at once.
let audioQueue = DispatchQueue(label: "com.ethosagent.callcapture.mic-detector")

/// Watches one device's running-state, and can be re-pointed at a new device
/// (e.g. the user plugs in headphones mid-run, which changes the system
/// default input device) without missing a running-state change that
/// happens to coincide with the swap.
final class DeviceWatcher {
  private var deviceID: AudioDeviceID
  private var runningAddr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  private var lastRunning: Bool

  // Stored (not recreated per attach/detach) because
  // AudioObjectRemovePropertyListenerBlock only removes a listener if passed
  // the exact same block reference that was added.
  private lazy var listenerBlock: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
    self?.handleChange()
  }

  init(deviceID: AudioDeviceID, initialRunning: Bool) {
    self.deviceID = deviceID
    self.lastRunning = initialRunning
    attach()
  }

  private func attach() {
    let status = AudioObjectAddPropertyListenerBlock(deviceID, &runningAddr, audioQueue, listenerBlock)
    if status != noErr {
      emitError("failed to attach running-state listener for device \(deviceID) (status \(status))")
    }
  }

  private func detach() {
    _ = AudioObjectRemovePropertyListenerBlock(deviceID, &runningAddr, audioQueue, listenerBlock)
  }

  private func handleChange() {
    guard let running = isRunningSomewhere(deviceID) else { return }
    guard running != lastRunning else { return }
    lastRunning = running
    emit(["event": "running_changed", "running": running, "deviceId": deviceID, "at": nowISO8601()])
  }

  func retarget(to newDeviceID: AudioDeviceID) {
    guard newDeviceID != deviceID else { return }
    detach()
    deviceID = newDeviceID
    guard let running = isRunningSomewhere(newDeviceID) else {
      emitError("failed to read running state on new default input device \(newDeviceID)")
    }
    attach()
    guard running != lastRunning else { return }
    lastRunning = running
    emit(["event": "running_changed", "running": running, "deviceId": deviceID, "at": nowISO8601()])
  }
}

guard let initialDevice = defaultInputDevice() else {
  emitError("failed to resolve the default input device")
}
guard let initialRunning = isRunningSomewhere(initialDevice) else {
  emitError("failed to read initial running state for device \(initialDevice)")
}

emit(["event": "initial", "running": initialRunning, "deviceId": initialDevice, "at": nowISO8601()])

let watcher = DeviceWatcher(deviceID: initialDevice, initialRunning: initialRunning)

var defaultDeviceAddr = AudioObjectPropertyAddress(
  mSelector: kAudioHardwarePropertyDefaultInputDevice,
  mScope: kAudioObjectPropertyScopeGlobal,
  mElement: kAudioObjectPropertyElementMain)

let defaultDeviceListener: AudioObjectPropertyListenerBlock = { _, _ in
  guard let newDevice = defaultInputDevice() else { return }
  watcher.retarget(to: newDevice)
}

let defaultDeviceStatus = AudioObjectAddPropertyListenerBlock(
  AudioObjectID(kAudioObjectSystemObject), &defaultDeviceAddr, audioQueue, defaultDeviceListener)
if defaultDeviceStatus != noErr {
  emitError("failed to attach default-input-device change listener (status \(defaultDeviceStatus))")
}

// Runs until killed (SIGTERM) or stdin closes and the process is torn down
// by its parent — no fixed timeout. A timeout was only used for the manual
// research probe that validated this approach; the shipped binary is a
// long-running watcher.
RunLoop.main.run()
