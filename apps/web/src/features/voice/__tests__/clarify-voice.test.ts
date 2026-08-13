import { describe, expect, it } from 'vitest';
import { runVoiceClarify, spokenClarify } from '../clarify-voice';

// The decision half of voice-native `clarify`: WHEN the question is spoken, and
// where the spoken answer goes. Both sides are injected (`ask` is the voice
// seam, `respond` is the RPC), so no call, no DOM and no server are involved.

/** Records what was asked and answers with whatever the test decided. */
function harness(
  opts: {
    ask?: (question: string, signal: AbortSignal) => Promise<string | null>;
    respond?: (answer: string) => Promise<void>;
  } = {},
) {
  const asked: string[] = [];
  const responded: string[] = [];
  return {
    asked,
    responded,
    ask: (question: string, signal: AbortSignal): Promise<string | null> => {
      asked.push(question);
      return opts.ask ? opts.ask(question, signal) : Promise.resolve(null);
    },
    respond: (answer: string): Promise<void> => {
      responded.push(answer);
      return opts.respond ? opts.respond(answer) : Promise.resolve();
    },
  };
}

describe('spokenClarify', () => {
  it('speaks a free-form question as written', () => {
    expect(spokenClarify({ requestId: 'r1', question: '  Which branch?  ' })).toBe('Which branch?');
  });

  it('reads the options out, because they are not answerable off the screen', () => {
    expect(
      spokenClarify({ requestId: 'r1', question: 'Deploy where?', options: ['staging', 'prod'] }),
    ).toBe('Deploy where? You can say: staging, prod.');
  });

  it('ignores empty options rather than trailing an empty list', () => {
    expect(spokenClarify({ requestId: 'r1', question: 'Ready?', options: ['', '  '] })).toBe(
      'Ready?',
    );
  });
});

describe('runVoiceClarify', () => {
  const request = { requestId: 'r1', question: 'Deploy where?', options: ['staging', 'prod'] };

  it('routes the spoken answer to clarify.respond — never a new chat turn', async () => {
    const h = harness({ ask: () => Promise.resolve('  prod  ') });
    const outcome = await runVoiceClarify({
      request,
      ask: h.ask,
      respond: h.respond,
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('answered');
    expect(h.asked).toEqual(['Deploy where? You can say: staging, prod.']);
    expect(h.responded).toEqual(['prod']);
  });

  it('stays card-only when the call cannot speak (no call, or a tier without a voice)', async () => {
    const h = harness({ ask: () => Promise.resolve(null) });
    const outcome = await runVoiceClarify({
      request,
      ask: h.ask,
      respond: h.respond,
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('card-only');
    expect(h.responded).toEqual([]);
  });

  it('stays card-only when synthesis fails — the next utterance is not eaten', async () => {
    const h = harness({ ask: () => Promise.reject(new Error('tts down')) });
    const outcome = await runVoiceClarify({
      request,
      ask: h.ask,
      respond: h.respond,
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('card-only');
    expect(h.responded).toEqual([]);
  });

  it('never asks a question that is already resolved', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ ask: () => Promise.resolve('prod') });

    const outcome = await runVoiceClarify({
      request,
      ask: h.ask,
      respond: h.respond,
      signal: controller.signal,
    });

    expect(outcome).toBe('card-only');
    expect(h.asked).toEqual([]);
  });

  it('drops an answer that arrives after the card was answered', async () => {
    const controller = new AbortController();
    const h = harness({
      ask: () => {
        // The click lands while the user is still talking.
        controller.abort();
        return Promise.resolve('prod');
      },
    });

    const outcome = await runVoiceClarify({
      request,
      ask: h.ask,
      respond: h.respond,
      signal: controller.signal,
    });

    expect(outcome).toBe('card-only');
    expect(h.responded).toEqual([]);
  });

  it('stays card-only when the answer could not be delivered', async () => {
    const h = harness({
      ask: () => Promise.resolve('prod'),
      respond: () => Promise.reject(new Error('offline')),
    });

    const outcome = await runVoiceClarify({
      request,
      ask: h.ask,
      respond: h.respond,
      signal: new AbortController().signal,
    });

    expect(outcome).toBe('card-only');
    expect(h.responded).toEqual(['prod']);
  });
});
