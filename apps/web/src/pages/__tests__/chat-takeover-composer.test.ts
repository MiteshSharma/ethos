// D3 — while a browser takeover is open the composer is locked.
//
// Two halves, because either alone would lie. The first renders the real
// `Composer` with the props Chat gives it during a takeover, proving the exact
// placeholder reaches the input and the input is actually disabled. The second
// reads `Chat.tsx` and proves Chat is what passes them — a rendering test on a
// component nobody wires would pass against a page that never locks anything.
// (Source-reading precedent: `aux-timeout-units.test.ts`,
// `settings-label-collisions.test.ts`.)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Composer } from '../../components/chat/Composer';

const TAKEOVER_PLACEHOLDER = 'Agent paused — hand back to continue';

const chatSource = readFileSync(join(import.meta.dirname, '..', 'Chat.tsx'), 'utf8');

describe('composer during a browser takeover', () => {
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Composer, {
        personalityId: 'ethos',
        disabled: true,
        onSend: () => {},
        placeholder: TAKEOVER_PLACEHOLDER,
      }),
    ),
  );

  it('carries the takeover placeholder', () => {
    expect(html).toContain('Agent paused — hand back to continue');
  });

  it('is disabled, not merely relabelled', () => {
    expect(html).toMatch(/<textarea[^>]*\sdisabled/);
  });
});

describe('Chat wires the lock to the takeover', () => {
  it('derives an active-takeover flag from the pending row and its resolution', () => {
    expect(chatSource).toContain(
      'const takeoverActive = takeoverRequest !== null && takeoverResolution === null;',
    );
  });

  it('passes it to the composer as both the disabled state and the placeholder', () => {
    expect(chatSource).toContain('disabled={takeoverActive}');
    expect(chatSource).toContain(`? '${TAKEOVER_PLACEHOLDER}'`);
  });

  it('keeps the takeover panel mounted after it resolves', () => {
    // Rendered from `takeoverRequest`, which outlives `pendingClarifies`, and
    // handed the settled row rather than being dropped.
    expect(chatSource).toContain('{takeoverRequest ? (');
    expect(chatSource).toContain('resolution={takeoverResolution}');
  });

  it('keeps a takeover out of the question card and the voice ask path', () => {
    expect(chatSource).toContain(
      "const pendingClarify = state.pendingClarifies.find(\n    (c) => (c.kind ?? 'question') !== 'browser_takeover',\n  );",
    );
  });
});
