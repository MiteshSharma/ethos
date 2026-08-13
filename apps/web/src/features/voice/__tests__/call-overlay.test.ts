import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CallOverlay, type CallOverlayProps, stateDescription } from '../CallOverlay';

// What the overlay PROMISES, asserted where it is assertable without a DOM:
// the markup it ships (same `renderToStaticMarkup` precedent as
// `call-strip.test.ts`) and the stylesheet that decides whether it blocks the
// page. The canvas itself draws nothing here — `useEffect` never runs in an SSR
// render — and the drawing's rules are covered in `call-motion.test.ts`.

function overlay(props: Partial<CallOverlayProps> = {}): string {
  return renderToStaticMarkup(
    createElement(CallOverlay, {
      state: 'speaking',
      treatment: 'liquid',
      accent: '#4ADE80',
      personalityId: 'engineer',
      personalityName: 'Engineer',
      micLevels: [0.1, 0.4],
      agentLevel: () => 0.5,
      statusLabel: 'speaking',
      providerLabel: 'openai · gpt-realtime',
      muted: false,
      onToggleMute: () => {},
      onMinimize: () => {},
      onHangUp: () => {},
      ...props,
    }),
  );
}

const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'styles.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('CallOverlay — markup', () => {
  it('is a dialog that names the personality holding the call', () => {
    const html = overlay();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Call with Engineer"');
    // No `aria-modal`: it does not trap focus and must not claim to.
    expect(html).not.toContain('aria-modal');
  });

  it('dismissing is MINIMIZE, not close — hang-up is a separate control', () => {
    const html = overlay();
    expect(html).toContain('aria-label="Minimize call to the strip"');
    expect(html).toContain('aria-label="End call"');
    // Nothing offers to "close" the call, because closing it would end it.
    expect(html).not.toContain('aria-label="Close"');
  });

  it('keeps the mono state word and the {provider} · {model} label', () => {
    const html = overlay();
    expect(html).toContain('talk-mono');
    expect(html).toContain('openai · gpt-realtime');
    expect(html).toContain('speaking');
  });

  it('omits the provider label rather than printing an empty one', () => {
    expect(overlay({ providerLabel: '' })).not.toContain('call-overlay-foot"><span></span>');
  });

  it('reuses the strip controls, which are already ≥44px targets', () => {
    const html = overlay();
    expect(html).toContain('talk-btn');
    expect(html).toContain('talk-hangup-btn');
    expect(block('.talk-btn')).toContain('min-height: 44px');
  });

  it('describes each state for a screen reader', () => {
    expect(overlay({ state: 'listening' })).toContain('Listening — your microphone is live');
    expect(stateDescription('thinking', 'Engineer')).toBe('Engineer is thinking');
    expect(stateDescription('speaking', 'Engineer')).toBe('Engineer is speaking');
  });

  it('reflects mute in the control, not in a second state word', () => {
    expect(overlay({ muted: true })).toContain('aria-label="Unmute microphone"');
    expect(overlay({ muted: false })).toContain('aria-label="Mute microphone"');
  });
});

describe('CallOverlay — the stylesheet decides whether it blocks Chat', () => {
  it('the layer takes no pointer events and the panel takes them back', () => {
    // This IS the non-blocking promise: chat scrolls and the composer takes
    // text behind the overlay. A `pointer-events: auto` on the layer would
    // silently turn it into a modal.
    expect(block('.call-overlay-layer')).toContain('pointer-events: none');
    expect(block('.call-overlay')).toContain('pointer-events: auto');
  });

  it('enters over --motion-slow with the system easing', () => {
    const panel = block('.call-overlay');
    expect(panel).toContain('240ms');
    expect(panel).toContain('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(panel).toContain('var(--ethos-bg-elevated)');
  });

  it('sits below the modal layer, so an approval still lands on top', () => {
    const layer = block('.call-overlay-layer');
    const zIndex = Number(/z-index:\s*(\d+)/.exec(layer)?.[1]);
    expect(zIndex).toBeGreaterThan(0);
    expect(zIndex).toBeLessThan(1000);
  });

  it('stops its own entrance under prefers-reduced-motion', () => {
    const start = css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.talk-btn'));
    const rule = css.slice(start, start + 400);
    expect(rule).toContain('.call-overlay');
    expect(rule).toContain('animation: none');
  });
});
