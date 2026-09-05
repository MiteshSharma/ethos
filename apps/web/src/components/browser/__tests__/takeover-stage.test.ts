import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  formatElapsed,
  fractionOf,
  modifierMask,
  statusLine,
  TAKEOVER_MIN_WIDTH,
  TakeoverStage,
  type TakeoverStageProps,
  TakeoverUnavailableNote,
} from '../TakeoverStage';

// What the screencast stage PROMISES, asserted where it is assertable without a
// DOM: the markup it ships (the `renderToStaticMarkup` precedent from
// `call-stage.test.ts`) and the stylesheet that decides the ≥44px targets and
// whether the pulse survives `prefers-reduced-motion`.

function stage(props: Partial<TakeoverStageProps> = {}): string {
  return renderToStaticMarkup(
    createElement(TakeoverStage, {
      url: 'https://example.com/login',
      startedAt: Date.now() - 134_000,
      status: 'live',
      notice: null,
      frameSrc: 'blob:fake-frame',
      handingBack: false,
      onInput: () => {},
      onHandBack: () => {},
      onBackToChat: () => {},
      ...props,
    }),
  );
}

const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'styles.css'), 'utf8');
const source = readFileSync(join(import.meta.dirname, '..', 'TakeoverStage.tsx'), 'utf8');
const chat = readFileSync(join(import.meta.dirname, '..', '..', '..', 'pages', 'Chat.tsx'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('the "This takeover" column', () => {
  it('names itself, and carries the URL and the elapsed time', () => {
    const html = stage();
    expect(html).toContain('This takeover');
    expect(html).toContain('https://example.com/login');
    expect(html).toContain('2m 14s');
  });

  it('is 320px, the Call Stage template', () => {
    expect(block('.takeover-stage')).toContain('minmax(0, 320px)');
  });

  it('states its state as a glyph AND a word, never colour alone', () => {
    expect(statusLine('live')).toEqual({ glyph: '●', word: 'you are driving' });
    expect(statusLine('unavailable')).toEqual({ glyph: '⚠', word: 'no live view' });
    expect(stage()).toContain('you are driving');
    expect(stage({ status: 'unavailable', frameSrc: null })).toContain('no live view');
  });

  it('formats elapsed the way the card does', () => {
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(134_000)).toBe('2m 14s');
  });
});

describe('the two ways out, which are not the same way out', () => {
  it('offers Hand back as one primary at ≥44px', () => {
    const html = stage();
    expect(html).toContain('Hand back');
    expect(block('.takeover-stage-handback')).toContain('min-height: 44px');
  });

  it('offers Back to chat, and says in its label that the takeover keeps running', () => {
    const html = stage();
    expect(html).toContain('Back to chat');
    expect(html).toContain('the takeover keeps running');
    // It is a collapse, not a resolution: the handler it is given is
    // `onBackToChat`, and nothing in this file resolves anything.
    expect(source).toContain('onClick={onBackToChat}');
    expect(block('.takeover-stage-back')).toContain('min-height: 44px');
    // …and the page wires that handler to a COLLAPSE. The takeover stays
    // pending; the card in the transcript still holds the hand-back.
    expect(chat).toContain('onBackToChat={() => setTakeoverStageOpen(false)}');
    expect(chat).toContain('const takeoverVisible = takeoverActive && takeoverStageOpen;');
  });

  it('never hands back on Esc — every key is forwarded to the page instead', () => {
    // The whole keyboard path is one `onInput` dispatch. There is no key
    // comparison anywhere in the component, which is what makes "Esc never
    // hands back" structurally true rather than a comment.
    expect(source).not.toMatch(/['"]Escape['"]/);
    expect(source).not.toMatch(/keyCode === 27/);
    // And the only thing that calls `onHandBack` is the button.
    expect(source.match(/onHandBack/g)?.length).toBe(3); // prop type, destructure, onClick
  });
});

describe('when there is nothing to drive', () => {
  it('renders the honest reason rather than an empty rectangle', () => {
    const html = stage({
      status: 'unavailable',
      frameSrc: null,
      notice: 'This Ethos process has no browser session "sess-9".',
    });
    expect(html).toContain('no browser session');
    expect(html).not.toContain('<img');
  });

  it('reads "Open on a desktop browser to take over" below the threshold', () => {
    const html = renderToStaticMarkup(createElement(TakeoverUnavailableNote, { reason: 'narrow' }));
    expect(html).toContain('Open on a desktop browser to take over');
    expect(TAKEOVER_MIN_WIDTH).toBe(760);
    // …and the page is what picks between the two, so the stage is never
    // entered on a phone in the first place.
    expect(chat).toContain('takeoverStageFits()');
    expect(chat).toContain('<TakeoverUnavailableNote reason="narrow" />');
  });
});

describe('motion', () => {
  it('stops the live pulse under prefers-reduced-motion', () => {
    const guard = css.indexOf('.takeover-stage-dot-live {\n    animation: none;');
    expect(guard, 'no reduced-motion rule for the takeover pulse').toBeGreaterThan(-1);
    const media = css.lastIndexOf('@media (prefers-reduced-motion: reduce)', guard);
    expect(media).toBeGreaterThan(-1);
    // The pulse it turns off is real, so the rule is not decorative.
    expect(block('.takeover-stage-dot-live')).toContain('animation: takeover-pulse');
  });
});

describe('pointer maths', () => {
  it('sends a position as a fraction of the RENDERED image, not page pixels', () => {
    expect(fractionOf({ left: 10, top: 20, width: 200, height: 100 }, 110, 70)).toEqual({
      x: 0.5,
      y: 0.5,
    });
  });

  it('clamps a drag that left the image', () => {
    expect(fractionOf({ left: 0, top: 0, width: 100, height: 100 }, -40, 400)).toEqual({
      x: 0,
      y: 1,
    });
  });

  it('packs modifiers into CDP’s mask', () => {
    expect(modifierMask({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: true })).toBe(9);
    expect(modifierMask({ altKey: false, ctrlKey: true, metaKey: true, shiftKey: false })).toBe(6);
  });
});
