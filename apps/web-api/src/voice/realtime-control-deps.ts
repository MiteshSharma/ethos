import { voiceLaneKey } from '@ethosagent/core';
import { createRealtimeToolHost } from '@ethosagent/tools-voice';
import type { HookRegistry, SessionStore, ToolRegistry } from '@ethosagent/types';
import type { RealtimeControlLaneDeps, RealtimeSessionBinding } from './realtime-control-lane';

// Binds one browser talk session to its own lane — the "own lane per talk
// session" half of voice V1b (eng-review D6).
//
// WHY THE LANE KEY IS NOT THE CHAT SESSION KEY. A typed chat session is keyed
// `web:<uuid>`; this session is keyed `voice:<botKey>:browser:<client>`. They
// are deliberately different conversations even when the user is looking at
// one window, because a spoken turn and a typed turn on ONE history is exactly
// the interleaving behind OpenClaw #112253 — a consult mid-flight and a typed
// send racing to append to the same message list, each corrupting the other's
// idea of what the last turn was. Shared context across the two comes from
// memory scopes, which is a merge the agent performs deliberately, not one the
// session store performs by accident.
//
// WHY A PHONE SESSION CANNOT COLLIDE WITH THIS ONE. The `kind` segment. A phone
// leg is `voice:<botKey>:livekit:<callerId>` (`VoiceChannelAdapter.laneKey`,
// same encoder). The trailing ids are not what keeps them apart — on a
// single-operator deployment the operator's own number and their own browser
// session id are equally plausible strings, and one could in principle equal
// the other. The kind segment is a closed union written by the surface that
// owns the transport: a browser cannot emit `livekit`, a SIP bridge cannot emit
// `browser`, and every segment is URL-encoded so no id can smuggle a separator
// and alias itself onto the other's key. That is structural, not statistical.

/** What one realtime talk session costs and what caps it. See {@link RealtimeControlDepsOptions.pricing}. */
export interface RealtimeSessionPricing {
  /** `RealtimeProviderEntry.costPerMinuteUsd` for the entry serving this call. */
  costPerMinuteUsd?: number;
  /** `voice.realtime.sessionBudgetUsd`. */
  sessionBudgetUsd?: number;
}

/**
 * The budget authority. Structurally `AgentLoop` — that is deliberate: the
 * talk-session lane key is the same key `agent_consult` runs its turns on, so
 * the loop's `sessionCosts` map is where this call's whole bill already lives.
 */
export interface RealtimeBudgetAuthority {
  addSessionCost(sessionKey: string, usd: number): void;
  getSessionCost(sessionKey: string): number;
  /** The speaking personality's `budgetCapUsd`; undefined = no personality cap. */
  getPersonalityBudgetCap(personalityId?: string): number | undefined;
}

export interface RealtimeControlDepsOptions {
  /** The registry the agent runs on — advertised == handled derives from it. */
  toolRegistry: ToolRegistry;
  /** Fires `before_tool_call` (approval surface + spoken-confirmation gate). */
  hooks?: HookRegistry;
  sessions: SessionStore;
  /** Personality lookup; supplies the toolset that gates direct-call tools. */
  personalities: { get(id: string): { toolset?: string[] } | undefined };
  /**
   * The per-audio-minute rate and the session cap, resolved SERVER-side for the
   * personality about to talk.
   *
   * Server-side on purpose: a billing rate the page supplied would be a billing
   * rate the page could set to zero. Absent → nothing accrues and no cap bites,
   * which is what a deployment with no realtime pricing configured already has.
   */
  pricing?(personalityId?: string): Promise<RealtimeSessionPricing>;
  /** Where accrued audio cost goes, and where the cap is read from. */
  budget?: RealtimeBudgetAuthority;
  /** Defaults stamped on a freshly created talk session row. */
  defaults: { model: string; provider: string; workingDir?: string };
  /**
   * Bot this web surface answers as. Single value by design: web-api serves one
   * operator UI, so there is one bot identity here however many bots the
   * gateway runs. A deployment that wants per-bot browser lanes passes its own.
   */
  botKey?: string;
  platform?: string;
}

/**
 * Build the control-lane deps for ONE connection.
 *
 * `fallbackClientId` is the socket's own lane id, used when the browser opens
 * talk-mode before a chat session exists. Preferring the chat session id when
 * there is one is what makes a reconnect resume the same talk session instead
 * of forking a new one every time the WebSocket blips.
 */
export function createRealtimeControlDeps(
  opts: RealtimeControlDepsOptions,
  fallbackClientId: string,
): RealtimeControlLaneDeps {
  const botKey = opts.botKey ?? 'web';
  const platform = opts.platform ?? 'web';
  const budget = opts.budget;

  return {
    async open(info): Promise<RealtimeSessionBinding> {
      const laneKey = voiceLaneKey(botKey, {
        kind: 'browser',
        id: info.sessionId ?? fallbackClientId,
      });
      const existing = await opts.sessions.getSessionByKey(laneKey);
      const row =
        existing ??
        (await opts.sessions.createSession({
          key: laneKey,
          platform,
          model: opts.defaults.model,
          provider: opts.defaults.provider,
          ...(info.personalityId ? { personalityId: info.personalityId } : {}),
          ...(opts.defaults.workingDir ? { workingDir: opts.defaults.workingDir } : {}),
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0,
            apiCallCount: 0,
            compactionCount: 0,
          },
        }));
      const toolset = info.personalityId
        ? opts.personalities.get(info.personalityId)?.toolset
        : undefined;
      // A pricing lookup that fails leaves the call UNPRICED — it must not take
      // the agent down with it. The lane says so through its `unpriced` event
      // rather than reporting the session as free.
      const pricing: RealtimeSessionPricing =
        (await opts.pricing?.(info.personalityId).catch((): RealtimeSessionPricing => ({}))) ?? {};
      // TWO CAPS, ONE BUDGET. `voice.realtime.sessionBudgetUsd` caps a realtime
      // call; the personality's `budgetCapUsd` caps everything this personality
      // spends on a session key — and the consults this call makes run on THIS
      // lane key, so that cap is already live here whether or not the tier
      // knows about it. Left alone, the personality cap would bite first, on
      // the next consult, as a refused turn the caller hears as silence. So the
      // lane takes the LOWER of the two and winds down on it: the same money,
      // the same threshold, but spoken instead of silent.
      const caps = [
        pricing.sessionBudgetUsd,
        budget?.getPersonalityBudgetCap(info.personalityId),
      ].filter((cap): cap is number => typeof cap === 'number' && cap > 0);
      return {
        laneKey,
        storeSessionId: row.id,
        ...(pricing.costPerMinuteUsd !== undefined
          ? { costPerMinuteUsd: pricing.costPerMinuteUsd }
          : {}),
        ...(caps.length > 0 ? { sessionBudgetUsd: Math.min(...caps) } : {}),
        host: createRealtimeToolHost({
          registry: opts.toolRegistry,
          ...(opts.hooks ? { hooks: opts.hooks } : {}),
          ...(toolset ? { personalityToolset: toolset } : {}),
        }),
        workingDir: row.workingDir ?? opts.defaults.workingDir ?? process.cwd(),
        ...(info.personalityId ? { personalityId: info.personalityId } : {}),
      };
    },

    async persistTranscript(binding, role, text): Promise<void> {
      // The provider's SETTLED transcript, stored as if it had been typed.
      // Nothing else about the audio is kept — that is the anti-goal holding,
      // not an omission.
      await opts.sessions.appendMessage({
        sessionId: binding.storeSessionId,
        role,
        content: text,
      });
    },

    onUsage(binding, usage): void {
      // The two places token cost goes, so audio minutes land in both: the
      // loop's per-session spend (what `budgetCapUsd` and every budget halt
      // read) and the session row (what `/usage` and the Sessions tab read).
      budget?.addSessionCost(binding.laneKey, usage.estimatedCostUsd);
      void opts.sessions
        .updateUsage(binding.storeSessionId, { estimatedCostUsd: usage.estimatedCostUsd })
        .catch(() => {
          // A failed usage write must not end a live call. The authoritative
          // in-memory total the cap reads is unaffected.
        });
    },

    // Only when there IS an authority holding the session's whole bill. Absent,
    // the lane falls back to its own audio total rather than being told the
    // session has spent nothing.
    ...(budget ? { sessionSpendUsd: (binding) => budget.getSessionCost(binding.laneKey) } : {}),
  };
}
