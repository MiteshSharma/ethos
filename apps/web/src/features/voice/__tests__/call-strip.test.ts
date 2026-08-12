import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TalkModeCallBar, type TalkModeCallBarProps } from '../TalkMode';
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
