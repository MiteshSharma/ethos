import { describe, expect, it } from 'vitest';
import {
  CALL_MOTION,
  callDrive,
  callStageMounted,
  callStageVisual,
  callStateColor,
  callVisualState,
  glowAlpha,
  LISTENING_COLOR,
  REDUCED_MOTION_LEVEL,
  resolveCallAccent,
  rgba,
  smoothLevel,
  THINKING_RADIUS_SCALE,
  thinkingBreath,
  waveHeight,
} from '../call-motion';

// The Call Stage's rules, tested where they are decidable. The canvas itself
// is not in this suite (apps/web has no DOM), and does not need to be: every
// judgement the drawing makes — which source drives which state, how many times
// the signal is smoothed, what reduced motion removes, which color a state is —
// is a pure function here, and a draw call that ignored them would be visibly
// wrong long before a snapshot noticed.

describe('CALL_MOTION — the fixed constants', () => {
  it('pins the values the motion lab settled on', () => {
    // Approved in the prototype and deliberately NOT configurable: two config
    // keys exist (`display.call_style`, `display.call_accent`) and neither of
    // them is a number. A change here is a design decision, not a tweak.
    expect(CALL_MOTION).toEqual({
      smoothing: 0.82,
      gain: 1.0,
      travel: 0.55,
      waveSpeed: 1.0,
      glow: 0.45,
      thinkOrbit: 1.0,
    });
  });
});

describe('callVisualState', () => {
  it('maps the nine call statuses onto the three drawn states', () => {
    expect(callVisualState('listening')).toBe('listening');
    expect(callVisualState('thinking')).toBe('thinking');
    expect(callVisualState('consulting')).toBe('thinking');
    expect(callVisualState('agent_speaking')).toBe('speaking');
    expect(callVisualState('interrupted')).toBe('speaking');
  });

  it('has no shape for the statuses that carry no audio', () => {
    for (const status of ['idle', 'connecting', 'reconnecting', 'ended'] as const) {
      expect(callVisualState(status)).toBeNull();
    }
  });
});

describe('callStageVisual', () => {
  it('draws the busy shape for a transient status instead of nothing', () => {
    // The stage stays up through a reconnect, so `connecting` and
    // `reconnecting` need a shape. Thinking is the honest one: nobody is
    // talking, so it is amplitude-independent, and it is accent rather than
    // the live-mic red.
    expect(callStageVisual('connecting')).toBe('thinking');
    expect(callStageVisual('reconnecting')).toBe('thinking');
    // NOT the previous shape: a red "your microphone is live" circle held
    // through a reconnect is a lie the mono caption underneath cannot undo.
    expect(callStageVisual('reconnecting')).not.toBe('listening');
  });

  it('leaves every drawn status exactly where callVisualState put it', () => {
    for (const status of [
      'listening',
      'thinking',
      'consulting',
      'agent_speaking',
      'interrupted',
    ] as const) {
      expect(callStageVisual(status)).toBe(callVisualState(status));
    }
  });
});

describe('callStageMounted', () => {
  const live = {
    status: 'listening',
    degraded: false,
    micDenied: false,
    minimized: false,
  } as const;

  it('stays mounted across a transient status while the call is live', () => {
    // THE bug this predicate exists for: the call surface used to be derived
    // from the drawn state, so a mid-call reconnect unmounted it and the remount
    // replayed the 240ms enter animation and restarted the canvas — the user
    // saw the whole mode flicker out and back between turns.
    for (const status of [
      'connecting',
      'listening',
      'thinking',
      'consulting',
      'agent_speaking',
      'interrupted',
      'reconnecting',
      'listening',
    ] as const) {
      expect(callStageMounted({ ...live, status })).toBe(true);
    }
  });

  it('hands over to the strip when voice degraded to text', () => {
    expect(callStageMounted({ ...live, degraded: true })).toBe(false);
  });

  it('hands over to the strip when the mic was denied', () => {
    expect(callStageMounted({ ...live, micDenied: true })).toBe(false);
  });

  it('comes down when the call is over — or never started', () => {
    expect(callStageMounted({ ...live, status: 'ended' })).toBe(false);
    expect(callStageMounted({ ...live, status: 'idle' })).toBe(false);
  });

  it('respects the collapse, and only the collapse, on a healthy call', () => {
    expect(callStageMounted({ ...live, minimized: true })).toBe(false);
    // Going back to chat does not end the call, so restoring puts the
    // stage straight back.
    expect(callStageMounted({ ...live, minimized: false })).toBe(true);
  });
});

describe('resolveCallAccent', () => {
  it('follows the personality by default', () => {
    // `personality` is the identity affordance — the whole reason the shape is
    // a per-personality circle rather than a generic orb.
    const engineer = resolveCallAccent('personality', 'engineer');
    expect(engineer).toBe('#4ADE80');
    expect(resolveCallAccent('personality', 'researcher')).toBe('#4A9EFF');
    // Unset behaves the same as the default.
    expect(resolveCallAccent(undefined, 'engineer')).toBe(engineer);
    expect(resolveCallAccent(null, 'engineer')).toBe(engineer);
  });

  it('honors an explicit hex', () => {
    expect(resolveCallAccent('#123ABC', 'engineer')).toBe('#123ABC');
    expect(resolveCallAccent('#123abc', 'engineer')).toBe('#123abc');
  });

  it('falls back to the personality accent rather than painting garbage', () => {
    // A typo in config.yaml must not reach a canvas fillStyle.
    for (const bad of ['red', '#GGGGGG', '#4ADE8', '', 'rgb(1,2,3)']) {
      expect(resolveCallAccent(bad, 'engineer')).toBe('#4ADE80');
    }
  });
});

describe('callStateColor', () => {
  it('uses the red mic vocabulary for listening and accent for the agent', () => {
    expect(callStateColor('listening', '#4ADE80')).toBe(LISTENING_COLOR);
    expect(LISTENING_COLOR).toBe('#F87171');
    expect(callStateColor('thinking', '#4ADE80')).toBe('#4ADE80');
    expect(callStateColor('speaking', '#4ADE80')).toBe('#4ADE80');
  });
});

describe('smoothLevel', () => {
  it('low-passes towards the raw value', () => {
    const first = smoothLevel(0, 1, CALL_MOTION.smoothing);
    expect(first).toBeCloseTo(0.18, 5);
    expect(smoothLevel(first, 1, CALL_MOTION.smoothing)).toBeGreaterThan(first);
  });

  it('passes the raw value straight through at smoothing 0', () => {
    expect(smoothLevel(0.9, 0.2, 0)).toBe(0.2);
  });
});

describe('callDrive — which source drives which state', () => {
  const base = { micLevel: 0.8, agentLevel: 0.4, tSec: 0, reduced: false };

  it('listening reads the mic, and still needs smoothing', () => {
    const drive = callDrive({ ...base, state: 'listening' });
    expect(drive.raw).toBeCloseTo(0.8, 5);
    expect(drive.smooth).toBe(true);
  });

  it('speaking reads the agent level and does NOT smooth it again', () => {
    // The playout analyser already applied the one smoothing rule. A second
    // pass here would double the time constant and turn onset to mush.
    const drive = callDrive({ ...base, state: 'speaking' });
    expect(drive.raw).toBeCloseTo(0.4, 5);
    expect(drive.smooth).toBe(false);
  });

  it('thinking ignores both levels — nobody is talking', () => {
    const quiet = callDrive({ ...base, state: 'thinking', micLevel: 0, agentLevel: 0 });
    const loud = callDrive({ ...base, state: 'thinking', micLevel: 1, agentLevel: 1 });
    expect(quiet.raw).toBe(loud.raw);
    expect(quiet.raw).toBeCloseTo(thinkingBreath(0), 10);
    expect(quiet.smooth).toBe(false);
  });

  it('the thinking breath swells and never runs the shape flat', () => {
    const samples = [0, 0.5, 1, 1.5, 2].map(thinkingBreath);
    expect(Math.min(...samples)).toBeGreaterThan(0);
    expect(Math.max(...samples)).toBeGreaterThan(Math.min(...samples));
    expect(Math.max(...samples)).toBeLessThan(0.5);
  });

  it('clamps a hot source to 1', () => {
    expect(callDrive({ ...base, state: 'listening', micLevel: 4 }).raw).toBe(1);
    expect(callDrive({ ...base, state: 'listening', micLevel: -1 }).raw).toBe(0);
  });
});

describe('prefers-reduced-motion', () => {
  it('holds one legible level instead of tracking amplitude', () => {
    // "All motion is instant" (DESIGN.md). A fill that jumps with every
    // syllable is motion no matter which API draws it, so the drive is pinned
    // — and pinned above zero, because an empty shape reads as "off".
    for (const state of ['listening', 'thinking', 'speaking'] as const) {
      const drive = callDrive({ state, micLevel: 0.9, agentLevel: 0.9, tSec: 3, reduced: true });
      expect(drive.raw).toBe(REDUCED_MOTION_LEVEL);
      expect(drive.smooth).toBe(false);
    }
    expect(REDUCED_MOTION_LEVEL).toBeGreaterThan(0);
  });

  it('removes the surface wave and the glow', () => {
    expect(waveHeight(100, 0.9, false)).toBeGreaterThan(0);
    expect(waveHeight(100, 0.9, true)).toBe(0);
    expect(glowAlpha(0.9, false)).toBeGreaterThan(0);
    expect(glowAlpha(0.9, true)).toBe(0);
  });

  it('leaves the state legible without motion', () => {
    // What still carries the state: the color, and the contraction that says
    // "working". Neither depends on a frame of animation.
    expect(callStateColor('listening', '#4ADE80')).not.toBe(callStateColor('speaking', '#4ADE80'));
    expect(THINKING_RADIUS_SCALE).toBeLessThan(1);
  });
});

describe('rgba', () => {
  it('expands a hex into the alpha form canvas gradients need', () => {
    expect(rgba('#4ADE80', 0.5)).toBe('rgba(74,222,128,0.5)');
    expect(rgba('#000000', 1)).toBe('rgba(0,0,0,1)');
  });
});
