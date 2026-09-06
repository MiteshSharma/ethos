// `AgentLoop.respondToClarify` reports the `ClarifyRespondOutcome` its bridge
// returned, instead of returning `Promise<void>`.
//
// It used to drop it. Its only caller — the CLI chat presenter
// (`apps/ethos/src/commands/chat.ts`) — therefore had nothing to read, and
// redrew the prompt as if every answer had been received: an id already
// answered elsewhere, a request swept by its timeout, and a `browser_takeover`
// the answer gate refuses on this surface all looked exactly like success. The
// web had the same defect and it was fixed there first
// (`apps/web-api/src/rpc/clarify.ts`); this is the same fix one surface over.
//
// The no-bridge case is `unknown_request` rather than a resolution for the
// reason that RPC's doc comment names: an optional chain past an absent bridge
// is a success report for an answer nothing received.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../agent-loop';
import { ClarifyBridge } from '../clarify/clarify-bridge';
import { FileClarifyStore } from '../clarify/file-clarify-store';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultHookRegistry } from '../hook-registry';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

/** Never runs — every test here calls `respondToClarify` directly. */
const idleLLM: LLMProvider = {
  name: 'scripted',
  model: 'mock-model',
  maxContextTokens: 200_000,
  supportsCaching: false,
  supportsThinking: false,
  async *complete(): AsyncIterable<CompletionChunk> {
    yield { type: 'done', finishReason: 'end_turn' };
  },
  async countTokens() {
    return 1;
  },
};

function makeLoop(clarifyBridge?: ClarifyBridge): AgentLoop {
  return new AgentLoop({
    llm: idleLLM,
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
    ...(clarifyBridge ? { clarifyBridge } : {}),
  });
}

function makeBridge(): ClarifyBridge {
  return new ClarifyBridge(new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify'), {
    reconcilePollMs: 0,
  });
}

describe('AgentLoop.respondToClarify', () => {
  it('returns the bridge outcome when the answer lands', async () => {
    const bridge = makeBridge();
    const loop = makeLoop(bridge);
    let requestId = '';
    const settled = bridge.request({
      question: 'Which branch?',
      timeoutMs: 900_000,
      answerableBy: 'anyone',
      sessionId: 's1',
      surfaceType: 'cli',
      onRequestId: (id) => {
        requestId = id;
      },
    });
    bridge.registerPresenter('cli', () => {});
    await new Promise((r) => setTimeout(r, 0));

    await expect(
      loop.respondToClarify({ requestId, answer: 'main', source: 'user' }),
    ).resolves.toEqual({ resolved: true });
    await settled;
  });

  it('reports the reason when the answer lands nowhere', async () => {
    const loop = makeLoop(makeBridge());
    await expect(
      loop.respondToClarify({ requestId: 'gone', answer: 'main', source: 'user' }),
    ).resolves.toEqual({ resolved: false, reason: 'unknown_request' });
  });

  it('does not report success when no clarify bridge is wired', async () => {
    const loop = makeLoop();
    await expect(
      loop.respondToClarify({ requestId: 'r1', answer: 'main', source: 'user' }),
    ).resolves.toEqual({ resolved: false, reason: 'unknown_request' });
  });
});
