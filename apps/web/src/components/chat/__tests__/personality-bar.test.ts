import { personalityAccent } from '@ethosagent/design-tokens';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PersonalityBar, type PersonalityBarProps } from '../PersonalityBar';

// What the chat header PROMISES: it says WHO you are talking to, and offers no
// way to make that someone else. A session belongs to the personality it
// started with, so the only personality choice in the web UI happens when a
// session is started (the New Session picker behind `+`).
//
// `renderToStaticMarkup` needs no DOM, so this stays a plain `.test.ts` — same
// precedent as `composer-talk-mode.test.ts`.

// The team variant renders a `<Link>`, so the bar sits inside a router.
function bar(props: Partial<PersonalityBarProps> = {}): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(PersonalityBar, {
        personalityId: 'engineer',
        name: 'Engineer',
        model: 'claude-sonnet-4',
        onNewSession: () => {},
        sessionTitle: 'Refactor the loader',
        onRenameSession: () => {},
        ...props,
      }),
    ),
  );
}

const MARKETING = {
  teamId: 'marketing',
  teamName: 'Marketing',
  accents: [personalityAccent('engineer'), personalityAccent('researcher')],
};
const AS_COORDINATOR = { ...MARKETING, coordinatorId: 'engineer', coordinatorName: 'Engineer' };

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

  describe('teamContext — the team Chat pane (teams-as-a-scope D4)', () => {
    it('reads `<ring> <team> = <mark> <coordinator> · coordinator · <model>`', () => {
      const html = bar({ teamContext: AS_COORDINATOR });
      // The team ring (48/22px is a size, the accessible name is the team).
      expect(html).toContain('aria-label="Marketing"');
      expect(html).toContain('team-chat-bar-team');
      expect(html).toContain('>=<');
      expect(html).toContain('aria-label="engineer personality"');
      expect(html).toContain('Engineer');
      expect(html).toContain('coordinator · claude-sonnet-4');
    });

    it("shows the coordinator's display name from the context, never the capitalised id", () => {
      const html = bar({
        personalityId: 'cmo',
        name: undefined,
        teamContext: { ...MARKETING, coordinatorId: 'cmo', coordinatorName: 'CMO' },
      });
      expect(html).toContain('team-chat-bar-coordinator">CMO<');
      expect(html).toContain('Open CMO&#x27;s workspace →');
      expect(html).not.toContain('Cmo');
    });

    it("keeps the coordinator's accent stripe", () => {
      const html = bar({ teamContext: AS_COORDINATOR });
      expect(html).toContain('personality-bar-stripe');
      expect(html).toContain(personalityAccent('engineer'));
    });

    it("links to the coordinator's workspace inside the team", () => {
      const html = bar({ teamContext: AS_COORDINATOR });
      expect(html).toContain('href="/t/marketing/p/engineer/chat"');
      expect(html).toContain('Open Engineer&#x27;s workspace →');
    });

    it('still offers only the session controls', () => {
      const html = bar({ teamContext: AS_COORDINATOR });
      expect(html).not.toContain('personality-switcher');
      // The ring's accessible name is the only extra label; rename + new remain.
      expect(ariaLabels(html).filter((l) => l !== 'Marketing')).toEqual([
        'engineer personality',
        'Rename session',
        'New session',
      ]);
    });
  });

  describe("coordinatorOf — the coordinator's own workspace inside its team", () => {
    it('shows the reverse label after the model', () => {
      const html = bar({ coordinatorOf: MARKETING });
      expect(html).toContain('team-chat-bar-coordinator-of');
      expect(html).toContain('aria-label="Marketing"');
      expect(html).toContain('coordinator of Marketing · this is the team&#x27;s chat');
      // The plain identity block is untouched — mark, name, model.
      expect(html).toContain('personality-bar-identity');
      expect(html).toContain('claude-sonnet-4');
    });

    it('is absent for a member who is not the coordinator', () => {
      const html = bar();
      expect(html).not.toContain('team-chat-bar-coordinator-of');
      expect(html).not.toContain('team-chat-bar-link');
    });
  });
});
