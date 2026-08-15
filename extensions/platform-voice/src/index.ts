// @ethosagent/platform-voice — transport-agnostic real-time voice channel
// adapter. Bridges a VoiceTransport (LiveKit, Twilio, browser mic — concrete
// transports land in later steps) to a VoiceSession from
// @ethosagent/voice-session.

export {
  type VoiceArtifact,
  type VoiceBotIdentity,
  VoiceChannelAdapter,
  type VoiceChannelAdapterDeps,
} from './adapter';
export type {
  LiveKitAudioFrame,
  LiveKitConnectOptions,
  LiveKitRoomClient,
  LiveKitTokenMinter,
} from './livekit/room-client';
export {
  createLiveKitSipJwt,
  createLiveKitTokenMinter,
  type LiveKitSipJwtOptions,
  type LiveKitTokenMinterOptions,
} from './livekit/token';
export {
  createLiveKitTransport,
  type LiveKitRoomBinding,
  type LiveKitTransportFactoryDeps,
  LiveKitVoiceTransport,
  type LiveKitVoiceTransportConfig,
  type LiveKitVoiceTransportDeps,
  resamplePcm,
} from './livekit/transport';
export {
  createFramePacer,
  type FramePacer,
  type FramePacerOptions,
  type FramePacerTimer,
} from './sip/frame-pacer';
export {
  aLawToPcm16,
  muLawToPcm16,
  pcm16ToALaw,
  pcm16ToMuLaw,
  resamplePcm16,
} from './sip/g711';
export {
  createInboundDispatcher,
  type InboundDispatchDeps,
  matchesVoicePattern,
  resolveVoiceBot,
} from './sip/inbound-dispatch';
export {
  type CallConcurrencyLimiter,
  createCallConcurrencyLimiter,
  createPerCallerRateLimiter,
  createVoiceDailyBudget,
  decideInboundCall,
  type InboundCallDecision,
  type InboundCallDecisionInput,
  isAllowlistedCaller,
  type PerCallerRateLimiter,
  type VoiceDailyBudget,
} from './sip/inbound-gate';
export { createPostCallSummary, type PostCallSummaryDeps } from './sip/post-call-summary';
export {
  createSipRealtimeBridge,
  type SipBridgeEvent,
  type SipRealtimeBridge,
  type SipRealtimeBridgeDeps,
  type SipToolCall,
  type SipToolDispatcher,
  type SipWireCodec,
} from './sip/realtime-bridge';
export type {
  InboundSipCall,
  OutboundCallHandle,
  OutboundCallRequest,
  SipTrunkClient,
} from './sip/trunk-client';
export {
  createLiveKitSipTrunkClient,
  type LiveKitSipTrunkOptions,
} from './sip/trunk-client-livekit';
export {
  parseInboundSipCall,
  type SipWebhookProvider,
  type VerifyWebhookInput,
  type VerifyWebhookResult,
  verifySipWebhook,
} from './sip/webhook';
export type { OutboundAudioFrame, VoiceTransport } from './transport';
