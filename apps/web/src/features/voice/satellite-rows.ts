import type { rpc } from '../../rpc';

// SatelliteRow's state decision, separated from its markup.
//
// A microphone in a room that misreports whether it is listening is a privacy
// defect, so every field below traces to something the NODE reported — the
// state of its own capture loop, the probes `ethos listen doctor` ran, the
// wake it actually served. Nothing here infers liveness from "the socket is
// open".
//
// The dot is the app's EXISTING connection dot (`.sb-dot`, DESIGN.md §
// "Connection status indicator"), extended with the states a microphone has
// that a websocket does not. Same base class, same `status-dot-pulse`
// keyframe, same green/amber/red vocabulary — a second dot drawn from scratch
// would be a second thing to keep in sync.

type SatellitesData = Awaited<ReturnType<typeof rpc.voice.satellites.list>>;
export type SatelliteNode = SatellitesData['nodes'][number];
export type SatelliteState = SatelliteNode['state'];

export interface SatelliteRowView {
  state: SatelliteState;
  /** Modifier on the shared `.sb-dot` connection dot. */
  dotClass: string;
  /** The mono state word. The config vocabulary, not a prettified sentence. */
  label: string;
  /** Liveness bars beside the dot — only when the mic is actually armed. */
  bars: boolean;
  /** Whether the dot pulses. `prefers-reduced-motion` stops it in CSS. */
  pulse: boolean;
  /** Which probe failed, named. Null unless something did. */
  detail: string | null;
  /** What the failure MEANS, not just that it happened. */
  consequence: string | null;
}

/**
 * The one place a failing wake stack is translated into a consequence.
 *
 * "Doctor failed" is a fact about a probe; "no phrase wakes this node" is the
 * fact the person reading the row needs. The plan's failure-mode criteria are
 * explicit that a broken wake stack degrades the host to text and never takes
 * anything down with it, and a row that reports only the probe leaves the user
 * to guess whether the machine is still usable.
 */
const DEGRADED_CONSEQUENCE =
  'Degraded to text — no phrase wakes this node until the probe passes. Everything else still works, and turns typed elsewhere are unaffected.';

function failureReasons(node: SatelliteNode): string[] {
  const reasons: string[] = [];
  if (node.stateDetail) reasons.push(node.stateDetail);
  for (const probe of node.probes) {
    if (probe.ok) continue;
    const text = probe.detail ? `${probe.name} — ${probe.detail}` : `${probe.name} failed`;
    if (!reasons.includes(text)) reasons.push(text);
  }
  return reasons;
}

export function satelliteRowView(node: SatelliteNode): SatelliteRowView {
  const reasons = failureReasons(node);
  const detail = reasons.length > 0 ? reasons.join(' · ') : null;

  switch (node.state) {
    case 'listening':
      return {
        state: 'listening',
        dotClass: 'sb-dot--listening',
        label: 'listening',
        bars: true,
        pulse: false,
        detail,
        consequence: null,
      };
    case 'speaking':
      // The accent dot pulsing — the same "the agent has the floor" cue the
      // CallStrip uses, so one vocabulary covers both surfaces.
      return {
        state: 'speaking',
        dotClass: 'sb-dot--speaking',
        label: 'speaking',
        bars: false,
        pulse: true,
        detail,
        consequence: null,
      };
    case 'muted':
      return {
        state: 'muted',
        dotClass: 'sb-dot--muted',
        label: 'muted',
        bars: false,
        pulse: false,
        detail,
        consequence: null,
      };
    case 'wake_off':
      // Hollow, not grey: muted is momentary and wake-off survives a restart.
      // Two persisted-vs-transient states that looked alike would make the
      // indicator-honesty criterion unverifiable at a glance.
      return {
        state: 'wake_off',
        dotClass: 'sb-dot--wake-off',
        label: 'wake off',
        bars: false,
        pulse: false,
        detail,
        consequence: null,
      };
    default:
      return {
        state: 'degraded',
        dotClass: 'sb-dot--degraded',
        label: 'degraded',
        bars: false,
        pulse: false,
        detail: detail ?? 'the node reported a failing wake stack without naming a probe',
        consequence: DEGRADED_CONSEQUENCE,
      };
  }
}

/** Coarse age, same vocabulary as the delivery table: the question is "how
 *  long ago did this microphone last wake something", never "exactly when". */
export function wakeAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** `edge STT · 16000 Hz · playback` — what this node can do, in its own terms. */
export function satelliteCapabilityLabel(node: SatelliteNode): string {
  const parts = [node.capabilities.edgeStt ? 'edge STT' : 'gateway STT'];
  if (node.capabilities.captureSampleRate > 0) {
    parts.push(`${node.capabilities.captureSampleRate} Hz`);
  }
  if (node.capabilities.playback) parts.push('playback');
  return parts.join(' · ');
}
