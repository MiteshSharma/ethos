// @vitest-environment jsdom
//
// See PersonalityMark.test.ts's header comment — same reason this one exits
// the no-DOM `renderToStaticMarkup` pattern the rest of the app's component
// tests use: the `avatarUrl` error-state `useState` needs a real `<img>`
// load-failure event to exercise the fallback.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonalityRingAvatar } from '../PersonalityRingAvatar';

describe('PersonalityRingAvatar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the generated ring+dot mark when no avatarUrl is given (regression)', () => {
    act(() => {
      root.render(createElement(PersonalityRingAvatar, { personalityId: 'engineer', size: 32 }));
    });
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders an <img> with the given src when avatarUrl is present', () => {
    act(() => {
      root.render(
        createElement(PersonalityRingAvatar, {
          personalityId: 'engineer',
          size: 32,
          avatarUrl: 'https://example.test/avatar.png',
        }),
      );
    });
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.test/avatar.png');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('falls back to the generated ring+dot mark when the avatar image fails to load', () => {
    act(() => {
      root.render(
        createElement(PersonalityRingAvatar, {
          personalityId: 'engineer',
          size: 32,
          avatarUrl: 'https://example.test/broken.png',
        }),
      );
    });
    const img = container.querySelector('img');
    expect(img).not.toBeNull();

    act(() => {
      img?.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
