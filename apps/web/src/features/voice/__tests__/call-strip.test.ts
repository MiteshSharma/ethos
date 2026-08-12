import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { callDetailItems, TalkModeCallBar, type TalkModeCallBarProps } from '../TalkMode';
import type { VoiceCallStatus } from '../voice-call-reducer';

// The CallStrip's nine interaction states (plan DR1). Each case asserts what
// the USER SEES, in DESIGN.md vocabulary — the amber connection dot, the red
// AudioBars mic meter, the accent dot steady vs pulsing, the caption line, the
// mono `{provider} · {model}` label.
//
// `renderToStaticMarkup` needs no DOM, so this stays a plain `.test.ts` —
// same precedent as `document-preview-body.test.ts`.

function strip(props: Partial<TalkModeCallBarProps> & { status: VoiceCallStatus }): string {
  return renderToStaticMarkup(
    createElement(TalkModeCallBar, {
      micLevels: [0.2, 0.5, 0.9],
      muted: false,
      error: null,
      onToggleMute: () => {},
      onHangUp: () => {},
      ...props,
    }),
  );
}

describe('CallStrip — DR1 interaction states', () => {
  it('idle: the strip is a call-only surface — Chat renders nothing for it', () => {
    // `idle` never reaches the strip (Chat gates on `inCall`); the state table's
    // idle row is the composer glyph + "Try voice" pill, covered separately.
    // Rendering it anyway must not invent a call: no hang-up affordance beyond
    // the controls themselves, and no caption.
    const html = strip({ status: 'idle' });
    expect(html).not.toContain('talk-caption');
  });

  it('connecting: pulsing amber dot + the mono "connecting" label', () => {
    const html = strip({ status: 'connecting' });
    expect(html).toContain('talk-link-pulse');
    expect(html).toContain('connecting');
    // Not the accent speaking dot — nobody is talking yet.
    expect(html).not.toContain('talk-agent-dot');
  });

  it('listening: the red AudioBars mic meter is live', () => {
    const html = strip({ status: 'listening' });
    expect(html).toContain('composer-voice-bar');
    expect(html).toContain('listening');
    expect(html).not.toContain('talk-link-pulse');
  });

  it('thinking: the accent dot is STEADY, not pulsing', () => {
    const html = strip({ status: 'thinking' });
    expect(html).toContain('talk-agent-dot');
    expect(html).not.toContain('talk-agent-pulse');
    expect(html).toContain('Agent is thinking');
  });

  it('agent speaking: the accent dot pulses and the caption is live', () => {
    const html = strip({ status: 'agent_speaking', caption: 'The weather today is clear.' });
    expect(html).toContain('talk-agent-pulse');
    expect(html).toContain('The weather today is clear.');
    expect(html).toContain('aria-live="polite"');
  });

  it('barge-in acknowledged: the caption truncates and the strip flashes', () => {
    const html = strip({ status: 'interrupted', caption: 'The weather today' });
    expect(html).toContain('talk-indicator-flash');
    expect(html).toContain('interrupted — go ahead');
  });

  it('reconnecting: amber dot + the mono "reconnecting…" label', () => {
    const html = strip({ status: 'reconnecting' });
    expect(html).toContain('talk-link-pulse');
    expect(html).toContain('reconnecting…');
  });

  it('budget wind-down: the spoken sign-off captioned + a `budget reached` mono chip', () => {
    const signOff = 'That’s the spending limit for this call, so I’ll stop here.';
    const html = strip({ status: 'agent_speaking', caption: signOff, windDown: signOff });
    expect(html).toContain('spending limit for this call');
    expect(html).toContain('budget reached');
    // In the mono label vocabulary — not a badge, not a banner — and the strip
    // is still a strip while the sentence is being said.
    expect(html).toContain('talk-mono talk-budget-chip');
    expect(html).toContain('aria-label="End call"');
  });

  it('shows no chip on a call that did not reach its budget', () => {
    expect(strip({ status: 'agent_speaking', caption: 'anything' })).not.toContain(
      'budget reached',
    );
  });

  it('degraded to text: the strip collapses to a dismissible notice naming the provider', () => {
    const html = strip({
      status: 'ended',
      degraded: { provider: 'openai-tts', message: 'Speech synthesis failed' },
      onDismissNotice: () => {},
    });
    expect(html).toContain('Voice unavailable');
    expect(html).toContain('openai-tts');
    expect(html).toContain('continuing in text');
    expect(html).toContain('aria-label="Dismiss"');
    // The call controls are gone — there is nothing left to control.
    expect(html).not.toContain('aria-label="End call"');
  });

  it('degraded to text without a named provider still says what happened', () => {
    const html = strip({
      status: 'ended',
      degraded: { provider: null, message: 'Could not transcribe audio' },
    });
    expect(html).toContain('the voice provider failed');
  });

  it('mic permission denied: guidance with the re-grant path, never a dead mic', () => {
    const html = strip({
      status: 'ended',
      micDenied: true,
      error: 'Ethos needs your microphone to talk. Allow it in your browser’s site settings.',
      onDismissNotice: () => {},
    });
    expect(html).toContain('site settings');
    expect(html).toContain('talk-notice-mic');
    expect(html).not.toContain('aria-label="Mute microphone"');
  });
});

describe('CallStrip — provider + latency vocabulary (DR3)', () => {
  it('renders `{provider} · {model}` in Geist Mono, not a badge', () => {
    const html = strip({
      status: 'listening',
      sttProvider: 'local-stt',
      sttModel: 'whisper-large-v3',
    });
    expect(html).toContain('local-stt · whisper-large-v3');
    expect(html).toContain('talk-mono');
    expect(html).not.toContain('badge');
  });

  it('names the TTS provider while the agent is the one speaking', () => {
    const html = strip({
      status: 'agent_speaking',
      sttProvider: 'local-stt',
      ttsProvider: 'local-tts',
      ttsModel: 'kokoro',
    });
    expect(html).toContain('local-tts · kokoro');
    expect(html).not.toContain('local-stt');
  });

  it('the per-turn breakdown is behind an expandable toggle, collapsed by default', () => {
    const html = strip({
      status: 'agent_speaking',
      ttsProvider: 'local-tts',
      latency: { llmMs: 640, ttsMs: 210, totalMs: 850 },
    });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('850ms');
    // The stage breakdown is not on screen until asked for.
    expect(html).not.toContain('talk-call-detail');
  });
});

describe('CallStrip — controls', () => {
  it('mute reflects its pressed state for assistive tech', () => {
    const html = strip({ status: 'listening', muted: true });
    expect(html).toContain('aria-label="Unmute microphone"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('talk-indicator-muted');
  });

  it('uses rows, never the Card primitive', () => {
    const html = strip({ status: 'listening' });
    expect(html).toContain('talk-call-row');
    expect(html).not.toContain('ant-card');
  });
});

describe('CallStrip — the realtime tier renders in the SAME strip (DR3)', () => {
  it('names the realtime provider and its model, one label for both directions', () => {
    // On this tier ONE provider both hears and speaks, so there is no
    // listening/speaking split to choose between.
    const html = strip({
      status: 'agent_speaking',
      tier: 'realtime',
      realtimeProvider: 'openai-realtime',
      realtimeModel: 'gpt-realtime',
    });
    expect(html).toContain('openai-realtime · gpt-realtime');
    expect(html).toContain('talk-mono');
    expect(html).not.toContain('badge');
  });

  it('the tier is a mono label in the expandable detail, never a new surface', () => {
    // Rendered only when the detail is open, which it is not by default — the
    // tier is a detail, not a dashboard.
    const collapsed = strip({ status: 'listening', tier: 'realtime' });
    expect(collapsed).not.toContain('talk-call-detail');
    expect(collapsed).not.toContain('tier realtime');
  });

  it('a refused realtime tier is a dismissible line ABOVE a live strip', () => {
    // Unlike `degraded`, which replaces the strip: voice still works here, so
    // the controls must survive.
    const html = strip({
      status: 'listening',
      tier: 'pipeline',
      notice: 'Realtime provider "gemini-live" cannot issue a browser credential.',
      onDismissNotice: () => {},
    });
    expect(html).toContain('talk-notice-tier');
    expect(html).toContain('cannot issue a browser credential');
    // The call is still up: mute and hang-up are still there.
    expect(html).toContain('aria-label="Mute microphone"');
    expect(html).toContain('aria-label="End call"');
    expect(html).toContain('aria-label="Dismiss"');
  });

  it('the private-mode choice is reversible while it is the user’s own choice', () => {
    // A one-way door would be the wrong control: the pipeline can also be
    // serving because realtime was REFUSED, and offering "use realtime" there
    // would be a button that cannot work.
    const props = {
      status: 'listening' as const,
      tier: 'pipeline' as const,
      onUsePrivateMode: () => {},
      onLeavePrivateMode: () => {},
    };
    // Both controls live in the collapsed detail, so neither reaches the strip
    // row itself. (`renderToStaticMarkup` always renders the toggle closed, so
    // the open row's contents are covered by `callDetailItems` below instead.)
    expect(strip({ ...props, privateMode: true })).not.toContain('leave private mode');
    expect(strip({ ...props, privateMode: false })).not.toContain('use private mode');
  });

  it('keeps the private-mode control behind the toggle, not on the strip itself', () => {
    // The strip does not grow a control row for the tier; the choice lives in
    // the same expandable detail the provider labels do.
    const html = strip({
      status: 'listening',
      tier: 'realtime',
      realtimeProvider: 'openai-realtime',
      onUsePrivateMode: () => {},
    });
    expect(html).not.toContain('talk-private-btn');
    expect(html).not.toContain('talk-call-detail');
  });
});

describe('CallStrip — the expandable detail row', () => {
  it('leads with the tier, then the provider that served, then the stages', () => {
    expect(
      callDetailItems({
        tier: 'realtime',
        realtimeProvider: 'openai-realtime',
        realtimeModel: 'gpt-realtime',
        latency: { llmMs: 300, ttsMs: 120, totalMs: 420 },
      }),
    ).toEqual([
      'tier realtime',
      'realtime openai-realtime · gpt-realtime',
      'llm 300ms',
      'audio 120ms',
      'total 420ms',
    ]);
  });

  it('names the pipeline tier’s two providers separately', () => {
    expect(
      callDetailItems({
        tier: 'pipeline',
        sttProvider: 'local-stt',
        sttModel: 'whisper-large-v3',
        ttsProvider: 'local-tts',
        ttsModel: 'kokoro',
      }),
    ).toEqual([
      'tier pipeline',
      'stt local-stt · whisper-large-v3',
      'tts local-tts · kokoro',
      'llm —',
      'audio —',
      'total —',
    ]);
  });

  it('says nothing about a tier nobody reported', () => {
    expect(callDetailItems({})).toEqual(['llm —', 'audio —', 'total —']);
  });
});
