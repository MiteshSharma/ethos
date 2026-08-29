import { personalityAccent } from '@ethosagent/design-tokens';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PersonalityBar, type PersonalityBarProps } from '../PersonalityBar';

// What the chat header PROMISES: it says WHO you are talking to, and offers no
// way to make that someone else. A session belongs to the personality it
// started with, so the only personality choice in the web UI happens when a
// session is started (the New Session picker behind `+`).
//
// `renderToStaticMarkup` needs no DOM, so this stays a plain `.test.ts` — same
// precedent as `composer-talk-mode.test.ts`.

function bar(props: Partial<PersonalityBarProps> = {}): string {
  return renderToStaticMarkup(
    createElement(PersonalityBar, {
      personalityId: 'engineer',
      name: 'Engineer',
      model: 'claude-sonnet-4',
      onNewSession: () => {},
      sessionTitle: 'Refactor the loader',
      onRenameSession: () => {},
      ...props,
    }),
  );
}

/** Every `aria-label` in the markup, in document order. */
function ariaLabels(html: string): string[] {
  return Array.from(html.matchAll(/aria-label="([^"]*)"/g)).map((m) => m[1] ?? '');
}

describe('PersonalityBar', () => {
  it('shows the personality identity — accent stripe, mark, name, model', () => {
    const html = bar();
    expect(html).toContain('personality-bar-stripe');
    expect(html).toContain(personalityAccent('engineer'));
    expect(html).toContain('Engineer');
    expect(html).toContain('claude-sonnet-4');
  });

  it('offers no control that changes the personality', () => {
    const html = bar();
    expect(html).not.toContain('personality-switcher');
    expect(ariaLabels(html)).toEqual(['Rename session', 'New session']);
  });

  it('acts on the session, not on identity — rename and new session only', () => {
    // Without a rename handler the bar is down to one control, and it is still
    // not a personality control.
    const html = bar({ onRenameSession: undefined });
    expect(ariaLabels(html)).toEqual(['New session']);
  });
});
