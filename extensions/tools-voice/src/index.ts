// @ethosagent/tools-voice — the outbound telephony `call` tool
// (plan/phases/gap-voice-realtime.md §4 Phase C).
//
// `call` places an outbound PSTN call via the injected `SipTrunkClient`
// boundary (`@ethosagent/platform-voice`) and bridges it into a LiveKit room,
// where the existing VoiceChannelAdapter -> VoiceSession stack handles the
// conversation. The concrete SIP binding (`livekit-server-sdk` SIP API) is
// supplied at the app layer — this package binds ONLY to the interface, so it
// typechecks and unit-tests against a fake trunk.
//
// APPROVAL: the tool is marked `requiresApproval: true`. That flag is
// DECLARATIVE ONLY — AgentLoop emits a `tool_approval_required` event and then
// runs the tool regardless (packages/core/.../tool-processing.ts); nothing
// consumes the event today, so the flag on its own blocks nothing. The
// mechanism that actually prompts is the `before_tool_call` approval hook, whose
// danger predicate flags tools by name via `alwaysAsk` (see
// `APPROVAL_SURFACE_ALWAYS_ASK` in packages/wiring/src/danger-predicate.ts).
// `call` is NOT in that set, so an autonomous turn on a surface with an approval
// flow is not currently gated from dialling; adding it there is what would gate
// it.

import type {
  OutboundCallHandle,
  OutboundCallRequest,
  SipTrunkClient,
} from '@ethosagent/platform-voice';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

export type { AgentConsultOptions, DeriveRealtimeToolsetOptions } from './agent-consult';
export {
  AGENT_CONSULT_MAX_RESULT_CHARS,
  AGENT_CONSULT_TOOL,
  buildRealtimeInstructions,
  createAgentConsultTool,
  deriveRealtimeToolset,
  REALTIME_BOUNDARY_POLICY,
  REALTIME_SAFE_TOOLS,
} from './agent-consult';
export type {
  RealtimeDispatchContext,
  RealtimeToolCall,
  RealtimeToolHost,
  RealtimeToolHostOptions,
  RealtimeToolResult,
} from './realtime-host';
export { createRealtimeToolHost, REALTIME_UNKNOWN_TOOL } from './realtime-host';

export interface VoiceToolsOptions {
  /**
   * SIP trunk boundary used to place the call. Optional: default installs wire
   * no trunk (the live LiveKit/SIP binding is app-layer/manual), so the `call`
   * tool reports itself unavailable until one is configured. The
   * `voice_session` capability tool stays available regardless.
   */
  trunk?: SipTrunkClient;
  /**
   * LiveKit room the outbound call is bridged into, derived from the
   * destination number. Defaults to `call-<sanitized toNumber>`. The agent
   * joins the same room via the app-layer LiveKit transport.
   */
  roomNameFor?: (toNumber: string) => string;
  /** Caller-ID presented to the callee (E.164). From `voice.trunk.fromNumber`. */
  fromNumber?: string;
}

export function createVoiceTools(opts: VoiceToolsOptions = {}): Tool[] {
  return [makeVoiceSessionTool(), makeCallTool(opts)];
}

/**
 * `voice_session` is the availability *capability* that marks a personality as
 * engageable in a real-time voice session (browser talk-mode / telephony). The
 * live session is driven by the voice channel adapter, NOT invoked by the model
 * — this tool exists so the capability appears in the toolset catalog/picker and
 * the web talk-mode gate (`personalityCanTalk`) can key off it. It is therefore
 * ALWAYS available: selecting it is how an operator opts a personality into
 * voice, independent of whether live LiveKit infra is wired. A stray model call
 * is harmless — it just explains that the session is channel-managed.
 */
function makeVoiceSessionTool(): Tool {
  return {
    name: 'voice_session',
    description:
      'Capability marker: this personality can be engaged in a real-time voice session ' +
      '(browser talk-mode or telephony). The live session is managed by the voice channel, ' +
      'not invoked by the model — calling this tool does nothing but confirm that.',
    toolset: 'voice',
    maxResultChars: 256,
    capabilities: {},
    isAvailable: () => true,
    schema: {
      type: 'object',
      properties: {},
    },
    async execute(): Promise<ToolResult> {
      return {
        ok: true,
        value:
          'voice_session is a capability marker — the real-time voice session is managed by the ' +
          'voice channel adapter (browser talk-mode / telephony), not started from here.',
      };
    },
  };
}

interface CallArgs {
  to_number: string;
  room_name?: string;
}

function makeCallTool(opts: VoiceToolsOptions): Tool {
  return {
    name: 'call',
    description:
      'Place an outbound phone call to an E.164 number and connect it to the live voice agent. ' +
      'This dials a real phone number and always requires explicit approval before the call is placed.',
    toolset: 'voice',
    maxResultChars: 512,
    capabilities: {},
    requiresApproval: true,
    isAvailable: () => opts.trunk !== undefined,
    schema: {
      type: 'object',
      properties: {
        to_number: {
          type: 'string',
          description: 'Destination phone number in E.164 format (e.g. +15551234567).',
        },
        room_name: {
          type: 'string',
          description:
            'Optional LiveKit room to bridge the call into. Defaults to a per-call room.',
        },
      },
      required: ['to_number'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      return await executeCall(args as CallArgs, ctx, opts);
    },
  };
}

async function executeCall(
  args: CallArgs,
  _ctx: ToolContext,
  opts: VoiceToolsOptions,
): Promise<ToolResult> {
  if (!opts.trunk) {
    return {
      ok: false,
      code: 'not_available',
      error: 'Outbound calling is not configured — no SIP trunk is wired.',
    };
  }
  const toNumber = args.to_number?.trim();
  if (!toNumber || !/^\+[1-9]\d{6,14}$/.test(toNumber)) {
    return {
      ok: false,
      code: 'input_invalid',
      error: `to_number must be an E.164 number (e.g. +15551234567), got: ${args.to_number ?? '(missing)'}`,
      field: 'to_number',
    };
  }
  const roomName = args.room_name?.trim() || defaultRoomName(toNumber, opts.roomNameFor);
  const req: OutboundCallRequest = {
    toNumber,
    roomName,
    ...(opts.fromNumber ? { fromNumber: opts.fromNumber } : {}),
  };
  try {
    const handle: OutboundCallHandle = await opts.trunk.createOutboundCall(req);
    return {
      ok: true,
      value: `Calling ${handle.toNumber} (call ${handle.callId}, room ${handle.roomName}).`,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'execution_failed',
      error: `Failed to place call to ${toNumber}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    };
  }
}

function defaultRoomName(toNumber: string, roomNameFor?: (n: string) => string): string {
  if (roomNameFor) return roomNameFor(toNumber);
  return `call-${toNumber.replace(/[^0-9]/g, '')}`;
}
