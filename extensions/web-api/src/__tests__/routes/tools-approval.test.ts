import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLoop } from '@ethosagent/core';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import { makeStubAgentLoop, makeStubPersonalityRegistry } from '../test-helpers';

// End-to-end exercise of the 26.3c contract:
//   1. The agent loop's before_tool_call hook fires.
//   2. The web hook surfaces a tool.approval_required event over the same
//      pipeline that streams chat (verified via the SSE replay buffer).
//   3. A separate /rpc/tools/approve call resolves the pending Promise.
//   4. The hook returns null, the loop runs the tool unchanged.

describe('tools.approve / tools.deny — full inversion loop', () => {
  let dir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookieHeader: string;
  let loop: AgentLoop;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-tools-approval-'));
    store = new SQLiteSessionStore(':memory:');
    loop = makeStubAgentLoop();
    app = createWebApi({
      dataDir: dir,
      sessionStore: store,
      agentLoop: loop,
      personalities: makeStubPersonalityRegistry(),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      // Predicate that flags every terminal call as dangerous so we don't
      // need to fold real `checkCommand` rules into the test.
      dangerPredicate: (p) =>
        p.toolName === 'terminal' ? 'every terminal call requires approval (test rule)' : null,
    }).app;

    // Auth handshake → cookie used for every subsequent request.
    const tokens = new WebTokenRepository({ dataDir: dir });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    cookieHeader = setCookie.split(/;\s*/)[0] ?? '';
    expect(cookieHeader).toMatch(/ethos_auth=/);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('approve resolves the awaiting hook with null (allow)', async () => {
    // Fire the hook directly against the loop's registry — same path the
    // agent loop takes when it hits a tool_use block.
    const hookFire = loop.hooks.fireModifying('before_tool_call', {
      sessionId: 'sess_demo',
      toolCallId: 'tc_demo',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
    } satisfies BeforeToolCallPayload);

    const approvalId = await waitForPendingApproval(app, cookieHeader, 'sess_demo');

    const approve = await app.request('/rpc/tools/approve', {
      method: 'POST',
      headers: rpcHeaders(cookieHeader),
      body: JSON.stringify({
        json: { approvalId, clientId: 'tab-A', scope: 'once' },
      }),
    });
    expect(approve.status).toBe(200);

    const result: Partial<BeforeToolCallResult> = await hookFire;
    // Modifying hook merges {} when no handler returns anything — so an
    // "allow" surface as the empty object (no `error` key set).
    expect(result.error).toBeUndefined();
  });

  it('deny resolves the hook with { error: <reason> }', async () => {
    const hookFire = loop.hooks.fireModifying('before_tool_call', {
      sessionId: 'sess_deny',
      toolCallId: 'tc_deny',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
    } satisfies BeforeToolCallPayload);

    const approvalId = await waitForPendingApproval(app, cookieHeader, 'sess_deny');

    const deny = await app.request('/rpc/tools/deny', {
      method: 'POST',
      headers: rpcHeaders(cookieHeader),
      body: JSON.stringify({
        json: { approvalId, clientId: 'tab-A', reason: 'too risky' },
      }),
    });
    expect(deny.status).toBe(200);

    const result: Partial<BeforeToolCallResult> = await hookFire;
    expect(result.error).toBe('too risky');
  });

  it('approving an unknown approvalId returns INVALID_INPUT', async () => {
    const res = await app.request('/rpc/tools/approve', {
      method: 'POST',
      headers: rpcHeaders(cookieHeader),
      body: JSON.stringify({
        json: { approvalId: 'does-not-exist', clientId: 'tab-A', scope: 'once' },
      }),
    });
    expect(res.status).toBe(400);
    // oRPC's wire shape wraps the error under `json` with the code surfaced
    // verbatim. The interceptor in routes/rpc.ts is the bit that translates
    // EthosError into this — losing it would silently 500.
    const body = (await res.json()) as { json: { code: string; status: number } };
    expect(body.json.code).toBe('INVALID_INPUT');
    expect(body.json.status).toBe(400);
  });
});

function rpcHeaders(cookieHeader: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    cookie: cookieHeader,
    origin: 'http://localhost:3000',
  };
}

/**
 * Polls the SSE stream for a `tool.approval_required` event and returns the
 * approvalId. The hook calls happen in another microtask so we need to
 * attach a reader before yielding back to the test body.
 */
async function waitForPendingApproval(
  app: ReturnType<typeof createWebApi>['app'],
  cookieHeader: string,
  sessionId: string,
  timeoutMs = 1000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.request(`/sse/sessions/${sessionId}`, {
      headers: { cookie: cookieHeader },
    });
    if (!res.body) {
      await sleep(10);
      continue;
    }
    const approvalId = await readApprovalIdFromStream(res.body);
    if (approvalId) return approvalId;
    await sleep(10);
  }
  throw new Error(`waitForPendingApproval timed out for ${sessionId}`);
}

async function readApprovalIdFromStream(
  body: ReadableStream<Uint8Array>,
  timeoutMs = 200,
): Promise<string | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      const readPromise = reader.read();
      const timeout = new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 50),
      );
      const { done, value } = (await Promise.race([readPromise, timeout])) as {
        done: boolean;
        value: Uint8Array | undefined;
      };
      if (value) buffer += decoder.decode(value);
      const eventBlocks = buffer.split('\n\n');
      buffer = eventBlocks.pop() ?? '';
      for (const block of eventBlocks) {
        const dataLine = block
          .split('\n')
          .find((l) => l.startsWith('data:'))
          ?.slice('data:'.length)
          .trim();
        if (!dataLine) continue;
        try {
          const event = JSON.parse(dataLine) as {
            type: string;
            request?: { approvalId: string };
          };
          if (event.type === 'tool.approval_required' && event.request) {
            return event.request.approvalId;
          }
        } catch {
          // Non-JSON SSE chunk (keepalive comment etc.); skip.
        }
      }
      if (done) return null;
    }
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
