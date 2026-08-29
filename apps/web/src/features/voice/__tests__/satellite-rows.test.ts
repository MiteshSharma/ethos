import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SatelliteRow } from '../SatelliteRow';
import {
  conversationLeft,
  type SatelliteNode,
  type SatelliteState,
  satelliteCapabilityLabel,
  satelliteRowView,
  wakeAge,
} from '../satellite-rows';

// SatelliteRow's five states. The row itself is hook-free, so it renders with
// `renderToStaticMarkup` — the same constraint `voice-mode-toggle.test.ts`
// works under, since the apps/web suite has no DOM.

function node(over: Partial<SatelliteNode> = {}): SatelliteNode {
  return {
    nodeId: 'pi-kitchen',
    laneId: 'voice:pi-kitchen:engineer',
    displayName: 'Kitchen Pi',
    capabilities: { edgeStt: true, playback: true, captureSampleRate: 16000, phraseMatch: true },
    state: 'listening',
    stateDetail: null,
    wakeEnabled: true,
    probes: [{ name: 'wake model', ok: true, detail: null }],
    lastWake: null,
    conversation: null,
    connectedAt: 0,
    ...over,
  };
}

function markup(over: Partial<SatelliteNode> = {}): string {
  const n = node(over);
  return renderToStaticMarkup(
    createElement(SatelliteRow, {
      node: n,
      view: satelliteRowView(n),
      now: 10_000_000_000,
      busy: false,
      onToggleWake: () => {},
    }),
  );
}

describe('satelliteRowView — every state is visibly distinct', () => {
  const cases: Array<
    [SatelliteState, { dot: string; label: string; bars: boolean; pulse: boolean }]
  > = [
    ['listening', { dot: 'sb-dot--listening', label: 'listening', bars: true, pulse: false }],
    ['speaking', { dot: 'sb-dot--speaking', label: 'speaking', bars: false, pulse: true }],
    ['muted', { dot: 'sb-dot--muted', label: 'muted', bars: false, pulse: false }],
    ['wake_off', { dot: 'sb-dot--wake-off', label: 'wake off', bars: false, pulse: false }],
    ['degraded', { dot: 'sb-dot--degraded', label: 'degraded', bars: false, pulse: false }],
  ];

  for (const [state, expected] of cases) {
    it(`${state} → ${expected.dot} + "${expected.label}"`, () => {
      const view = satelliteRowView(node({ state }));
      expect(view.dotClass).toBe(expected.dot);
      expect(view.label).toBe(expected.label);
      expect(view.bars).toBe(expected.bars);
      expect(view.pulse).toBe(expected.pulse);
    });
  }

  it('gives no state the same dot as another', () => {
    const dots = cases.map(([state]) => satelliteRowView(node({ state })).dotClass);
    expect(new Set(dots).size).toBe(dots.length);
  });

  it('only the degraded state carries a consequence', () => {
    for (const [state] of cases) {
      const view = satelliteRowView(node({ state }));
      expect(view.consequence === null).toBe(state !== 'degraded');
    }
  });
});

describe('doctor-failed row', () => {
  const failing = {
    state: 'degraded' as const,
    stateDetail: 'model file missing — sherpa-wake.onnx',
    probes: [
      { name: 'wake model', ok: false, detail: 'sherpa-wake.onnx not found' },
      { name: 'mic device', ok: true, detail: null },
    ],
  };

  it('names the failing probe AND the degraded-to-text consequence', () => {
    const view = satelliteRowView(node(failing));
    expect(view.detail).toContain('model file missing — sherpa-wake.onnx');
    expect(view.detail).toContain('wake model — sherpa-wake.onnx not found');
    expect(view.consequence).toContain('Degraded to text');
    expect(view.consequence).toContain('no phrase wakes this node');
  });

  it('renders both on the row, not only in CLI output', () => {
    const html = markup(failing);
    expect(html).toContain('sherpa-wake.onnx');
    expect(html).toContain('Degraded to text');
  });

  it('never leaves a degraded row with nothing to explain it', () => {
    const view = satelliteRowView(node({ state: 'degraded', stateDetail: null, probes: [] }));
    expect(view.detail).not.toBeNull();
    expect(view.consequence).not.toBeNull();
  });
});

describe('SatelliteRow markup', () => {
  it('draws liveness bars only while listening', () => {
    expect(markup({ state: 'listening' })).toContain('sat-bars');
    expect(markup({ state: 'muted' })).not.toContain('sat-bars');
  });

  it('reuses the shared connection dot rather than drawing a new one', () => {
    expect(markup()).toContain('class="sb-dot sb-dot--listening"');
  });

  it('shows the last wake as phrase → mark + age, in mono', () => {
    const html = markup({
      lastWake: { phrase: 'hey engineer', personalityId: 'engineer', at: 10_000_000_000 - 120_000 },
    });
    expect(html).toContain('hey engineer');
    expect(html).toContain('engineer personality'); // PersonalityMark's aria-label
    expect(html).toContain('2m ago');
  });

  it('says so plainly when a node has never woken anything', () => {
    expect(markup()).toContain('no wake yet');
  });

  it('falls back to the node id when the satellite reported no name', () => {
    expect(markup({ displayName: null })).toContain('pi-kitchen');
  });
});

describe('wakeAge', () => {
  const now = 10_000_000_000;
  it('answers "how long ago", coarsely', () => {
    expect(wakeAge(now - 5_000, now)).toBe('5s ago');
    expect(wakeAge(now - 90_000, now)).toBe('1m ago');
    expect(wakeAge(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(wakeAge(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  it('never renders a negative age from a clock that ran backwards', () => {
    expect(wakeAge(now + 5_000, now)).toBe('0s ago');
  });
});

describe('the open addressing window', () => {
  const now = 10_000_000_000;

  it('says who a follow-up with no wake phrase would reach', () => {
    // A microphone that will answer "tell me more" as the researcher is in a
    // materially different state from one that needs a phrase first, and the
    // row is where an operator finds out which.
    const html = markup({ conversation: { personalityId: 'researcher', until: now + 24_000 } });
    expect(html).toContain('follow-ups reach');
    expect(html).toContain('researcher');
    expect(html).toContain('24s left');
  });

  it('says nothing once the window has closed, even on a row that never refreshed', () => {
    // `until` is an instant, so a stale row renders it as expired rather than
    // claiming a conversation the server would no longer honour.
    expect(markup({ conversation: { personalityId: 'researcher', until: now - 1 } })).not.toContain(
      'follow-ups reach',
    );
    expect(markup()).not.toContain('follow-ups reach');
  });

  it('counts down in seconds, then in minutes', () => {
    expect(conversationLeft(now + 45_000, now)).toBe('45s left');
    expect(conversationLeft(now + 150_000, now)).toBe('2m left');
    expect(conversationLeft(now, now)).toBeNull();
  });
});

describe('satelliteCapabilityLabel', () => {
  it('says which side transcribes, because that is the privacy fact', () => {
    expect(satelliteCapabilityLabel(node())).toBe(
      'edge STT · 16000 Hz · playback · matches phrases',
    );
    expect(
      satelliteCapabilityLabel(
        node({
          capabilities: {
            edgeStt: false,
            playback: false,
            captureSampleRate: 0,
            phraseMatch: false,
          },
        }),
      ),
      // …and which side MATCHES, which is the other privacy fact: a node the
      // server matches for is a node whose every utterance the server reads.
    ).toBe('gateway STT · server matches');
  });
});

describe('reduced motion (DR5)', () => {
  // Asserted against the stylesheet, which is the artifact that ships — the
  // suite has no DOM to compute styles in. Same approach as
  // `call-strip-css.test.ts`.
  const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'styles.css'), 'utf8');

  it('stops the liveness bars and the speaking dot', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.sat-bar {'));
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, start + 400);
    expect(rule).toContain('.sat-bar');
    expect(rule).toContain('.sb-dot--pulse');
    expect(rule).toContain('animation: none');
    // The bars hold their tallest height so the row still reads as armed.
    expect(rule).toContain('height: 12px');
  });

  it('draws wake-off hollow rather than as a second grey', () => {
    const start = css.indexOf('.sb-dot--wake-off {');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}', start));
    expect(rule).toContain('background: transparent');
    expect(rule).toContain('border:');
  });
});
