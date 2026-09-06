// A spoken clarify answer the server refuses is SAID, not swallowed.
//
// `clarify.respond` (`apps/web-api/src/rpc/clarify.ts`) throws for every
// outcome `ClarifyBridge.respond` reports unresolved, carrying the sentence
// `clarifyUnresolvedMessage` supplies. The typed path renders it —
// `ClarifyCard`'s `respond` puts it in `submitError`. The voice path handed
// `runVoiceClarify` a `respond` that did nothing with it, and
// `runVoiceClarify` catches every failure by design and reports `card-only`
// (pinned by `apps/web/src/features/voice/__tests__/clarify-voice.test.ts`,
// "stays card-only when the answer could not be delivered"). So the refusal
// died between the two: the user had already spoken an answer, the card sat
// there unchanged, and nothing on screen said the answer went nowhere.
//
// NOTE the premise this fixes is narrower than it was reported as. There was no
// unhandled rejection — `runVoiceClarify` awaits `respond` inside a try/catch.
// The loss was silent, not noisy, which is why it survived.
//
// Read from source: the closure is built inside a `useEffect` in a page that
// needs a router, a query client, an SSE stream and a live voice call to
// render. Precedent: `chat-takeover-composer.test.ts` in this directory, whose
// second half reads `Chat.tsx` for exactly this reason.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Source with `//` and block comments blanked, so prose cannot pass an assertion. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const chatSource = stripComments(readFileSync(join(import.meta.dirname, '..', 'Chat.tsx'), 'utf8'));

/** The `respond` closure Chat hands `runVoiceClarify`, up to `signal:`. */
function voiceRespondClosure(): string {
  const start = chatSource.indexOf('runVoiceClarify({');
  expect(start).toBeGreaterThan(-1);
  const body = chatSource.slice(start);
  const respondAt = body.indexOf('respond:');
  const signalAt = body.indexOf('signal:', respondAt);
  expect(respondAt).toBeGreaterThan(-1);
  expect(signalAt).toBeGreaterThan(respondAt);
  return body.slice(respondAt, signalAt);
}

describe('voice clarify refusal', () => {
  it('catches the rejection clarify.respond throws', () => {
    const closure = voiceRespondClosure();
    expect(closure).toContain('rpc.clarify.respond(');
    expect(closure).toMatch(/catch\s*\(err\)/);
  });

  it('shows the message the RPC threw rather than inventing copy', () => {
    const closure = voiceRespondClosure();
    expect(closure).toContain('notification.info(');
    expect(closure).toContain('err instanceof Error ? err.message : String(err)');
    // No second sentence of its own: the words are the server's, built from
    // `clarifyUnresolvedMessage`, so voice and the card say the same thing.
    expect(closure).not.toMatch(/description:\s*['"`]/);
  });

  it('rethrows, so the card stays the way to answer', () => {
    // Swallowing here would make `runVoiceClarify` report `answered` for an
    // answer the agent never received — the exact defect one layer up.
    expect(voiceRespondClosure()).toContain('throw err;');
  });

  it('keeps notification in the effect deps', () => {
    // Antd's `App.useApp()` notification instance is not referentially stable
    // across renders in every version; an omitted dep is a lint failure here
    // and a stale binding in principle.
    expect(chatSource).toContain('[pendingClarify, inCall, askByVoice, notification]');
  });
});
