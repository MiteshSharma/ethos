// The always-available wake engine: it wakes on TEXT, after speech recognition,
// not on acoustics before it.
//
// WHY THIS IS THE FALLBACK AND NOT A STUB. Every acoustic keyword spotter worth
// running is a per-architecture native binary plus a model download, and the
// failure modes are the ones this whole lane exists to contain: a wheel built
// for the wrong arch, a model that never finished downloading, an "available"
// flag set from a config file rather than a probe. A satellite whose wake stack
// fails those checks still has to be usable, so the default engine is the one
// with nothing to load: normalize the transcript, match a route phrase against
// its head, wake.
//
// WHAT IT COSTS. Matching after STT means every utterance pays a full
// recognition pass before the wake decision — the machine is transcribing the
// room, not listening for one phrase in it. That is the right trade for
// push-to-talk hosts and for edge-STT satellites that are already running a
// local recognizer for the turn itself, and the wrong trade for an always-on
// room microphone, which should run `sherpa` (see `sherpa-wake-engine.ts`) and
// pay one small acoustic model instead.
//
// HOW A HOST WIRES IT. Not through `CaptureMachine` — that machine is the
// acoustic flow, where the engine sits in front of capture. Here the order is
// inverted: the host captures an utterance (push-to-talk, or continuous capture
// with its own VAD), runs STT, and calls `matchText()` on the result. `push()`
// is present because the seam requires it and always returns null, rather than
// pretending to spot keywords in PCM it never looks at.

import { DEFAULT_WAKE_SENSITIVITY, matchWakePhrase } from '@ethosagent/voice-text';
import type {
  WakeEngine,
  WakeEngineFactory,
  WakeEngineOptions,
  WakeEngineProbe,
  WakeFrame,
  WakeMatch,
  WakeRoute,
} from '../wake-engine';

// The matching itself — normalization, bounded edit distance, per-word
// tolerance, longest-phrase-wins — lives in `@ethosagent/voice-text`, because
// Settings → Voice's live phrase tester runs the same decision in the browser
// before a route is saved, and an app may not import an extension
// (ARCHITECTURE.md §III Law 5). Re-exported here so this module stays the
// satellite's single import site for it.
export { boundedLevenshtein, normalizeUtterance, wakePhraseKey } from '@ethosagent/voice-text';

class TranscriptWakeEngine implements WakeEngine {
  readonly name = 'transcript';

  private routes: WakeRoute[] = [];
  private sensitivity = DEFAULT_WAKE_SENSITIVITY;

  async init(routes: readonly WakeRoute[], opts: WakeEngineOptions): Promise<void> {
    // A defensive copy of every field the match decision reads. The routes
    // array belongs to the host, which holds it across route pushes; if the
    // host mutated it in place, a disabled route could become matchable between
    // pushes without this engine ever being told. Defence in depth, not
    // redundancy: the gateway is the party that decides which personalities are
    // wake-reachable, and this copy is what makes "the engine matched what it
    // was given at init" a statement with a fixed subject.
    this.routes = routes
      .filter((r) => r.enabled === true)
      .map((r) => ({
        id: r.id,
        phrase: r.phrase,
        personalityId: r.personalityId,
        // Never inferred, never defaulted to true. `privileged` is the
        // route-level opt-in that makes a privileged personality
        // wake-reachable at all; an engine that guessed it would be an
        // engine that granted access the operator never granted.
        privileged: r.privileged === true,
        enabled: true,
      }));
    this.sensitivity = Number.isFinite(opts.sensitivity)
      ? opts.sensitivity
      : DEFAULT_WAKE_SENSITIVITY;
    // `confirmationFrames` is an acoustic concept — N consecutive frames
    // agreeing before a spot counts. A transcript is decided once, so there is
    // nothing to confirm and the option is deliberately ignored here.
  }

  /**
   * Acoustic frames are not this engine's input. Returning null rather than
   * throwing keeps it drop-in behind the seam; a host that wires it into an
   * acoustic capture loop gets silence, which is the honest answer.
   */
  push(_frame: WakeFrame): WakeMatch | null {
    return null;
  }

  /** Match a route phrase against the head of a recognized utterance. */
  matchText(text: string): WakeMatch | null {
    // Re-checked at match time as well as at init: a route only ever reaches
    // this list enabled, and the second read costs nothing next to waking the
    // wrong personality.
    const match = matchWakePhrase(
      this.routes.filter((r) => r.enabled),
      text,
      this.sensitivity,
    );
    return match ? { routeId: match.id, phrase: match.phrase, confidence: match.confidence } : null;
  }

  /** No partial state to forget — the match is decided in one call. */
  reset(): void {}

  async dispose(): Promise<void> {
    this.routes = [];
  }
}

/** The concrete type, so hosts can reach `matchText` without a cast. */
export type { TranscriptWakeEngine };

export function createTranscriptWakeEngine(): TranscriptWakeEngine {
  return new TranscriptWakeEngine();
}

export const transcriptWakeEngineFactory: WakeEngineFactory = {
  name: 'transcript',
  /** Nothing to load, so nothing can be missing. The one honest always-ok probe. */
  async probe(): Promise<WakeEngineProbe> {
    return {
      ok: true,
      engine: 'transcript',
      detail: 'no native bindings and no model files — matches wake phrases against STT output',
    };
  },
  create: () => createTranscriptWakeEngine(),
};
