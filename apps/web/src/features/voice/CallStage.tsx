import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { ClarifyCard } from '../../components/chat/ClarifyCard';
import { watchReducedMotion } from '../../lib/reduced-motion';
import {
  CALL_MOTION,
  type CallTreatment,
  type CallVisualState,
  callDrive,
  callStateColor,
  glowAlpha,
  rgba,
  smoothLevel,
  THINKING_RADIUS_SCALE,
  waveHeight,
} from './call-motion';
import { MicIcon, MicOffIcon, PhoneDownIcon } from './TalkMode';
import { markInterrupted, type VoiceTranscriptLine } from './voice-call-reducer';

// The Call Stage (DESIGN.md § "Call Stage").
//
// A MODE, not a dialog: while a call carries audio the Chat page IS this — the
// shape and its controls, and this call's transcript on the right. TWO columns,
// not three: there is deliberately no navigation rail on the left. A rail during
// a call is an invitation to wander off mid-sentence, and the point of the mode
// is that the call has the user's attention. The right column is the one thing
// worth looking away to — what is happening in THIS call.
//
// The single way back to the composer without hanging up is the "Back to chat"
// control in the transcript header. It is the same collapse the spine used to
// be (`onExpandChat` → `stageOpen: false`), so the CallStrip still takes over
// and its restore control still brings the stage back — DESIGN.md's Reconnecting
// row promises text stays reachable, and this is what keeps that promise.
//
// The reserved clarify slot at the base of the transcript column is the reason
// this direction was chosen over a centered dialog: a question the agent asks
// mid-call FILLS a panel the user is already looking at instead of appearing
// over the conversation. Nothing arrives, nothing leaves, nothing moves.
//
// The canvas is a port of the approved motion lab. Everything about HOW it
// moves lives in `call-motion.ts`, pure and tested; this file is the graph work
// only a canvas can do — including the loop that owns `prefers-reduced-motion`,
// because JS-driven drawing is invisible to the stylesheet's `animation: none`
// (the rule `mic-meter.ts` had to learn first).

export interface CallStageProps {
  state: CallVisualState;
  treatment: CallTreatment;
  /** Already-resolved hex — `personality` is resolved by the caller. */
  accent: string;
  /** The personality whose initial the shape carries. */
  personalityId: string;
  personalityName: string;
  /** Rolling mic meter, newest last. Only the newest value is drawn. */
  micLevels: number[];
  /** The agent's own output level, read once per frame. */
  agentLevel: () => number;
  /** Mono state word, in the strip's vocabulary. */
  statusLabel: string;
  /** Geist Mono `{provider} · {model}` — the strip's and TopBar's label. */
  providerLabel: string;
  /** Newest turn's total latency, in ms. Null until a turn has completed. */
  latencyMs: number | null;
  /** This call's turns, newest last. Not chat history. */
  transcript: VoiceTranscriptLine[];
  /** The pending clarify, rendered in the reserved slot. Null leaves it dimmed. */
  clarify: ClarifyRequestEvent | null;
  muted: boolean;
  onToggleMute: () => void;
  /** Collapse the stage — back to normal chat. Does NOT end the call. */
  onExpandChat: () => void;
  onHangUp: () => void;
}

/** How the canvas describes itself to a screen reader. */
export function stateDescription(state: CallVisualState, personalityName: string): string {
  if (state === 'listening') return 'Listening — your microphone is live';
  if (state === 'thinking') return `${personalityName} is thinking`;
  return `${personalityName} is speaking`;
}

/** One row of the transcript column. */
export interface CallStageTurn {
  id: string;
  label: string;
  text: string;
  role: 'user' | 'agent';
  /** The agent line still accumulating — the label says so, in accent. */
  live: boolean;
  /** Spoken filler ("One moment."), not reply content. Dimmed. */
  filler: boolean;
}

/**
 * The transcript column's rows, derived from the CALL's transcript.
 *
 * The source is the same `VoiceTranscriptLine[]` the reducer already maintains
 * and the strip already captions from — there is no second record, and no chat
 * history here: this column is what was said on THIS call, which is the only
 * thing that vanishes when the call ends.
 */
export function callStageTurns(
  transcript: VoiceTranscriptLine[],
  personalityName: string,
): CallStageTurn[] {
  return transcript.map((line) => ({
    id: line.id,
    role: line.role,
    label:
      line.role === 'user' ? 'You' : line.open ? `${personalityName} · speaking` : personalityName,
    // The same `[interrupted]` marker the chat projection appends, from the
    // same helper — a barge-in reads identically in both records.
    text: line.interrupted ? markInterrupted(line.text) : line.text,
    live: line.role === 'agent' && Boolean(line.open),
    filler: Boolean(line.filler),
  }));
}

export function CallStage({
  state,
  treatment,
  accent,
  personalityId,
  personalityName,
  micLevels,
  agentLevel,
  statusLabel,
  providerLabel,
  latencyMs,
  transcript,
  clarify,
  muted,
  onToggleMute,
  onExpandChat,
  onHangUp,
}: CallStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Newest mic reading. A ref, so a 60Hz meter never restarts the loop. */
  const micLevelRef = useRef(0);
  /**
   * Smoothed level, wave phase and orbit angle. Refs rather than locals in the
   * effect so a state or treatment change continues the motion instead of
   * snapping the shape back to zero.
   */
  const levelRef = useRef(0);
  const phaseRef = useRef(0);
  const orbitRef = useRef(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => watchReducedMotion(setReduced), []);

  useEffect(() => {
    micLevelRef.current = micLevels[micLevels.length - 1] ?? 0;
  }, [micLevels]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const resize = (): void => {
      // Cap the device ratio at 2: beyond that the extra pixels cost real
      // frames and buy nothing on a shape this size.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const letter = (personalityId[0] ?? '?').toUpperCase();
    const color = callStateColor(state, accent);

    const draw = (tSec: number): void => {
      const drive = callDrive({
        state,
        micLevel: micLevelRef.current,
        agentLevel: agentLevel(),
        tSec,
        reduced,
      });
      levelRef.current = drive.smooth
        ? smoothLevel(levelRef.current, drive.raw, CALL_MOTION.smoothing)
        : drive.raw;
      const level = levelRef.current;

      if (!reduced) {
        phaseRef.current += 0.016 * CALL_MOTION.waveSpeed * (0.6 + level);
        orbitRef.current += 0.03 * CALL_MOTION.thinkOrbit;
      }

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      // Thinking contracts the shape and hands the motion to the orbit, so
      // "busy" reads from across the room without reading the caption.
      const radius =
        Math.min(width, height) * 0.3 * (state === 'thinking' ? THINKING_RADIUS_SCALE : 1);
      const shape = { cx, cy, radius, level, color, letter, reduced, phase: phaseRef.current };

      const glow = glowAlpha(level, reduced);
      if (glow > 0) {
        const gradient = ctx.createRadialGradient(cx, cy, radius * 0.5, cx, cy, radius * 2.1);
        gradient.addColorStop(0, rgba(color, glow));
        gradient.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
      }

      if (treatment === 'liquid') drawLiquid(ctx, shape);
      else if (treatment === 'orb') drawOrb(ctx, shape);
      else drawRings(ctx, shape);

      if (state === 'thinking') {
        drawThinkingOrbit(ctx, cx, cy, radius, color, reduced, orbitRef.current);
      }
    };

    resize();
    window.addEventListener('resize', resize);

    // Reduced motion: one frame, then nothing. Not a slower loop — a loop that
    // keeps redrawing an amplitude is still motion, whichever API draws it.
    if (reduced) {
      draw(0);
      return () => window.removeEventListener('resize', resize);
    }

    let handle = 0;
    const start = performance.now();
    const loop = (now: number): void => {
      draw((now - start) / 1000);
      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(handle);
      window.removeEventListener('resize', resize);
    };
  }, [state, treatment, accent, personalityId, agentLevel, reduced]);

  const turns = callStageTurns(transcript, personalityName);
  const footer = [providerLabel, latencyMs === null ? '' : `${latencyMs}ms`]
    .filter(Boolean)
    .join(' · ');

  return (
    <section
      className="call-stage"
      aria-label={`Call with ${personalityName}`}
      // The stage carries the call's accent itself. The PersonalityBar — the
      // other place identity showed — is deliberately not on screen in this
      // mode, so the stage's own `var(--accent, …)` rules (the live turn label,
      // the focus ring) resolve to the personality holding the floor rather
      // than to the generic info blue.
      style={{ '--accent': accent } as CSSProperties}
    >
      <div className="call-stage-main">
        <canvas
          ref={canvasRef}
          className="call-stage-canvas"
          role="img"
          aria-label={stateDescription(state, personalityName)}
        />
        <div className="call-stage-who">{personalityName}</div>
        <div className="talk-mono call-stage-state" role="status">
          {statusLabel}
        </div>
        <div className="call-stage-actions">
          <button
            type="button"
            className={`talk-btn${muted ? ' talk-btn-active' : ''}`}
            onClick={onToggleMute}
            aria-pressed={muted}
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {muted ? <MicOffIcon /> : <MicIcon />}
          </button>
          <button
            type="button"
            className="talk-btn talk-hangup-btn"
            onClick={onHangUp}
            aria-label="End call"
          >
            <PhoneDownIcon />
          </button>
        </div>
        {footer ? <div className="talk-mono call-stage-foot">{footer}</div> : null}
      </div>

      <div className="call-stage-transcript">
        <div className="call-stage-transcript-head">
          <span className="talk-mono">This call</span>
          {/* The ONE control that leaves the mode without ending the call. Not
              a rail, not a nav — a single text button, in the column the user
              is already glancing at. Same handler the spine had, so collapse
              and the strip's restore stay the same round trip. */}
          <button
            type="button"
            className="call-stage-back"
            onClick={onExpandChat}
            aria-label="Back to chat — the call keeps running"
          >
            Back to chat
          </button>
        </div>
        <div className="call-stage-turns">
          {turns.map((turn) => (
            <div
              key={turn.id}
              className={`call-stage-turn call-stage-turn-${turn.role}${turn.live ? ' call-stage-turn-live' : ''}${turn.filler ? ' call-stage-turn-filler' : ''}`}
            >
              <span className="talk-mono call-stage-turn-label">{turn.label}</span>
              <span className="call-stage-turn-text">{turn.text}</span>
            </div>
          ))}
        </div>
        {/* The reserved slot. ALWAYS rendered — dimmed when there is nothing to
            answer — so a mid-call question fills a panel that is already on
            screen instead of arriving on top of the conversation. */}
        <div className={`call-stage-slot${clarify ? '' : ' call-stage-slot-empty'}`}>
          {clarify ? (
            <ClarifyCard key={clarify.requestId} request={clarify} variant="slot" />
          ) : (
            <>
              <span className="talk-mono">Asked aloud</span>
              <span className="call-stage-slot-empty-text">No open question</span>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Everything a treatment needs for one frame. */
interface ShapeFrame {
  cx: number;
  cy: number;
  radius: number;
  level: number;
  color: string;
  letter: string;
  reduced: boolean;
  /** Wave phase, advanced by the loop. Zero contribution when reduced. */
  phase: number;
}

/** The personality's initial, centered in the shape — the identity affordance. */
function drawMark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  letter: string,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 ${Math.round(radius * 0.52)}px 'Geist', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, cx, cy + radius * 0.02);
  ctx.restore();
}

/**
 * Liquid: the vessel fills with level, and the surface is two summed sines so
 * it reads as liquid rather than as a progress bar.
 */
function drawLiquid(ctx: CanvasRenderingContext2D, s: ShapeFrame): void {
  const { cx, cy, radius, level, color, reduced, phase } = s;
  const fill = 0.18 + CALL_MOTION.travel * 0.72 * level;
  const surfaceY = cy + radius - 2 * radius * fill;
  const wave = waveHeight(radius, level, reduced);

  const surfaceAt = (x: number): number =>
    surfaceY +
    Math.sin((x / radius) * 3.1 + phase * 1.7) * wave +
    Math.sin((x / radius) * 5.9 - phase * 2.6) * wave * 0.45;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  // The vessel behind the fill, so an empty circle still reads as a container.
  ctx.fillStyle = rgba(color, 0.07);
  ctx.fillRect(cx - radius, cy - radius, 2 * radius, 2 * radius);

  ctx.beginPath();
  ctx.moveTo(cx - radius, cy + radius);
  ctx.lineTo(cx - radius, surfaceY);
  for (let x = -radius; x <= radius; x += 3) ctx.lineTo(cx + x, surfaceAt(x));
  ctx.lineTo(cx + radius, cy + radius);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, surfaceY - radius * 0.3, 0, cy + radius);
  gradient.addColorStop(0, rgba(color, 0.95));
  gradient.addColorStop(1, rgba(color, 0.55));
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.strokeStyle = rgba(color, 0.9);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = -radius; x <= radius; x += 3) {
    if (x === -radius) ctx.moveTo(cx + x, surfaceAt(x));
    else ctx.lineTo(cx + x, surfaceAt(x));
  }
  ctx.stroke();
  ctx.restore();

  drawMark(ctx, cx, cy, radius, s.letter, 0.92);

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(color, 0.55);
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** Orb: a radial body whose rim deforms with amplitude. */
function drawOrb(ctx: CanvasRenderingContext2D, s: ShapeFrame): void {
  const { cx, cy, radius, level, color, reduced, phase } = s;
  const points = 96;
  const wobble = reduced ? 0 : (0.06 + CALL_MOTION.travel * 0.3) * level;

  ctx.beginPath();
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const r =
      radius *
      (0.72 + 0.16 * level * CALL_MOTION.travel) *
      (1 +
        wobble * Math.sin(angle * 3 + phase * 1.5) +
        wobble * 0.6 * Math.sin(angle * 5 - phase * 2.1) +
        wobble * 0.35 * Math.sin(angle * 8 + phase * 0.9));
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();

  const gradient = ctx.createRadialGradient(cx, cy - radius * 0.2, radius * 0.1, cx, cy, radius);
  gradient.addColorStop(0, rgba(color, 0.95));
  gradient.addColorStop(1, rgba(color, 0.42));
  ctx.fillStyle = gradient;
  ctx.fill();

  drawMark(ctx, cx, cy, radius, s.letter, 0.9);
}

/** Rings: three concentric rings breathing outward from a solid core. */
function drawRings(ctx: CanvasRenderingContext2D, s: ShapeFrame): void {
  const { cx, cy, radius, level, color, reduced } = s;
  const rings = 3;
  for (let i = rings; i >= 1; i--) {
    const spread = reduced ? 0.5 : i / rings;
    const r = radius * (0.42 + spread * 0.5 * (0.35 + level * CALL_MOTION.travel));
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(color, 0.5 * (1 - (i - 1) / rings) + 0.12);
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, radius * (0.36 + 0.07 * level), 0, Math.PI * 2);
  ctx.fillStyle = rgba(color, 0.92);
  ctx.fill();
  drawMark(ctx, cx, cy, radius * 0.62, s.letter, 0.95);
}

/**
 * Thinking is NOT amplitude-driven — nobody is talking. It gets its own motion:
 * a comet arc orbiting the contracted circle, so the state says busy rather than
 * idle. Under reduced motion the comet collapses to a static ring — the state
 * stays marked, nothing moves.
 */
function drawThinkingOrbit(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  reduced: boolean,
  head: number,
): void {
  const r = radius * 1.2;
  if (reduced) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(color, 0.3);
    ctx.lineWidth = 2;
    ctx.stroke();
    return;
  }
  const segments = 46;
  const span = Math.PI * 1.1;
  ctx.lineCap = 'round';
  for (let i = 0; i < segments; i++) {
    const f = i / segments;
    const from = head - f * span;
    const to = from - (span / segments) * 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, to, from);
    ctx.strokeStyle = rgba(color, 0.8 * (1 - f) ** 1.7);
    ctx.lineWidth = 2.6;
    ctx.stroke();
  }
}
