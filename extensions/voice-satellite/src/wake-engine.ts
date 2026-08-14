// The wake seam: what a wake-phrase matcher must be, independent of HOW it
// matches.
//
// Two implementations ship here and they work at opposite ends of the pipeline
// — `transcript` matches text AFTER speech recognition, `sherpa` spots keywords
// in the acoustic stream BEFORE it. They are behind one interface because the
// capture loop must not know the difference: the loop's job is to survive a
// thousand turns, and re-verifying that against every engine is how a capture
// loop ends up with two subtly different bug sets.
//
// NOTHING IN THIS FILE IMPORTS AN AUDIO OR NATIVE BINDING, and neither does
// anything the barrel re-exports at module scope. A native engine loads its
// bindings inside `probe()`/`init()` with a dynamic `import()`, so importing
// this package on a headless box with no audio stack is safe — which is the
// architectural claim the gateway depends on ("the gateway never opens an audio
// device and remains headless-safe").

/** One frame of captured audio handed to the matcher. */
export interface WakeFrame {
  samples: Int16Array;
  sampleRate: number;
}

export interface WakeMatch {
  routeId: string;
  phrase: string;
  /** 0..1. The engine's own confidence, not a normalized score across engines. */
  confidence: number;
}

/** A wake-phrase matcher. Engines are swappable; the capture loop is not. */
export interface WakeEngine {
  readonly name: string;
  /** Load models / native bindings. Throws with a diagnosable message on failure. */
  init(routes: readonly WakeRoute[], opts: WakeEngineOptions): Promise<void>;
  /** Feed one frame. Returns a match when the phrase fired, else null. */
  push(frame: WakeFrame): WakeMatch | null;
  /** Forget partial state — called after every wake and on un-mute. */
  reset(): void;
  dispose(): Promise<void>;
}

export interface WakeRoute {
  id: string;
  phrase: string;
  personalityId: string;
  privileged: boolean;
  enabled: boolean;
}

export interface WakeEngineOptions {
  sensitivity: number;
  confirmationFrames: number;
}

/** Why an engine is unavailable, for `listen doctor`. */
export interface WakeEngineProbe {
  ok: boolean;
  engine: string;
  detail: string;
}

export interface WakeEngineFactory {
  readonly name: string;
  /** Real probe — never "available" on a guess. Loads what it would load. */
  probe(): Promise<WakeEngineProbe>;
  create(): WakeEngine;
}
