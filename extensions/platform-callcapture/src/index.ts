export type {
  AudioCaptureHandle,
  AudioSpawnFn,
  Clock as AudioProcessClock,
  ReadyLineResult,
  SpawnedAudioChild,
  StartAudioCaptureOptions,
} from './audio-process';
export { createDefaultAudioSpawn, pcmChunksFromStdout, startAudioCapture } from './audio-process';
export type {
  CallCaptureDaemonLogger,
  CallCaptureDaemonOptions,
  CallCaptureDependencyCheck,
  CallCaptureDetectorPort,
  CallCaptureIndicatorPort,
  CallCaptureNotificationGatePort,
  CallCaptureWakeEvent,
  DaemonState,
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
export type {
  CaptureIndicatorOptions,
  IndicatorSpawnFn,
  SpawnedIndicatorChild,
} from './indicator';
export { CaptureIndicator } from './indicator';
export type { MicCaptureOptions } from './mic-capture';
export { MicCapture } from './mic-capture';
export type {
  CaptureOfferCardChild,
  CaptureOfferCardSpawnFn,
  CaptureOfferHandle,
  CaptureOfferOutcome,
  NotificationGateOptions,
  PresentCaptureOfferOptions,
} from './notification';
export { NotificationGate } from './notification';
export type {
  CallCaptureOwnershipManagerOptions,
  ClaimOwnershipResult,
  IsProcessAlive,
  TryClaimOwnershipDeps,
} from './ownership';
export { CallCaptureOwnershipManager, tryClaimOwnership } from './ownership';
export type {
  CallCaptureDependencyCheckResult,
  CheckCallCaptureDependenciesDeps,
} from './preflight';
export { checkCallCaptureDependencies } from './preflight';
export { KNOWN_CALLING_APP_PROCESSES, sourceLabelForProcessName } from './process-prefilter';
export type { TapCaptureOptions } from './tap-capture';
export { TapCapture } from './tap-capture';
export type { Speaker, TranscriptEntry, TranscriptSessionOptions } from './transcript-session';
export { computeRmsLevel, runTranscriptSession } from './transcript-session';
