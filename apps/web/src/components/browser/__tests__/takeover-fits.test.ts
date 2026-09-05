// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { TAKEOVER_MIN_WIDTH } from '../TakeoverStage';
import { takeoverStageFits } from '../useTakeoverSocket';

// The desktop-only gate, tested against a real `window` rather than a media
// query string in the stylesheet: the page never ENTERS the mode below the
// threshold, so this predicate is the whole enforcement.

const original = window.innerWidth;

function widen(px: number): void {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true });
}

afterEach(() => widen(original));

describe('takeoverStageFits', () => {
  it('offers the stage at the threshold and above', () => {
    widen(TAKEOVER_MIN_WIDTH);
    expect(takeoverStageFits()).toBe(true);
    widen(1440);
    expect(takeoverStageFits()).toBe(true);
  });

  it('refuses one pixel below it — a phone gets the note, not a canvas', () => {
    widen(TAKEOVER_MIN_WIDTH - 1);
    expect(takeoverStageFits()).toBe(false);
    widen(390);
    expect(takeoverStageFits()).toBe(false);
  });
});
