export type {
  AudioCaptureHandle,
  AudioSpawnFn,
  Clock as AudioProcessClock,
  ReadyLineResult,
  SpawnedAudioChild,
  StartAudioCaptureOptions,
} from './audio-process';
export { createDefaultAudioSpawn, pcmChunksFromStdout, startAudioCapture } from './audio-process';
export type { ClickListener } from './click-listener';
export { createClickListener } from './click-listener';
export type {
  CallCaptureDaemonLogger,
  CallCaptureDaemonOptions,
  CallCaptureDependencyCheck,
  CallCaptureDetectorPort,
  CallCaptureNotificationGatePort,
  CallCaptureProcessGateCheck,
  CallCaptureWakeEvent,
} from './daemon';
export { CallCaptureDaemon } from './daemon';
export type {
  Clock,
  MicActivityDetectorOptions,
  MicActivityEvent,
  SpawnedChild,
  SpawnFn,
} from './detector';
export { MicActivityDetector } from './detector';
export { callCaptureHealthPath, callCaptureLockPath } from './health';
export type { MicCaptureOptions } from './mic-capture';
export { MicCapture } from './mic-capture';
export type {
  CaptureOfferHandle,
  CaptureOfferOutcome,
  NotificationGateOptions,
  PresentCaptureOfferOptions,
  TerminalNotifierRunFn,
  TerminalNotifierRunResult,
} from './notification';
export { NotificationGate } from './notification';
export type { ClaimOwnershipResult, IsProcessAlive, TryClaimOwnershipDeps } from './ownership';
export { tryClaimOwnership } from './ownership';
export type {
  CallCaptureDependencyCheckResult,
  CheckCallCaptureDependenciesDeps,
  PreflightResult,
  PreflightSpawnFn,
  PreflightSpawnResult,
} from './preflight';
export { checkCallCaptureDependencies, checkTerminalNotifierAvailable } from './preflight';
export type { CheckProcessRunning } from './process-prefilter';
export {
  checkAnyCallingAppRunning,
  defaultCheckProcessRunning,
  KNOWN_CALLING_APP_PROCESSES,
  sourceLabelForProcessName,
} from './process-prefilter';
export type { TapCaptureOptions } from './tap-capture';
export { TapCapture } from './tap-capture';
export type { Speaker, TranscriptEntry, TranscriptSessionOptions } from './transcript-session';
export { runTranscriptSession } from './transcript-session';
