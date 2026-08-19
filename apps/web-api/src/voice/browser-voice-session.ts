import type { VoiceBargeInTuning } from '@ethosagent/config';
import type { AgentLoop } from '@ethosagent/core';
import { voiceLaneKey } from '@ethosagent/core';
import type { PersonalityConfig } from '@ethosagent/types';
import type { AgentTurnRunner, VoiceSession } from '@ethosagent/voice-session';
import type { VoiceStack } from '@ethosagent/wiring';
import type { VoiceLaneSessionOpener } from './voice-lane';

// Opens the browser PIPELINE lane's `VoiceSession` — the pipeline-tier twin of
// `createRealtimeControlDeps.open()` for the realtime tier. Same reason for
// existing: a spoken turn must run on its OWN session, keyed
// `voice:<botKey>:browser:<client>`, never on the typed chat session's key
// (Conflict 1 — see `realtime-control-deps.ts` for the full argument, which
// applies here unchanged).
//
// Unlike the realtime tier, this lane drives its turns through
// `agentLoop.run()` (the same as the satellite lane's `runTurn`), so it never
// touches `SessionStore` directly: `AgentLoop`'s own turn-setup stage
// resolves-or-creates the session row for `sessionKey` on the first turn. The
// lane key alone is what keeps the row separate from chat.
//
// `buildVoiceStack().createSession()` (`@ethosagent/wiring`) is the one
// factory for `VoiceSession` — it resolves this lane's STT/TTS providers from
// the speaking personality's `voice.*` block and pins the fast-lane model.
// This module's job is everything upstream of that call: the lane key and an
// `AgentTurnRunner` closure bound to it.

export interface BrowserVoiceSessionDeps {
  /** Absent when `voice.*` is not configured — `open()` then resolves null,
   *  the same "clean no-op, not a crash" contract every other voice-adjacent
   *  seam in this deployment follows. */
  voiceStack: VoiceStack | undefined;
  /** The turn driver. `AgentLoop.run()` satisfies `AgentTurnRunner`
   *  structurally once bound to a lane key and a personality. */
  agentLoop: AgentLoop;
  personalities: { get(id: string): PersonalityConfig | undefined };
  /** Bot this web surface answers as. Same single-bot-per-process rule the
   *  realtime tier's `createRealtimeControlDeps` uses. */
  botKey?: string;
  /**
   * `display.voice_*` compatibility read-through for this lane's barge-in
   * tuning (Conflict 2, L1 — plan §7). Read live per connection, the same
   * reason the voice rosters in `VoiceService`'s `configGetter` are: an
   * operator who just changed Settings → Voice → Advanced means the next
   * call. Used ONLY when `voice.bargeIn.browser` is not configured —
   * `voiceStack.createSession` applies that precedence via
   * `bargeInFallback`. Absent → no fallback, same as before this option
   * existed.
   */
  legacyBargeInTuning?: () => Promise<VoiceBargeInTuning>;
}

/**
 * Build the opener for ONE connection. `fallbackClientId` is the socket's own
 * lane id, used when the browser opens talk-mode before a chat session
 * exists — mirrors `createRealtimeControlDeps`'s `fallbackClientId`, so a
 * reconnect resumes the same lane instead of forking a new one.
 */
export function createBrowserVoiceSessionOpener(
  deps: BrowserVoiceSessionDeps,
  fallbackClientId: string,
): VoiceLaneSessionOpener {
  const botKey = deps.botKey ?? 'web';

  return async (info): Promise<VoiceSession | null> => {
    const voiceStack = deps.voiceStack;
    if (!voiceStack) return null;

    const laneKey = voiceLaneKey(botKey, {
      kind: 'browser',
      id: info.sessionId ?? fallbackClientId,
    });
    const personality = info.personalityId ? deps.personalities.get(info.personalityId) : undefined;
    const runner: AgentTurnRunner = {
      run: (text, runOpts) =>
        deps.agentLoop.run(text, {
          sessionKey: laneKey,
          ...(info.personalityId ? { personalityId: info.personalityId } : {}),
          ...(runOpts?.abortSignal ? { abortSignal: runOpts.abortSignal } : {}),
          ...(runOpts?.modelOverride ? { modelOverride: runOpts.modelOverride } : {}),
          // Same stamp `chat.send({origin:'voice'})` and the realtime tier
          // use: the operator's own browser session, behind the same auth as
          // the rest of the surface.
          voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' },
        }),
    };

    // `surface: 'browser'` — since L1 (plan §7 "Conflict 2"), this lane tunes
    // through the same `voice.bargeIn.<surface>` mechanism `call`/`satellite`
    // use. `bargeInFallback` is the `display.voice_*` compatibility
    // read-through: it only takes effect when `voice.bargeIn.browser` is NOT
    // configured (`voiceStack.createSession` applies that precedence), so an
    // operator who never touched either keeps the session's built-in
    // VAD/endpoint defaults, unchanged from before this option existed.
    const bargeInFallback = deps.legacyBargeInTuning ? await deps.legacyBargeInTuning() : undefined;
    return voiceStack.createSession({
      laneKey,
      runner,
      surface: 'browser',
      ...(personality ? { personality } : {}),
      ...(bargeInFallback && Object.keys(bargeInFallback).length > 0 ? { bargeInFallback } : {}),
    });
  };
}
