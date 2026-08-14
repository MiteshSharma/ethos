// @ethosagent/voice-satellite — the shared wake-satellite runtime.
//
// Both hosts wire the same three pieces: a wake engine, the supervised capture
// state machine, and the node-protocol client. The hosts differ only in where
// the microphone comes from and how the process is supervised.
//
// HEADLESS-SAFE BY CONSTRUCTION. Importing this barrel loads no audio library,
// no ONNX runtime, and no native binding. The capture device is a declared
// interface with no implementation (`audio-device.ts`), and the acoustic engine
// reaches `sherpa-onnx-node` only through a lazy `import()` inside its probe and
// `init()`. That is what lets the gateway — which must never open an audio
// device — share this package's contracts without inheriting its dependencies.

export type { AudioDeviceInfo, CaptureDevice, CaptureEnd } from './audio-device';
export {
  CaptureMachine,
  type CaptureMachineConfig,
  type CaptureMachineDeps,
  type CaptureState,
} from './capture';
export {
  type DoctorProbeRow,
  runSatelliteDoctor,
  type SatelliteDoctorOptions,
  type SatelliteDoctorResult,
} from './doctor';
export {
  createSherpaWakeEngineFactory,
  type SherpaModelFiles,
  type SherpaWakeEngineConfig,
} from './engines/sherpa-wake-engine';
export {
  boundedLevenshtein,
  createTranscriptWakeEngine,
  normalizeUtterance,
  type TranscriptWakeEngine,
  transcriptWakeEngineFactory,
  wakePhraseKey,
} from './engines/transcript-wake-engine';
export {
  createSatelliteClient,
  type SatelliteClient,
  type SatelliteClientOptions,
  type SatelliteErrorDetail,
  type SatellitePlayoutEvent,
  type SatelliteSocket,
  type SatelliteSocketFactory,
  type SatelliteSocketHandlers,
} from './node-client';
export { createEnergyFrameVad, type FrameVad } from './vad-adapter';
export type {
  WakeEngine,
  WakeEngineFactory,
  WakeEngineOptions,
  WakeEngineProbe,
  WakeFrame,
  WakeMatch,
  WakeRoute,
} from './wake-engine';
export { createWsSatelliteSocket } from './ws-socket';
