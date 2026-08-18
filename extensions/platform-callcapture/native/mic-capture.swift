// mic-capture — captures the default input device (the USER's own voice) via
// AVAudioEngine.inputNode, converts to 16-bit signed little-endian PCM, mono,
// 16000 Hz, and streams raw bytes to stdout in ~200ms chunks. This is the
// mic-input half of Phase 3's dual-stream capture — `audiotee` (vendored by
// pinned commit, see ../README.md "Phase 3") captures the OTHER side (system
// output audio); this binary captures the user's own mic, which never goes
// through system output. See ../README.md for the full contract.
//
// Format matches `audiotee`'s stdout format exactly (pcm_s16le, mono, 16kHz)
// so the Node side treats both binaries' stdout identically — no per-stream
// conversion logic needed beyond parsing raw bytes into an Int16Array.
//
// Error stream: stderr, one JSON line per event, loosely mirroring audiotee's
// message_type shape (message_type + timestamp + data) for consistency, not
// byte-identical to it — see ../README.md "Phase 3" for why an exact mirror
// isn't required. On any AVAudioEngine/AVAudioConverter setup failure, prints
// a clear {"message_type":"error",...} line to stderr and exits non-zero —
// never a silent hang or empty output. Runs until killed (SIGTERM) or stdin
// closes — no fixed timeout in the shipped binary.

import AVFoundation
import Foundation

let TARGET_SAMPLE_RATE: Double = 16000
let CHUNK_DURATION_SECONDS: Double = 0.2  // mirrors audiotee's default chunk cadence

let isoFormatter: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  return f
}()

func nowISO8601() -> String {
  isoFormatter.string(from: Date())
}

// FileHandle.write() is a direct write(2) syscall, not buffered C stdio —
// unlike mic-detector.swift's `print()` + `fflush(stdout)` pattern, there is
// no buffer to flush here.
func emitStderr(_ messageType: String, _ data: [String: Any]) {
  let fields: [String: Any] = [
    "message_type": messageType,
    "timestamp": nowISO8601(),
    "data": data,
  ]
  guard let json = try? JSONSerialization.data(withJSONObject: fields),
    let line = String(data: json, encoding: .utf8)
  else { return }
  FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  emitStderr("error", ["message": message])
  exit(1)
}

let engine = AVAudioEngine()
let inputNode = engine.inputNode
let inputFormat = inputNode.outputFormat(forBus: 0)

guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
  fail("failed to read input node format (sampleRate=\(inputFormat.sampleRate)) — no input device available?")
}

guard
  let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: TARGET_SAMPLE_RATE,
    channels: 1,
    interleaved: true
  )
else {
  fail("failed to construct target 16kHz mono Int16 AVAudioFormat")
}

guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
  fail("failed to construct AVAudioConverter from \(inputFormat) to \(targetFormat)")
}

emitStderr(
  "metadata",
  [
    "encoding": "pcm_s16le",
    "channels_per_frame": 1,
    "bits_per_channel": 16,
    "sample_rate": Int(TARGET_SAMPLE_RATE),
    "source_sample_rate": inputFormat.sampleRate,
  ])

let bufferSize = AVAudioFrameCount(inputFormat.sampleRate * CHUNK_DURATION_SECONDS)

inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { buffer, _ in
  let ratio = TARGET_SAMPLE_RATE / inputFormat.sampleRate
  let outputCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
  guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputCapacity) else {
    emitStderr("error", ["message": "failed to allocate output buffer for conversion"])
    return
  }

  var conversionError: NSError?
  var inputConsumed = false
  let status = converter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
    if inputConsumed {
      inputStatus.pointee = .noDataNow
      return nil
    }
    inputConsumed = true
    inputStatus.pointee = .haveData
    return buffer
  }

  if status == .error {
    emitStderr(
      "error",
      ["message": "AVAudioConverter failed: \(conversionError?.localizedDescription ?? "unknown")"])
    return
  }

  guard let channelData = outputBuffer.int16ChannelData else { return }
  let frameLength = Int(outputBuffer.frameLength)
  if frameLength == 0 { return }
  let data = Data(bytes: channelData[0], count: frameLength * MemoryLayout<Int16>.size)
  FileHandle.standardOutput.write(data)
}

do {
  try engine.start()
} catch {
  fail("AVAudioEngine.start() failed: \(error.localizedDescription)")
}

emitStderr("stream_start", [:])

// Runs until killed (SIGTERM) or stdin closes and the process is torn down by
// its parent — no fixed timeout, matching mic-detector.swift's shipped
// long-running-watcher behavior.
RunLoop.main.run()
