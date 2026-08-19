// D22 (pi-delegation plan Phase 1, I4) — the `clarify` tool must thread
// `ctx.jobId` into `ClarifyBridge.request()` so the busy/queue lane keys off
// the job (`jobId ?? sessionId`, G1) instead of always the session. Foreground
// turns (no `ctx.jobId`) must omit the field entirely, not send `undefined`
// explicitly (some request-shape assertions elsewhere rely on `'jobId' in
// input` being false for a foreground call).

import type { ClarifyBridge, ClarifyRequestInput } from '@ethosagent/core';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createClarifyTool } from '../clarify-tool';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 10_000,
    ...overrides,
  };
}

function makeFakeBridge(): { bridge: ClarifyBridge; captured: ClarifyRequestInput[] } {
  const captured: ClarifyRequestInput[] = [];
  const bridge = {
    request: async (input: ClarifyRequestInput) => {
      captured.push(input);
      return { requestId: 'r1', answer: 'ok', source: 'user' as const };
    },
  } as unknown as ClarifyBridge;
  return { bridge, captured };
}

describe('createClarifyTool — jobId threading (D22)', () => {
  it('threads ctx.jobId into bridge.request() for a background turn', async () => {
    const { bridge, captured } = makeFakeBridge();
    const tool = createClarifyTool(bridge);

    await tool.execute({ question: 'Which database?' }, makeCtx({ jobId: 'job-1' }));

    expect(captured).toHaveLength(1);
    expect(captured[0]?.jobId).toBe('job-1');
  });

  it('omits jobId entirely for a foreground turn (no ctx.jobId)', async () => {
    const { bridge, captured } = makeFakeBridge();
    const tool = createClarifyTool(bridge);

    await tool.execute({ question: 'Which database?' }, makeCtx());

    expect(captured).toHaveLength(1);
    const first = captured[0];
    expect(first !== undefined && 'jobId' in first).toBe(false);
  });
});
