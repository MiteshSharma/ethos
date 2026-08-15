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
// danger predicate flags tools by name via `alwaysAsk`.
//
// `call` IS in `APPROVAL_SURFACE_ALWAYS_ASK`
// (packages/wiring/src/danger-predicate.ts), so on every surface that runs an
// approval flow a dial is flagged for approval regardless of approval mode.
// It is therefore also in `SPOKEN_CONFIRMATION_TOOLS`, which is derived from
// that set: a call REQUESTED out loud needs a verbal re-confirmation, and a
// far-end caller's voice can never satisfy one
// (packages/wiring/src/spoken-confirmation.ts). A surface with no approval hook
// wired — a bare library embedding — still has no gate; the flag alone is not
// one.

import type { CallLog, StartCallInput, UpdateCallInput } from '@ethosagent/call-log';
import { deriveBotKey, voiceLaneKey } from '@ethosagent/core';
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
  /**
   * Durable call history. Inbound calls have written rows since voice V4; an
   * agent-PLACED call wrote none, so Communications → Calls showed the owner
   * every call they received and none of the calls their agent made on their
   * behalf — which is the one they most want to see.
   *
   * An OPTIONAL seam, never a dependency: absent (standalone embeddings, tests)
   * and the tool behaves exactly as it did. A log that throws is reported
   * through {@link VoiceToolsOptions.onError} and the dial proceeds — the row is
   * a record OF the call, not a precondition for it.
   */
  callLog?: CallLog;
  /**
   * Reports a call-log write that failed. Absent means swallowed: library code
   * has no console, and a surface that wires no reporter has said it does not
   * want one.
   */
  onError?: (message: string) => void;
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
  // Keyed by the ROOM, not by the provider's call id. The room is the only id
  // that exists BEFORE the dial, and it is the same key inbound dispatch uses
  // (`callId = call.roomName`), so one convention covers both directions and a
  // hang-up webhook for this room finds this row. Written before the dial so a
  // call that never connects is still on record.
  const botKey = deriveBotKey(opts.fromNumber ?? OUTBOUND_BOT_KEY_SEED);
  await logStart(opts, {
    id: roomName,
    botKey,
    // The far end seeds the lane, as inbound: there it is the caller, here the
    // callee.
    laneKey: voiceLaneKey(botKey, { kind: 'sip', id: toNumber }),
    direction: 'outbound',
    fromNumber: opts.fromNumber ?? UNKNOWN_NUMBER,
    toNumber,
    status: 'ringing',
  });
  try {
    const handle: OutboundCallHandle = await opts.trunk.createOutboundCall(req);
    // The trunk accepted the dial, and that is the LAST thing this process ever
    // learns about the call: nothing here joins the room or hears the far end
    // hang up. So the row is closed now, at the only moment there is anything
    // true to write.
    //
    // It must not stay `ringing`: `ringing` is LIVE STATE, and a row nobody will
    // ever move out of it means `listLive()` claims a call is in progress
    // forever — one stuck "call in progress" indicator per outbound call the
    // agent has ever placed.
    //
    // `completed` is the weakest claim the union offers. `failed` would say the
    // dial broke when it did not; `screened`/`refused` would say Ethos made a
    // decision it never made; only `completed` asserts nothing about HOW the
    // call ended. What it does not know, the reason says out loud — so the row
    // records "we placed it and stopped watching", never "it went fine".
    //
    // And NO `endedAt`: this is the moment the trunk accepted the dial, not the
    // moment the call ended, which nothing here observed. Writing it would put a
    // fabricated `0:00` in the same duration column as real inbound call
    // lengths. Leaving it unset is what "nobody timed this call" looks like —
    // `listLive()` filters on status alone, so the row still leaves the live
    // list, and `pruneEnded` already falls back to `started_at`.
    await logUpdate(opts, roomName, {
      status: 'completed',
      reason: OUTBOUND_UNOBSERVED_REASON,
    });
    return {
      ok: true,
      value: `Calling ${handle.toNumber} (call ${handle.callId}, room ${handle.roomName}).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logUpdate(opts, roomName, { status: 'failed', endedAt: Date.now(), reason: message });
    return {
      ok: false,
      code: 'execution_failed',
      error: `Failed to place call to ${toNumber}: ${message}`,
      cause: err,
    };
  }
}

/** Seed for the outbound `botKey` when the trunk presents its default
 *  caller-ID and we therefore have no number of our own to derive from. */
const OUTBOUND_BOT_KEY_SEED = 'outbound';

/** `from_number` is NOT NULL in the log; this is what an unset
 *  `voice.trunk.fromNumber` renders as. */
const UNKNOWN_NUMBER = 'unknown';

/**
 * What the row says about an outbound call whose ending nobody watched.
 *
 * Written for the OWNER reading their call history, not for a developer reading
 * a log: it names who placed the call and why the record stops there, so a green
 * `completed` row is never read as "and it went well".
 */
const OUTBOUND_UNOBSERVED_REASON =
  'Placed by your agent — Ethos does not stay on the line for calls it makes, ' +
  'so whether this one was answered was not recorded.';

async function logStart(opts: VoiceToolsOptions, input: StartCallInput): Promise<void> {
  if (!opts.callLog) return;
  try {
    await opts.callLog.start(input);
  } catch (err) {
    opts.onError?.(`call log start failed for ${input.id}: ${String(err)}`);
  }
}

async function logUpdate(
  opts: VoiceToolsOptions,
  id: string,
  patch: UpdateCallInput,
): Promise<void> {
  if (!opts.callLog) return;
  try {
    await opts.callLog.update(id, patch);
  } catch (err) {
    opts.onError?.(`call log update failed for ${id}: ${String(err)}`);
  }
}

function defaultRoomName(toNumber: string, roomNameFor?: (n: string) => string): string {
  if (roomNameFor) return roomNameFor(toNumber);
  return `call-${toNumber.replace(/[^0-9]/g, '')}`;
}
