// The CLI says something true when a clarify answer does not land.
//
// `AgentLoop.respondToClarify` now returns a `ClarifyRespondOutcome`
// (`packages/core/src/clarify/respond-outcome.ts`). The chat presenter used to
// `void` the call: it redrew the prompt and moved on, so an id already answered
// on another surface, a request swept by its timeout, and a `browser_takeover`
// the answer gate refuses on the CLI (`isClarifyAnswerableOn` in
// `packages/core/src/clarify/takeover-handback.ts`) were all indistinguishable
// from an answer the agent received. The CLI can be asked a takeover — it is a
// `handback_capable` surface — which is what makes the last case reachable
// rather than theoretical.
//
// Read from source rather than driven, because the presenter is a closure over
// a live `readline` interface built inside `runChat`, with no seam to reach it
// from a test. Precedent: `apps/web/src/pages/__tests__/chat-takeover-composer.test.ts`,
// `config-doc-sync.test.ts`. The sentences themselves are pinned by
// `packages/core/src/__tests__/clarify-respond-outcome.test.ts`, and the
// outcome reaching this caller at all by
// `packages/core/src/__tests__/agent-loop-respond-clarify.test.ts`; what only
// this file can see is that the CLI READS it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clarifyUnresolvedMessage } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';

/** Source with `//` and block comments blanked, so prose cannot pass an assertion. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const chatSource = stripComments(
  readFileSync(join(import.meta.dirname, '..', 'commands', 'chat.ts'), 'utf8'),
);

describe('CLI clarify hand-back', () => {
  it('reads the outcome of respondToClarify instead of discarding it', () => {
    expect(chatSource).toMatch(/respondToClarify\([\s\S]{0,160}?\)\s*\.then\(\(outcome\)/);
    expect(chatSource).toContain('if (outcome.resolved) return;');
  });

  it('prints the shared sentence for the reason, not copy of its own', () => {
    expect(chatSource).toContain('clarifyUnresolvedMessage(outcome.reason)');
    expect(chatSource).toContain('That answer did not land:');
  });

  it('has a distinct sentence for every reason the outcome can carry', () => {
    // A `not_answerable` clarify stays OPEN; the other two mean the question is
    // over. Telling the reader one covering line for all three — which is what
    // web-api printed before `clarifyUnresolvedMessage` existed — is false for
    // `not_answerable` in every clause.
    const sentences = (['unknown_request', 'already_answered', 'not_answerable'] as const).map(
      clarifyUnresolvedMessage,
    );
    expect(new Set(sentences).size).toBe(3);
  });
});
