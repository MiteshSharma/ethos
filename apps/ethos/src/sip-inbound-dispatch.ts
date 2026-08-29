import type { CallLog, CallStatus } from '@ethosagent/call-log';
import { deriveBotKey, voiceLaneKey } from '@ethosagent/core';
import {
  createPostCallSummary,
  decideInboundCall,
  type InboundSipCall,
  resolveVoiceBot,
  type VoiceArtifact,
  type VoiceBotIdentity,
  type VoiceChannelAdapter,
} from '@ethosagent/platform-voice';
import type { AgentEvent, PersonalityConfig, VoiceTurnOrigin } from '@ethosagent/types';
import { FAR_END_VOICE_ORIGIN, type VoiceInboundGates } from '@ethosagent/wiring';

// ---------------------------------------------------------------------------
// Inbound SIP dispatch (plan/phases/voice-v4-telephony.md E2/E4/E6)
//
// What happens between "a verified webhook arrived" and "somebody is talking to
// the agent": bot resolution, the hardening gate, the call-log row, adapter
// construction, and the post-call summary that rides the delivery ledger.
//
// Split out of `commands/gateway.ts` so it is drivable in a test with an
// `InMemoryCallLog` and a fake gateway — the gateway command is a 2700-line
// startup script, and a dispatch decision an operator's phone bill depends on
// should not be reachable only by booting the whole daemon.
//
// It imports NO gateway package. The one gateway capability it needs — a
// notification that rides the delivery ledger — arrives as the injected
// `notifyOwner`, exactly as `webhook-server.ts` takes its capturing adapter by
// injection (daemon-free doctrine).
// ---------------------------------------------------------------------------

/** Minimal slice of `AgentLoop` a call lane drives. */
export interface SipCallLoop {
  run(
    text: string,
    opts?: {
      sessionKey?: string;
      personalityId?: string;
      voiceOrigin?: VoiceTurnOrigin;
      abortSignal?: AbortSignal;
    },
  ): AsyncGenerator<AgentEvent>;
}

/** Minimal slice of `VoiceStack` inbound dispatch reads. */
export interface SipInboundVoiceStack {
  readonly bots: readonly VoiceBotIdentity[];
  readonly inbound: VoiceInboundGates;
  createSipAdapter?: (opts: {
    bot: VoiceBotIdentity;
    roomName: string;
    callerId: string;
    runner: { run(text: string, opts?: { abortSignal?: AbortSignal }): AsyncGenerator<AgentEvent> };
    personality?: PersonalityConfig;
    sendArtifact?: (artifact: VoiceArtifact) => void | Promise<void>;
    onEnded?: (adapter: VoiceChannelAdapter) => void | Promise<void>;
  }) => Promise<VoiceChannelAdapter>;
}

export interface SipInboundDispatchDeps {
  voiceStack: SipInboundVoiceStack;
  callLog: CallLog;
  /** The loop every call turn runs on. Personality + far-end origin are pinned per call. */
  loop: SipCallLoop;
  /** Personality id bound to a matched bot (`voice.bots[].bind.name`). */
  botPersonalityId: (bot: VoiceBotIdentity) => string | undefined;
  /** Personality config for an id, or undefined when the id is not on disk. */
  personality: (id: string) => PersonalityConfig | undefined;
  /**
   * Delivers a notice to `voice.inbound.owner` through `Gateway.notifyTracked`,
   * i.e. through the delivery ledger: a `pending` obligation is written before
   * the platform call and confirmed only on `ok: true`, so a summary the network
   * ate is redelivered by the boot sweep rather than silently lost (OpenClaw
   * #77957 — "owner never told about inbound calls"). Returns false when the
   * delivery could not be confirmed; that is a log line, never a throw.
   */
  notifyOwner: (text: string) => Promise<boolean>;
  /** Deduped artifact sink for in-call artifacts. */
  sendArtifact?: (artifact: VoiceArtifact) => void | Promise<void>;
  now?: () => number;
  onError?: (message: string) => void;
}

/**
 * What the dispatcher decided about one ring. Returned (rather than only
 * logged) so a test can assert the decision without reading it back out of the
 * call log, and so the gateway can print an honest startup-time line.
 */
export type SipDispatchOutcome =
  | { dispatched: false; status: 'screened' | 'refused'; reason: string }
  | {
      dispatched: true;
      callId: string;
      restricted: boolean;
      prewarm: boolean;
      personalityId: string | undefined;
      started: boolean;
      error?: string;
    };

/**
 * Pass a turn's events through untouched, reporting each `usage` event's cost.
 *
 * This is the ONLY cost signal a call produces in this process, and it is a
 * PARTIAL one: it is the LLM token spend of the turns the call drove, priced by
 * the provider's own estimate. It does NOT include STT, TTS, LiveKit media, or
 * PSTN minutes — on a voice call those are plausibly the larger half of the
 * bill, and none of them reports a price to anything here. So
 * `voice.inbound.dailyBudgetUsd` now trips on real spend, but it trips LATE
 * relative to the true cost of a day of calls. Under-counting is the safe
 * direction for a cap that refuses calls; inventing a per-minute rate to close
 * the gap would not be.
 *
 * Recorded per event rather than at hang-up, so an hour-long call counts against
 * today's budget while it is still running instead of only after it ends.
 * Non-finite and negative estimates are dropped: a provider that reports garbage
 * must not be able to unwind a budget.
 */
async function* meterSpend(
  events: AsyncGenerator<AgentEvent>,
  record: (usd: number) => void,
): AsyncGenerator<AgentEvent> {
  for await (const event of events) {
    if (event.type === 'usage' && Number.isFinite(event.estimatedCostUsd)) {
      if (event.estimatedCostUsd > 0) record(event.estimatedCostUsd);
    }
    yield event;
  }
}

/** A refusal the caller chose (who they are) vs. one our capacity forced. */
function statusForReason(reason: string): Extract<CallStatus, 'screened' | 'refused'> {
  return reason === 'not_allowlisted' ? 'screened' : 'refused';
}

function describeReason(reason: string): string {
  switch (reason) {
    case 'not_allowlisted':
      return 'the caller is not on the inbound allowlist and no receptionist personality is configured';
    case 'over_concurrency':
      return 'the concurrent-call cap was already reached';
    case 'rate_limited':
      return 'the caller exceeded the per-caller hourly limit';
    case 'over_budget':
      return 'the daily voice budget is spent';
    case 'no_bot_match':
      return 'no voice bot is bound to the dialled number';
    default:
      return reason;
  }
}

/**
 * Build the `onCall` handler `createSipWebhookServer` dispatches verified calls
 * to. The order below is the plan's, and each step is load-bearing:
 *
 * 1. **Bot resolution** — an unrouted number produces a `screened` row and an
 *    owner notice. A call nobody hears about is the failure this plan exists to
 *    fix, so "we could not route it" is still news.
 * 2. **The hardening gate** (`decideInboundCall`) — budget, rate limit,
 *    concurrency, allowlist. A refusal releases whatever it took, so a wall of
 *    refused calls leaves `concurrency.active()` at zero.
 * 3. **Personality selection** — `restricted` (not allowlisted) pins the
 *    receptionist, whose own `memoryScope` and `toolset` ARE the restriction.
 * 4. **The call-log row** — `ringing` at dispatch, `live` on answer,
 *    `completed`/`failed` at end, `endedAt` on every terminal transition.
 * 5. **The slot** — released in a `finally` when setup did not reach a live
 *    call, and by `onEnded` when it did.
 */
export function createSipInboundHandler(
  deps: SipInboundDispatchDeps,
): (call: InboundSipCall, raw: unknown) => Promise<SipDispatchOutcome> {
  const now = deps.now ?? Date.now;
  const gates = deps.voiceStack.inbound;
  const report = deps.onError ?? ((message: string) => console.warn(`[sip] ${message}`));

  const notify = async (text: string): Promise<void> => {
    try {
      const ok = await deps.notifyOwner(text);
      if (!ok) report(`owner notification not confirmed: ${text}`);
    } catch (err) {
      report(`owner notification failed: ${String(err)}`);
    }
  };

  const openRow = async (input: Parameters<CallLog['start']>[0]): Promise<void> => {
    try {
      await deps.callLog.start(input);
    } catch (err) {
      // A duplicate id is a provider RETRY of a call already on record; the row
      // that exists is the truthful one. Anything else is a storage problem that
      // must not drop the call.
      report(`call log start failed for ${input.id}: ${String(err)}`);
    }
  };

  const patchRow = async (id: string, patch: Parameters<CallLog['update']>[1]): Promise<void> => {
    try {
      await deps.callLog.update(id, patch);
    } catch (err) {
      report(`call log update failed for ${id}: ${String(err)}`);
    }
  };

  return async (call: InboundSipCall): Promise<SipDispatchOutcome> => {
    // The room name is the call id: `parseInboundSipCall` derives it
    // deterministically from both numbers when the provider supplies none, so a
    // retried webhook for the same call reuses the row (and the concurrency
    // slot) rather than opening a second one beside it.
    const callId = call.roomName;
    const startedAt = now();

    const bot = resolveVoiceBot(call.toNumber, deps.voiceStack.bots);
    if (!bot) {
      // No bot, so no botKey — key the row by the number that was DIALLED, which
      // is the only stable identity an unrouted call has.
      const botKey = deriveBotKey(call.toNumber);
      await openRow({
        id: callId,
        botKey,
        laneKey: voiceLaneKey(botKey, { kind: 'sip', id: call.fromNumber }),
        direction: 'inbound',
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        status: 'screened',
        startedAt,
        endedAt: startedAt,
        reason: 'no_bot_match',
      });
      await notify(
        `Missed call from ${call.fromNumber} to ${call.toNumber} — ${describeReason('no_bot_match')}.`,
      );
      return { dispatched: false, status: 'screened', reason: 'no_bot_match' };
    }

    const botKey = bot.id ?? deriveBotKey(bot.match);
    const laneKey = voiceLaneKey(botKey, { kind: 'sip', id: call.fromNumber });

    const decision = decideInboundCall({
      from: call.fromNumber,
      callId,
      concurrency: gates.concurrency,
      ...(gates.rateLimit ? { rateLimit: gates.rateLimit } : {}),
      budget: gates.budget,
      ...(gates.allowlist ? { allowlist: gates.allowlist } : {}),
      prewarm: gates.prewarm,
      receptionist: gates.receptionist !== undefined,
    });

    if (!decision.accept) {
      const status = statusForReason(decision.reason);
      await openRow({
        id: callId,
        botKey,
        laneKey,
        direction: 'inbound',
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        status,
        startedAt,
        endedAt: startedAt,
        reason: decision.reason,
      });
      await notify(
        `Call from ${call.fromNumber} to ${call.toNumber} was ${status} — ${describeReason(decision.reason)}.`,
      );
      return { dispatched: false, status, reason: decision.reason };
    }

    // Restricted = not allowlisted = the receptionist answers. Nothing else
    // changes: the receptionist's own `memoryScope` denies owner memory and its
    // own `toolset` denies privileged tools, both by construction in the turn
    // setup. There is no second restriction system to keep in step.
    const personalityId = decision.restricted ? gates.receptionist : deps.botPersonalityId(bot);
    const personality = personalityId ? deps.personality(personalityId) : undefined;

    await openRow({
      id: callId,
      botKey,
      laneKey,
      direction: 'inbound',
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      ...(personalityId ? { personalityId } : {}),
      status: 'ringing',
      startedAt,
    });

    // What this call has cost so far. See `meterSpend` for what the number is
    // and — just as importantly — what it is not.
    let spentUsd = 0;

    // Every turn on this lane carries `speaker: 'far_end'`. That single field is
    // what stops a stranger's confident "yes" from satisfying an owner-level
    // confirmation: the spoken-confirmation gate refuses a far-end request
    // BEFORE it consults any recorded confirmation (eng-review D13).
    const runner = {
      run: (text: string, opts?: { abortSignal?: AbortSignal }): AsyncGenerator<AgentEvent> =>
        meterSpend(
          deps.loop.run(text, {
            sessionKey: laneKey,
            ...(personalityId ? { personalityId } : {}),
            voiceOrigin: FAR_END_VOICE_ORIGIN,
            ...(opts?.abortSignal ? { abortSignal: opts.abortSignal } : {}),
          }),
          (usd) => {
            spentUsd += usd;
            // The SAME budget instance `decideInboundCall` consults above. A
            // fresh one here would leave `spent()` at zero forever, which is
            // exactly the state `voice.inbound.dailyBudgetUsd` was in before
            // this line existed.
            gates.budget.record(usd);
          },
        ),
    };

    // The summary is the ONLY durable record of a call the operator did not
    // hear, so it goes out through the ledger (`notifyOwner`) and onto the row
    // in the same handler — not through `adapter.sendArtifactMessage`, which
    // stops a double send but nothing stops a lost one.
    const summarize = createPostCallSummary({
      deliver: async ({ text }) => {
        await patchRow(callId, { summary: text });
        await notify(text);
      },
      onError: (err) => report(`post-call summary failed for ${callId}: ${String(err)}`),
    });

    const onEnded = async (adapter: VoiceChannelAdapter): Promise<void> => {
      gates.concurrency.release(callId);
      await patchRow(callId, {
        status: 'completed',
        endedAt: now(),
        transcript: adapter.lastReplyText(),
        ...(spentUsd > 0 ? { costUsd: spentUsd } : {}),
      });
      await summarize(adapter);
    };

    let started = false;
    try {
      const createSipAdapter = deps.voiceStack.createSipAdapter;
      if (!createSipAdapter) {
        throw new Error(
          'no SIP media binding — voice.livekit.* is unset or no LiveKit media client was supplied',
        );
      }
      const adapter = await createSipAdapter({
        bot,
        roomName: call.roomName,
        callerId: call.fromNumber,
        runner,
        ...(personality ? { personality } : {}),
        ...(deps.sendArtifact ? { sendArtifact: deps.sendArtifact } : {}),
        onEnded,
      });
      await adapter.start();
      started = true;
      await patchRow(callId, { status: 'live' });
      return {
        dispatched: true,
        callId,
        restricted: decision.restricted,
        prewarm: decision.prewarm,
        personalityId,
        started: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await patchRow(callId, {
        status: 'failed',
        endedAt: now(),
        reason: message,
        ...(spentUsd > 0 ? { costUsd: spentUsd } : {}),
      });
      await notify(
        `Call from ${call.fromNumber} to ${call.toNumber} could not be answered — ${message}.`,
      );
      return {
        dispatched: true,
        callId,
        restricted: decision.restricted,
        prewarm: decision.prewarm,
        personalityId,
        started: false,
        error: message,
      };
    } finally {
      // A call that never reached `live` must not keep its slot: `cap` failed
      // setups would otherwise wedge the line permanently. A call that DID reach
      // live keeps it until `onEnded` fires.
      if (!started) gates.concurrency.release(callId);
    }
  };
}
