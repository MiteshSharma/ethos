import { accentFor, DEFAULT_TOKENS } from '@ethosagent/design-tokens';
import type { VoiceCallStatus } from './voice-call-reducer';

// The Call Stage's motion rules, with no canvas and no React in sight.
//
// DESIGN.md § "Call Stage" adds one motion class to the system — continuous
// amplitude-driven motion — and fixes its constants in code rather than in
// config: the user picks a treatment and a color, nothing else. Everything that
// decides HOW the shape moves lives here, pure, so the rules that are hard to
// see in a draw call (which source drives which state, what reduced motion
// removes, where the smoothing happens) are unit tests rather than a reading of
// the render loop.

/**
 * The six tuning constants, fixed by the motion lab the user approved. NOT
 * configurable — the treatment (`voice.call_style` / `display.call_style`) and
 * the colour (`display.call_accent`) are the only choices (DESIGN.md § "Call
 * Stage").
 */
export const CALL_MOTION = {
  /** Amplitude low-pass. Applied exactly once per signal — see `callDrive`. */
  smoothing: 0.82,
  /** Multiplier on a raw 0..1 level before it reaches the shape. */
  gain: 1.0,
  /** How far the shape travels between rest and full amplitude. */
  travel: 0.55,
  /** Wave phase advance per frame, scaled by the current level. */
  waveSpeed: 1.0,
  /** Strength of the radial glow behind the shape. */
  glow: 0.45,
  /** Orbit rate of the thinking comet, in multiples of the base sweep. */
  thinkOrbit: 1.0,
} as const;

/**
 * The three treatments. Defined in contracts, not here: a personality declares
 * one (`voice.call_style`), an operator pins one (`display.call_style`), and
 * `resolveCallTreatment` picks between them for every surface — so the union
 * has to be readable from below the web app.
 */
export type { CallTreatment } from '@ethosagent/types';

/** What the stage draws. Three states, not nine — the strip owns the rest. */
export type CallVisualState = 'listening' | 'thinking' | 'speaking';

/**
 * DESIGN.md `--error`. Listening reuses the live-mic vocabulary, so the user
 * speaking is red on every surface and never a personality accent.
 */
export const LISTENING_COLOR = '#F87171';

/** Thinking contracts the shape, so "busy" reads without the caption. */
export const THINKING_RADIUS_SCALE = 0.84;

/**
 * The level the shape holds while motion is reduced.
 *
 * Not zero: an empty vessel reads as "off", and the state still has to be
 * legible. Not amplitude-tracked either — a fill that jumps with every syllable
 * is motion no matter which API draws it, and this codebase already settled that
 * argument once, in `mic-meter.ts`.
 */
export const REDUCED_MOTION_LEVEL = 0.35;

/**
 * Which of the three drawn states a call status is, or null when the status has
 * no shape of its own.
 *
 * Null is NOT "leave the Call Stage". Connecting / reconnecting / ended have no
 * amplitude to draw, but two of them happen DURING a live call, and a stage that
 * unmounts for them restarts its enter animation and its canvas — which is the
 * whole mode flickering out and back as far as the user is concerned. Mounting is
 * `callStageMounted`; what a mounted stage draws is `callStageVisual`.
 */
export function callVisualState(status: VoiceCallStatus): CallVisualState | null {
  switch (status) {
    case 'listening':
      return 'listening';
    case 'thinking':
    case 'consulting':
      return 'thinking';
    case 'agent_speaking':
    case 'interrupted':
      return 'speaking';
    default:
      return null;
  }
}

/**
 * What a mounted stage draws for a status that has no shape of its own.
 *
 * A live call that is connecting or reconnecting is BUSY, so it borrows the
 * thinking shape: amplitude-independent (nobody is talking), accent rather than
 * the live-mic red (the mic is not live), and the mono state word underneath
 * still reads `connecting` / `reconnecting…`, so the exact state is never in
 * doubt. Holding the PREVIOUS shape instead would leave a red "your microphone
 * is live" circle up through a reconnect, which is a lie the caption cannot undo.
 */
export function callStageVisual(status: VoiceCallStatus): CallVisualState {
  return callVisualState(status) ?? 'thinking';
}

/** Everything that decides whether Chat is in Call Stage mode. */
export interface CallStageMount {
  status: VoiceCallStatus;
  /** Voice fell back to text. Only the strip can explain that. */
  degraded: boolean;
  /** The browser refused the mic. Same — the strip owns the guidance. */
  micDenied: boolean;
  /** The user went back to chat. Never ends the call. */
  minimized: boolean;
}

/**
 * Is Chat in Call Stage mode?
 *
 * Deliberately NOT a function of the drawn state. Once the stage is up it stays
 * up for the whole call and every state change renders inside it; deriving the
 * mount from the state instead is what made a mid-call reconnect look like the
 * mode closing and reopening. It comes down for three reasons only: the user
 * went back to chat, the call is over, or the call failed in a way that has
 * something to say (degraded to text, mic denied) and the strip is where that
 * gets said.
 */
export function callStageMounted(input: CallStageMount): boolean {
  if (input.status === 'idle' || input.status === 'ended') return false;
  if (input.degraded || input.micDenied) return false;
  return !input.minimized;
}

/**
 * Resolve `display.call_accent` to a hex.
 *
 * `personality` (the default, and the fallback for anything unrecognized) means
 * the active personality's accent — the identity affordance is the whole point
 * of a per-personality circle over a generic orb.
 */
export function resolveCallAccent(
  preference: string | null | undefined,
  personalityId: string,
): string {
  if (preference && /^#[0-9a-fA-F]{6}$/.test(preference)) return preference;
  return accentFor(DEFAULT_TOKENS, personalityId);
}

/** Listening is the red mic vocabulary; the agent's two states are accent. */
export function callStateColor(state: CallVisualState, accent: string): string {
  return state === 'listening' ? LISTENING_COLOR : accent;
}

/** One low-pass step. `smoothing` of 0 passes the raw value straight through. */
export function smoothLevel(previous: number, raw: number, smoothing: number): number {
  return previous * smoothing + raw * (1 - smoothing);
}

/** The thinking breath: a slow 0.5Hz swell, so the shape is alive at rest. */
export function thinkingBreath(tSec: number): number {
  return 0.2 + 0.11 * Math.sin(tSec * Math.PI * 2 * 0.5 * CALL_MOTION.thinkOrbit);
}

/**
 * What drives the shape this frame, and whether it still needs smoothing.
 *
 * The `smooth` flag exists because there is exactly ONE smoothing rule in the
 * system and it must be applied exactly once. The agent's level arrives already
 * smoothed from the playout analyser (`AbsolutePlayout.outputLevel`), and the
 * thinking breath is a sine that was never noisy; running either through the
 * filter a second time doubles the time constant and turns speech onset to mush.
 */
export function callDrive(opts: {
  state: CallVisualState;
  /** Newest mic meter reading, 0..1. Instantaneous — needs smoothing. */
  micLevel: number;
  /** Newest agent output level, 0..1. Pre-smoothed by the playout. */
  agentLevel: number;
  tSec: number;
  reduced: boolean;
}): { raw: number; smooth: boolean } {
  if (opts.reduced) return { raw: REDUCED_MOTION_LEVEL, smooth: false };
  if (opts.state === 'thinking') return { raw: thinkingBreath(opts.tSec), smooth: false };
  const source = opts.state === 'listening' ? opts.micLevel : opts.agentLevel;
  const raw = Math.min(1, Math.max(0, source) * CALL_MOTION.gain);
  return { raw, smooth: opts.state === 'listening' };
}

/** Surface wave height for the liquid treatment. Reduced motion flattens it. */
export function waveHeight(radius: number, level: number, reduced: boolean): number {
  return reduced ? 0 : radius * 0.055 * (0.35 + level);
}

/** Alpha of the radial glow behind the shape. Reduced motion removes it. */
export function glowAlpha(level: number, reduced: boolean): number {
  return reduced ? 0 : 0.3 * CALL_MOTION.glow * (0.35 + level);
}

/** `rgba()` from a `#RRGGBB` hex — canvas gradients need the alpha inline. */
export function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
