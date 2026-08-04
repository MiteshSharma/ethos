import type {
  BeforeToolCallPayload,
  CompletionChunk,
  LLMProvider,
  Message,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createDangerPredicate } from '../danger-predicate';
import { createSmartApprover } from '../smart-approver';

function payload(toolName: string, args: unknown): BeforeToolCallPayload {
  return { sessionId: 's', toolCallId: 'tc', toolName, args };
}

/** Provider whose reply is chosen by inspecting the rendered call. */
function makeProvider(reply: (prompt: string) => string): {
  provider: LLMProvider;
  prompts: string[];
} {
  const prompts: string[] = [];
  const provider: LLMProvider = {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      const prompt = messages.map((m) => String(m.content)).join('\n');
      prompts.push(prompt);
      yield { type: 'text_delta', text: reply(prompt) };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
  return { provider, prompts };
}

describe('createSmartApprover', () => {
  it('denies a destructive command and approves a benign one', async () => {
    const { provider, prompts } = makeProvider((p) =>
      p.includes('rm -rf /')
        ? '{"decision":"deny","reason":"wipes the filesystem"}'
        : '{"decision":"approve","reason":"read-only listing"}',
    );
    const approve = createSmartApprover({ getProvider: async () => provider, model: 'm' });

    const denied = await approve(payload('shell', { command: 'rm -rf /' }), 'flagged');
    const allowed = await approve(payload('shell', { command: 'ls' }), 'flagged');

    expect(denied).toEqual({ decision: 'deny', reason: 'wipes the filesystem' });
    expect(allowed).toEqual({ decision: 'approve', reason: 'read-only listing' });
    expect(prompts).toHaveLength(2);
  });

  it('scopes the verdict cache to the exact args, not the tool name', async () => {
    let calls = 0;
    const { provider } = makeProvider(() => {
      calls++;
      return '{"decision":"approve","reason":"scoped build artifact"}';
    });
    const approve = createSmartApprover({ getProvider: async () => provider, model: 'm' });

    await approve(payload('shell', { command: 'rm -rf ./build' }), 'flagged');
    await approve(payload('shell', { command: 'rm -rf ./src' }), 'flagged');

    // An approval for ./build must never short-circuit ./src.
    expect(calls).toBe(2);
  });

  it('reuses a cached verdict for an identical call (key order independent)', async () => {
    let calls = 0;
    const { provider } = makeProvider(() => {
      calls++;
      return '{"decision":"approve","reason":"fine"}';
    });
    const approve = createSmartApprover({ getProvider: async () => provider, model: 'm' });

    await approve(payload('shell', { a: 1, b: 2 }), 'flagged');
    await approve(payload('shell', { b: 2, a: 1 }), 'flagged');

    expect(calls).toBe(1);
  });

  it('never constructs the provider unless a call reaches the reviewer', async () => {
    let constructed = 0;
    const { provider } = makeProvider(() => '{"decision":"approve","reason":"ok"}');
    const approve = createSmartApprover({
      getProvider: async () => {
        constructed++;
        return provider;
      },
      model: 'm',
    });

    // Not invoked yet — a `manual` / `off` personality never pays for this.
    expect(constructed).toBe(0);
    await approve(payload('shell', { command: 'ls' }), 'flagged');
    expect(constructed).toBe(1);
  });

  it('fails closed to ask when the provider throws', async () => {
    const approve = createSmartApprover({
      getProvider: async () => {
        throw new Error('no api key');
      },
      model: 'm',
    });

    const verdict = await approve(payload('shell', { command: 'ls' }), 'flagged');
    expect(verdict.decision).toBe('ask');
    expect(verdict.reason).toMatch(/no api key/);
  });

  it('fails closed to ask when the stream throws mid-response', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      model: 'stub-model',
      maxContextTokens: 100_000,
      supportsCaching: false,
      supportsThinking: false,
      // biome-ignore lint/correctness/useYield: the throw is the behaviour under test
      async *complete(): AsyncIterable<CompletionChunk> {
        throw new Error('stream exploded');
      },
      async countTokens() {
        return 1;
      },
    };
    const approve = createSmartApprover({ getProvider: async () => provider, model: 'm' });

    const verdict = await approve(payload('shell', { command: 'ls' }), 'flagged');
    expect(verdict.decision).toBe('ask');
    expect(verdict.reason).toMatch(/stream exploded/);
  });

  it('fails closed to ask when the reviewer times out', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      model: 'stub-model',
      maxContextTokens: 100_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(): AsyncIterable<CompletionChunk> {
        await new Promise((r) => setTimeout(r, 200));
        yield { type: 'text_delta', text: '{"decision":"approve","reason":"too late"}' };
      },
      async countTokens() {
        return 1;
      },
    };
    const approve = createSmartApprover({
      getProvider: async () => provider,
      model: 'm',
      timeoutMs: 10,
    });

    const verdict = await approve(payload('shell', { command: 'ls' }), 'flagged');
    expect(verdict.decision).toBe('ask');
  });

  it('fails closed to ask on an unparseable response, and does not cache it', async () => {
    let calls = 0;
    const { provider } = makeProvider(() => {
      calls++;
      return 'sure, go ahead!';
    });
    const approve = createSmartApprover({ getProvider: async () => provider, model: 'm' });

    expect((await approve(payload('shell', { command: 'ls' }), 'flagged')).decision).toBe('ask');
    expect((await approve(payload('shell', { command: 'ls' }), 'flagged')).decision).toBe('ask');
    // A failure verdict must not stick to the call.
    expect(calls).toBe(2);
  });

  it('a throwing approver does NOT let the tool execute (predicate still flags)', async () => {
    // fireModifying is fail-OPEN on handler throw, so an approver that
    // propagated would let the dangerous call run. Assert the predicate still
    // returns a reason rather than null.
    const approve = createSmartApprover({
      getProvider: async () => {
        throw new Error('boom');
      },
      model: 'm',
    });
    const pred = createDangerPredicate({
      alwaysAsk: ['email_send'],
      getPersonality: () => ({ id: 'p', name: 'P', safety: { approvalMode: 'smart' } }),
      smartApprove: approve,
    });

    await expect(pred(payload('email_send', { to: 'a@b' }))).resolves.toMatch(/explicit approval/);
  });
});
