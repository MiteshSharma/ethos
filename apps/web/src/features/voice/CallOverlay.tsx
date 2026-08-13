import { useEffect, useRef, useState } from 'react';
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

// The in-call overlay (DESIGN.md § "Call overlay").
//
// A NON-BLOCKING centered dialog over Chat: no backdrop, no focus trap, no
// scroll lock. The layer underneath is `pointer-events: none` so the message
// list and the composer stay live behind it — which is not a nicety, it is what
// makes minimizing safe to offer without ending the call, and what keeps the
// Reconnecting promise ("the composer stays usable for text") true while the
// overlay is up. `Esc` is not handled here on purpose: it belongs to the call,
// and Chat's push-to-talk handler still ends the call with it.
//
// The canvas is a port of the approved motion lab. Everything about HOW it
// moves lives in `call-motion.ts`, pure and tested; this file is the graph work
// only a canvas can do — including the loop that owns `prefers-reduced-motion`,
// because JS-driven drawing is invisible to the stylesheet's `animation: none`
// (the rule `mic-meter.ts` had to learn first).

export interface CallOverlayProps {
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
  muted: boolean;
  onToggleMute: () => void;
  /** Collapse to the CallStrip. Does NOT end the call. */
  onMinimize: () => void;
  onHangUp: () => void;
}

/** How the canvas describes itself to a screen reader. */
export function stateDescription(state: CallVisualState, personalityName: string): string {
  if (state === 'listening') return 'Listening — your microphone is live';
  if (state === 'thinking') return `${personalityName} is thinking`;
  return `${personalityName} is speaking`;
}

export function CallOverlay({
  state,
  treatment,
  accent,
  personalityId,
  personalityName,
  micLevels,
  agentLevel,
  statusLabel,
  providerLabel,
  muted,
  onToggleMute,
  onMinimize,
  onHangUp,
}: CallOverlayProps) {
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

  return (
    <div className="call-overlay-layer">
      <section className="call-overlay" role="dialog" aria-label={`Call with ${personalityName}`}>
        <canvas
          ref={canvasRef}
          className="call-overlay-canvas"
          role="img"
          aria-label={stateDescription(state, personalityName)}
        />
        <div className="call-overlay-foot">
          <span className="talk-mono call-overlay-state" role="status">
            {statusLabel}
          </span>
          {providerLabel ? <span className="talk-mono">{providerLabel}</span> : null}
        </div>
        <div className="call-overlay-actions">
          <button
            type="button"
            className={`talk-btn${muted ? ' talk-btn-active' : ''}`}
            onClick={onToggleMute}
            aria-pressed={muted}
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {muted ? <MicOffIcon /> : <MicIcon />}
          </button>
          {/* Minimize, never "close": the call keeps running in the strip. */}
          <button
            type="button"
            className="talk-btn"
            onClick={onMinimize}
            aria-label="Minimize call to the strip"
          >
            <MinimizeIcon />
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
      </section>
    </div>
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

function MinimizeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 10h10" />
    </svg>
  );
}
