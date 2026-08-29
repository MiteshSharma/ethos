// The far-end `agent_consult` — the ONE tool a phone caller's realtime session
// may call back into the agent with (voice V4 E6, eng-review D12/D13).
//
// WHY THIS IS A SEPARATE FACTORY, AND NOT A PARAMETER ON THE OWNER'S ONE.
// `build-agent-loop.ts` registers a consult tool pinned to
// `{ transport: 'browser-talk-mode', speaker: 'owner' }`, because the browser is
// the only surface in this repo that can open a realtime session behind the
// operator's own session cookie. A phone call is the opposite: whoever is on the
// other end is a stranger, and the spoken-confirmation gate refuses their
// requests BEFORE it consults any recorded confirmation
// (`./spoken-confirmation`). That refusal keys on exactly one field —
// `voiceOrigin.speaker` — so a call path that reused the owner's instance would
// silently promote every caller to the operator. Making it a distinct exported
// factory is what stops that from being a thing an app layer can forget.
//
// WHAT MAKES THE RECEPTIONIST SCOPE RESTRICTED. Nothing new. A turn's memory
// scope is `personality:<id>` and its tool allowlist is that personality's
// `toolset` — both derived from the personality in
// `packages/core/.../stages/turn-setup.ts`. Pinning the consulted turn to
// `voice.inbound.receptionist` therefore denies owner memory and privileged
// tools by construction: the receptionist's `memoryScope` is its own, and a tool
// it does not list is rejected by `ToolRegistry.executeParallel` exactly as any
// other disallowed tool is. There is no second restriction system to keep in
// step with the first.

import type { AgentLoop } from '@ethosagent/core';
import { createAgentConsultTool } from '@ethosagent/tools-voice';
import type { Tool, VoiceTurnOrigin } from '@ethosagent/types';

/**
 * The voice origin every telephony turn carries.
 *
 * `speaker: 'far_end'` is the whole security property: the person on the phone
 * is not the operator, cannot become the operator by sounding confident, and
 * cannot be made the operator by any confirmation this process recorded.
 */
export const FAR_END_VOICE_ORIGIN: VoiceTurnOrigin = {
  transport: 'sip',
  speaker: 'far_end',
};

export interface FarEndConsultOptions {
  /**
   * `voice.inbound.receptionist` — the personality a NON-ALLOWLISTED caller's
   * consult runs as. Omit for an allowlisted caller, whose call already routes
   * to the bot's own personality and who therefore needs no pin.
   */
  receptionistPersonalityId?: string;
}

/**
 * Build the `agent_consult` tool for a phone call.
 *
 * Register it on the tool registry the call's realtime session advertises from
 * (`deriveRealtimeToolset` reads what is actually wired), NOT on the loop's
 * shared registry — the owner's instance lives there and the two must not
 * collide on the same name.
 */
export function createFarEndConsultTool(loop: AgentLoop, opts: FarEndConsultOptions = {}): Tool {
  return createAgentConsultTool(loop, {
    voiceOrigin: FAR_END_VOICE_ORIGIN,
    ...(opts.receptionistPersonalityId ? { personalityId: opts.receptionistPersonalityId } : {}),
  });
}
