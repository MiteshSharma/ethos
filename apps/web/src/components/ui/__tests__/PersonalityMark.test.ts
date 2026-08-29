// @vitest-environment jsdom
//
// PersonalityMark is hook-free except for `avatarUrl`'s error-state
// `useState`, which needs a real DOM to exercise (dispatching a load-failure
// `error` event on the `<img>` and observing the re-render). Every other
// component test in this app renders with `renderToStaticMarkup` because it
// has no interactive state; this one does, so it's the one exception that
// pulls in `react-dom/client` + jsdom rather than that no-DOM pattern.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonalityMark } from '../PersonalityMark';

describe('PersonalityMark', () => {
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

  it('renders the generated grid mark when no avatarUrl is given (regression)', () => {
    act(() => {
      root.render(createElement(PersonalityMark, { personalityId: 'engineer', size: 40 }));
    });
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders an <img> with the given src when avatarUrl is present', () => {
    act(() => {
      root.render(
        createElement(PersonalityMark, {
          personalityId: 'engineer',
          size: 40,
          avatarUrl: 'https://example.test/avatar.png',
        }),
      );
    });
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.test/avatar.png');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('falls back to the generated mark when the avatar image fails to load', () => {
    act(() => {
      root.render(
        createElement(PersonalityMark, {
          personalityId: 'engineer',
          size: 40,
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

  it('carries the accessible label onto whichever branch renders', () => {
    act(() => {
      root.render(createElement(PersonalityMark, { personalityId: 'researcher', size: 40 }));
    });
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'researcher personality',
    );

    act(() => {
      root.render(
        createElement(PersonalityMark, {
          personalityId: 'researcher',
          size: 40,
          avatarUrl: 'https://example.test/avatar.png',
        }),
      );
    });
    expect(container.querySelector('img')?.getAttribute('aria-label')).toBe(
      'researcher personality',
    );
  });
});
