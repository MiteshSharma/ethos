import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CallStage, type CallStageProps, callStageTurns, stateDescription } from '../CallStage';
import { callStageMounted } from '../call-motion';
import type { VoiceTranscriptLine } from '../voice-call-reducer';

// What the Call Stage PROMISES, asserted where it is assertable without a DOM:
// the markup it ships (same `renderToStaticMarkup` precedent as
// `call-strip.test.ts`) and the stylesheet that decides whether the reserved
// slot moves when it fills. The canvas draws nothing here — `useEffect` never
// runs in an SSR render — and the drawing's rules are covered in
// `call-motion.test.ts`.

const TRANSCRIPT: VoiceTranscriptLine[] = [
  { id: 'voice-0', role: 'user', text: 'what is the market looking like tomorrow?' },
  { id: 'voice-1', role: 'agent', text: 'Futures are soft overnight.' },
  { id: 'voice-2', role: 'user', text: 'summarise the three biggest movers' },
  { id: 'voice-3', role: 'agent', text: 'Reliance, HDFC Bank', open: true },
];

const CLARIFY: ClarifyRequestEvent = {
  type: 'clarify.request',
  requestId: 'req-1',
  question: 'Do you mean NSE or BSE?',
  options: ['NSE', 'BSE'],
  defaultDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
};

function stage(props: Partial<CallStageProps> = {}): string {
  return renderToStaticMarkup(
    createElement(CallStage, {
      state: 'speaking',
      treatment: 'liquid',
      accent: '#4ADE80',
      personalityId: 'engineer',
      personalityName: 'Engineer',
      micLevels: [0.1, 0.4],
      agentLevel: () => 0.5,
      statusLabel: 'speaking',
      providerLabel: 'openai · gpt-realtime',
      latencyMs: 850,
      transcript: TRANSCRIPT,
      clarify: null,
      muted: false,
      onToggleMute: () => {},
      onExpandChat: () => {},
      onHangUp: () => {},
      ...props,
    }),
  );
}

const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'styles.css'), 'utf8');
const source = readFileSync(join(import.meta.dirname, '..', 'CallStage.tsx'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('Call Stage — entering and leaving the mode', () => {
  // The page computes two values from ONE predicate: `available` (is there a
  // stage to be in?) and `visible` (is it the surface right now?). They differ
  // only in the collapse, which is what makes the strip's restore control appear
  // exactly when there is something to restore.
  const decide = (
    status: Parameters<typeof callStageMounted>[0]['status'],
    opts: { degraded?: boolean; micDenied?: boolean; collapsed?: boolean } = {},
  ) => {
    const mount = {
      status,
      degraded: opts.degraded ?? false,
      micDenied: opts.micDenied ?? false,
    };
    return {
      available: callStageMounted({ ...mount, minimized: false }),
      visible: callStageMounted({ ...mount, minimized: opts.collapsed ?? false }),
    };
  };

  it('a live call IS the mode, through every transient status', () => {
    // The regression this pins: connecting and reconnecting happen DURING a
    // call, and a mode that unmounts for them replays its entrance and restarts
    // the canvas — the user reads that as the call surface flickering out and
    // back mid-sentence. Every status a live call passes through stays inside.
    for (const status of [
      'connecting',
      'listening',
      'thinking',
      'consulting',
      'agent_speaking',
      'interrupted',
      'reconnecting',
    ] as const) {
      expect(decide(status), status).toEqual({ available: true, visible: true });
    }
  });

  it('ending the call returns to normal chat', () => {
    expect(decide('ended')).toEqual({ available: false, visible: false });
    expect(decide('idle')).toEqual({ available: false, visible: false });
  });

  it('degraded and mic-denied return to normal chat, where the strip explains', () => {
    expect(decide('listening', { degraded: true })).toEqual({ available: false, visible: false });
    expect(decide('listening', { micDenied: true })).toEqual({ available: false, visible: false });
  });

  it('the collapsed stage is still available — that is the restore control', () => {
    expect(decide('listening', { collapsed: true })).toEqual({ available: true, visible: false });
    // …and a collapsed stage on a call that has ENDED is not available, so the
    // strip does not offer to restore a call that is over.
    expect(decide('ended', { collapsed: true })).toEqual({ available: false, visible: false });
  });
});

describe('Call Stage — the two columns', () => {
  it('names the personality holding the call, without claiming to be a dialog', () => {
    const html = stage();
    expect(html).toContain('aria-label="Call with Engineer"');
    // It is the surface, not something ON the surface: no dialog role, no
    // modality claim, nothing to dismiss.
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
  });

  it('ships NO left rail — the spine is gone, and nothing replaced it', () => {
    // The decision this pins: a navigation column during a call invites moving
    // around the UI mid-sentence. Two columns, and the left one is the stage.
    const html = stage();
    expect(html).not.toContain('call-stage-spine');
    expect(html).not.toContain('aria-label="Expand chat — the call keeps running"');
    expect(css).not.toContain('.call-stage-spine');
    // And no rail/nav crept in under another name.
    expect(html).not.toContain('role="navigation"');
    expect(html).not.toContain('<nav');
  });

  it('keeps text reachable: ONE "Back to chat" control, in the transcript head', () => {
    const html = stage();
    expect(html).toContain('call-stage-back');
    expect(html).toContain('>Back to chat</button>');
    // The accessible name contains the visible text, and says the call survives.
    expect(html).toContain('aria-label="Back to chat — the call keeps running"');
    // Exactly one — the brief's "do not invent a second mechanism".
    expect(html.match(/call-stage-back/g)).toHaveLength(1);
    // It lives in the transcript header, beside the label, not on the stage.
    const head = html.slice(
      html.indexOf('call-stage-transcript-head'),
      html.indexOf('call-stage-turns'),
    );
    expect(head).toContain('This call');
    expect(head).toContain('call-stage-back');
    // Hang-up is a separate control, and nothing offers to "close" the call.
    expect(html).toContain('aria-label="End call"');
    expect(html).not.toContain('aria-label="Close"');
  });

  it('is the SAME collapse path the spine was — one handler, not a second one', () => {
    // `onExpandChat` is what Chat maps to `setStageOpen(false)`, and the strip's
    // restore control is the other half of that same round trip. SSR cannot
    // click, so this is pinned at the source: exactly one `onExpandChat`
    // callsite, and it is the "Back to chat" button.
    const bound = source.match(/onClick=\{onExpandChat\}/g);
    expect(bound).toHaveLength(1);
    const at = source.indexOf('onClick={onExpandChat}');
    const button = source.slice(at - 220, at + 220);
    expect(button).toContain('call-stage-back');
    expect(button).toContain('Back to chat');
  });

  it('reuses the strip controls, which are already ≥44px targets', () => {
    const html = stage();
    expect(html).toContain('talk-btn');
    expect(html).toContain('talk-hangup-btn');
    expect(block('.talk-btn')).toContain('min-height: 44px');
  });

  it('reflects mute in the control, not in a second state word', () => {
    expect(stage({ muted: true })).toContain('aria-label="Unmute microphone"');
    expect(stage({ muted: false })).toContain('aria-label="Mute microphone"');
  });

  it('foots the stage with the mono {provider} · {latency}', () => {
    const html = stage();
    expect(html).toContain('talk-mono call-stage-foot');
    expect(html).toContain('openai · gpt-realtime · 850ms');
  });

  it('omits the footer rather than printing a lone separator', () => {
    expect(stage({ providerLabel: '', latencyMs: null })).not.toContain('call-stage-foot');
    expect(stage({ providerLabel: '', latencyMs: 420 })).toContain('>420ms<');
  });

  it('describes each state for a screen reader', () => {
    expect(stage({ state: 'listening' })).toContain('Listening — your microphone is live');
    expect(stateDescription('thinking', 'Engineer')).toBe('Engineer is thinking');
    expect(stateDescription('speaking', 'Engineer')).toBe('Engineer is speaking');
  });
});

describe('Call Stage — the transcript column is THIS call', () => {
  it('derives every row from the call transcript the reducer maintains', () => {
    expect(callStageTurns(TRANSCRIPT, 'Engineer')).toEqual([
      {
        id: 'voice-0',
        role: 'user',
        label: 'You',
        text: 'what is the market looking like tomorrow?',
        live: false,
        filler: false,
      },
      {
        id: 'voice-1',
        role: 'agent',
        label: 'Engineer',
        text: 'Futures are soft overnight.',
        live: false,
        filler: false,
      },
      {
        id: 'voice-2',
        role: 'user',
        label: 'You',
        text: 'summarise the three biggest movers',
        live: false,
        filler: false,
      },
      // The open agent line is the live one — the label says so, in accent.
      {
        id: 'voice-3',
        role: 'agent',
        label: 'Engineer · speaking',
        text: 'Reliance, HDFC Bank',
        live: true,
        filler: false,
      },
    ]);
  });

  it('carries the same [interrupted] marker the chat transcript does', () => {
    const turns = callStageTurns(
      [{ id: 'voice-0', role: 'agent', text: 'The weather today', interrupted: true }],
      'Engineer',
    );
    expect(turns[0]?.text).toContain('[interrupted]');
  });

  it('marks spoken filler as filler, so a stall does not read as an answer', () => {
    const turns = callStageTurns(
      [{ id: 'voice-0', role: 'agent', text: 'One moment.', filler: true }],
      'Engineer',
    );
    expect(turns[0]?.filler).toBe(true);
  });

  it('renders the rows and nothing from chat history', () => {
    const html = stage();
    expect(html).toContain('summarise the three biggest movers');
    expect(html).toContain('call-stage-turn-live');
    expect(html).toContain('This call');
  });

  it('an empty transcript is an empty column, not a placeholder turn', () => {
    const html = stage({ transcript: [] });
    expect(html).toContain('call-stage-turns');
    expect(html).not.toContain('call-stage-turn ');
  });
});

describe('Call Stage — the reserved clarify slot', () => {
  it('is on screen and dimmed when there is nothing to answer', () => {
    const html = stage({ clarify: null });
    expect(html).toContain('call-stage-slot call-stage-slot-empty');
    expect(html).toContain('No open question');
    expect(html).toContain('Asked aloud');
  });

  it('FILLS in place when a question is pending — same slot, no popup', () => {
    const html = stage({ clarify: CLARIFY });
    expect(html).toContain('call-stage-slot');
    expect(html).not.toContain('call-stage-slot-empty');
    expect(html).toContain('Do you mean NSE or BSE?');
    expect(html).toContain('NSE');
    expect(html).toContain('BSE');
    // The same ClarifyCard, so the same `clarify.respond` + `clarify.resolved`
    // teardown. It just is not pretending to be an alert here.
    expect(html).toContain('clarify-card-slot');
    expect(html).not.toContain('role="alertdialog"');
  });

  it('offers the free-form answer when the question has no options', () => {
    const html = stage({ clarify: { ...CLARIFY, options: undefined } });
    expect(html).toContain('clarify-card-freeform');
    expect(html).toContain('Type your answer…');
  });
});

describe('Call Stage — the stylesheet is what makes the slot stable', () => {
  it('is a TWO-column grid filling the chat tab, not an overlay', () => {
    const grid = block('.call-stage');
    expect(grid).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 320px)');
    // No third track — specifically, neither of the rail widths comes back.
    expect(grid).not.toContain('44px');
    expect(grid).not.toContain('36px');
    expect(grid).not.toContain('position: fixed');
    expect(block('.chat-tab-call')).toContain('grid-template-rows: 1fr');
  });

  it('gives the "Back to chat" control a ≥44px target in the header row', () => {
    expect(block('.call-stage-back')).toContain('min-height: 44px');
    const head = block('.call-stage-transcript-head');
    expect(head).toContain('display: flex');
    expect(head).toContain('justify-content: space-between');
  });

  it('reserves the slot height and makes the TURNS the flexible column', () => {
    // This IS the reason this direction was chosen: a question arriving must
    // not move anything. The slot holds its space (`min-height`) and refuses to
    // flex; the scrolling turn list absorbs the difference.
    const slot = block('.call-stage-slot');
    expect(slot).toContain('min-height');
    expect(slot).toContain('flex: none');
    const turns = block('.call-stage-turns');
    expect(turns).toContain('flex: 1');
    expect(turns).toContain('overflow-y: auto');
  });

  it('below 760px drops the transcript CONTENT but never the way back', () => {
    // With the spine gone the exit lives in the transcript header, so hiding
    // that column would strand the user inside the mode with only hang-up. The
    // column stays and restacks under the stage as its header row alone.
    const start = css.indexOf('@media (max-width: 760px)');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('\n}\n', start));
    expect(rule).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(rule).toContain('grid-template-rows: minmax(0, 1fr) auto');
    // What drops is the turn list and the slot — not the column, and not the
    // header the control sits in.
    expect(rule).toContain('.call-stage-turns');
    expect(rule).toContain('.call-stage-slot');
    expect(rule).toContain('display: none');
    expect(rule).not.toMatch(/\.call-stage-transcript\s*\{[^}]*display:\s*none/);
    expect(rule).not.toContain('.call-stage-transcript-head');
    expect(rule).not.toContain('.call-stage-back');
  });

  it('stops its own entrance under prefers-reduced-motion', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.talk-btn'));
    const rule = css.slice(start, start + 400);
    expect(rule).toContain('.call-stage');
    expect(rule).toContain('animation: none');
  });
});
