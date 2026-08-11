import type { AgentEvent } from '@ethosagent/core';
import { SQLiteSessionStore, SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompletionsRepository } from '../../features/completions/repository';
import { CompletionsService } from '../../features/completions/service';
import { openAiRoutes } from '../../routes/openai';
import type { PersonalitiesService } from '../../services/personalities.service';
import { makeStubAgentLoop } from '../test-helpers';

const KNOWN_PERSONALITIES = ['engineer', 'researcher'];

function makeStubPersonalitiesService(ids: string[] = KNOWN_PERSONALITIES): PersonalitiesService {
  return {
    list() {
      return {
        items: ids.map((id) => ({ id }) as never),
        nextCursor: null,
        defaultId: ids[0] ?? 'ethos',
      };
    },
  } as unknown as PersonalitiesService;
}

interface SetupOptions {
  events?: AgentEvent[];
  onRun?: (input: string, opts: unknown) => void;
}

async function setup(opts: SetupOptions = {}) {
  const apiKeys = new SqliteApiKeyStore(':memory:');
  const sessions = new SQLiteSessionStore(':memory:');
  const created = await apiKeys.create({ name: 'cursor', scopes: ['chat'] });
  const loop = makeStubAgentLoop({
    events: opts.events ?? [{ type: 'done', text: '', turnCount: 1 }],
    ...(opts.onRun ? { onRun: opts.onRun } : {}),
  });
  const completions = new CompletionsService({
    loop,
    sessions: new CompletionsRepository(sessions),
    defaults: { model: 'claude-test', provider: 'anthropic' },
  });
  const app = openAiRoutes({
    apiKeys,
    personalities: makeStubPersonalitiesService(),
    completions,
  });
  return {
    app,
    apiKeys,
    apiKeyId: created.record.id,
    sessions,
    secret: created.secret,
    bearer: { Authorization: `Bearer ${created.secret}` },
  };
}

describe('POST /v1/chat/completions', () => {
  let teardown: Array<() => void> = [];
  afterEach(() => {
    for (const fn of teardown) fn();
    teardown = [];
  });
  beforeEach(() => {});

  async function withSetup(opts?: SetupOptions) {
    const ctx = await setup(opts);
    teardown.push(
      () => ctx.apiKeys.close(),
      () => ctx.sessions.close(),
    );
    return ctx;
  }

  describe('rejection paths', () => {
    it('returns 400 with OpenAI envelope when body is not JSON', async () => {
      const { app, bearer } = await withSetup();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: 'not json',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; type: string } };
      expect(body.error.code).toBe('invalid_request_body');
      expect(body.error.type).toBe('invalid_request_error');
    });

    it('returns 400 when model is missing', async () => {
      const { app, bearer } = await withSetup();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when `tools` is provided (C1 scope)', async () => {
      const { app, bearer } = await withSetup();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ type: 'function', function: { name: 'foo' } }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('client_tools_not_implemented');
    });

    it('returns 400 when messages include role: "tool" (C1 scope)', async () => {
      const { app, bearer } = await withSetup();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [
            { role: 'user', content: 'q' },
            { role: 'tool', content: 'r', tool_call_id: 'call_1' },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('client_tools_not_implemented');
    });

    it('returns 400 when model starts with `team:` (W1 scope)', async () => {
      const { app, bearer } = await withSetup();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'team:analytics',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('team_routing_not_implemented');
    });

    it('returns 404 model_not_found for an unknown personality', async () => {
      const { app, bearer } = await withSetup();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'never-seen',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('model_not_found');
    });

    it('returns 401 when no bearer is supplied', async () => {
      const { app } = await withSetup();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 when messages include role: "system"', async () => {
      const { app, bearer } = await withSetup();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [
            { role: 'system', content: 'you are X' },
            { role: 'user', content: 'hi' },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('system_messages_not_supported');
    });
  });

  describe('non-streaming success', () => {
    it('returns a full ChatCompletion for a known personality', async () => {
      const { app, bearer } = await withSetup({
        events: [
          { type: 'text_delta', text: 'hello' },
          { type: 'usage', inputTokens: 3, outputTokens: 1, estimatedCostUsd: 0 },
          { type: 'done', text: 'hello', turnCount: 1 },
        ],
      });
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        choices: Array<{ message: { content: string }; finish_reason: string }>;
        usage: { total_tokens: number };
      };
      expect(body.choices[0]?.message.content).toBe('hello');
      expect(body.choices[0]?.finish_reason).toBe('stop');
      expect(body.usage.total_tokens).toBe(4);
    });

    it('reports finish_reason "length" when the turn was halted early', async () => {
      const { app, bearer } = await withSetup({
        events: [
          { type: 'text_delta', text: 'partial' },
          {
            type: 'halt',
            kind: 'budget',
            rule: 'tool-budget',
            count: 12,
            message: 'tool budget exhausted',
          },
          { type: 'done', text: 'partial', turnCount: 1 },
        ],
      });
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        choices: Array<{ message: { content: string }; finish_reason: string }>;
      };
      expect(body.choices[0]?.message.content).toBe('partial');
      expect(body.choices[0]?.finish_reason).toBe('length');
    });

    it('accepts every model id advertised by GET /v1/models', async () => {
      // Regression guard: the catalog must never offer a selection that
      // `POST /v1/chat/completions` rejects.
      const { app, bearer } = await withSetup();
      const listRes = await app.request('/models', { headers: bearer });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { data: Array<{ id: string }> };
      expect(list.data.length).toBeGreaterThan(0);
      for (const model of list.data) {
        const res = await app.request('/chat/completions', {
          method: 'POST',
          headers: { ...bearer, 'content-type': 'application/json' },
          body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect([model.id, res.status]).toEqual([model.id, 200]);
      }
    });

    it('accepts `ethos-default` (no personalityId on the loop)', async () => {
      let capturedOpts: { personalityId?: string } | null = null;
      const { app, bearer } = await withSetup({
        events: [{ type: 'done', text: '', turnCount: 1 }],
        onRun: (_i, o) => {
          capturedOpts = o as typeof capturedOpts;
        },
      });
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'ethos-default',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      const o = capturedOpts as unknown as { personalityId?: string };
      expect(o?.personalityId).toBeUndefined();
    });

    it('accepts array content parts with text-only content', async () => {
      let capturedInput: string | null = null;
      const { app, bearer } = await withSetup({
        events: [
          { type: 'text_delta', text: 'hi' },
          { type: 'done', text: 'hi', turnCount: 1 },
        ],
        onRun: (input) => {
          capturedInput = input;
        },
      });
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'hello' },
                { type: 'text', text: 'world' },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      expect(capturedInput).toBe('hello\nworld');
    });

    it('sets x-ethos-warning for image_url content parts', async () => {
      const { app, bearer } = await withSetup({
        events: [
          { type: 'text_delta', text: 'ok' },
          { type: 'done', text: 'ok', turnCount: 1 },
        ],
      });
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'describe this' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-ethos-warning')).toMatch(/image_url/i);
    });

    it('forwards temperature, top_p, max_tokens, and seed to the loop', async () => {
      let capturedOpts: Record<string, unknown> | null = null;
      const { app, bearer } = await withSetup({
        events: [{ type: 'done', text: '', turnCount: 1 }],
        onRun: (_i, o) => {
          capturedOpts = o as Record<string, unknown>;
        },
      });
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 100,
          seed: 42,
        }),
      });
      expect(res.status).toBe(200);
      expect(capturedOpts).toMatchObject({
        temperature: 0.7,
        topP: 0.9,
        maxCompletionTokens: 100,
        seed: 42,
      });
    });

    it('threads X-Ethos-Session into the loop session key (with `openai:` prefix)', async () => {
      let capturedOpts: { sessionKey?: string } | null = null;
      const { app, bearer, apiKeyId } = await withSetup({
        events: [{ type: 'done', text: '', turnCount: 1 }],
        onRun: (_i, o) => {
          capturedOpts = o as typeof capturedOpts;
        },
      });
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: {
          ...bearer,
          'content-type': 'application/json',
          'X-Ethos-Session': 'my-app:42',
        },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      const o = capturedOpts as unknown as { sessionKey?: string };
      expect(o?.sessionKey).toBe(`openai:${apiKeyId}:my-app:42`);
    });
  });

  describe('streaming', () => {
    async function collectSse(body: ReadableStream<Uint8Array> | null): Promise<string[]> {
      if (!body) throw new Error('no body');
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const frames: string[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (line.startsWith('data: ')) frames.push(line.slice('data: '.length));
        }
      }
      if (buf.trim().startsWith('data: ')) frames.push(buf.trim().slice('data: '.length));
      return frames;
    }

    it('streams chunks ending in [DONE]', async () => {
      const { app, bearer } = await withSetup({
        events: [
          { type: 'text_delta', text: 'foo' },
          { type: 'text_delta', text: 'bar' },
          { type: 'done', text: 'foobar', turnCount: 1 },
        ],
      });
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const frames = await collectSse(res.body);
      expect(frames[frames.length - 1]).toBe('[DONE]');
      const dataChunks = frames.slice(0, -1).map(
        (f) =>
          JSON.parse(f) as {
            choices: Array<{
              delta: { content?: string; role?: string };
              finish_reason: string | null;
            }>;
          },
      );
      // First role-delta + content
      expect(dataChunks[0]?.choices[0]?.delta).toEqual({ role: 'assistant', content: 'foo' });
      expect(dataChunks[1]?.choices[0]?.delta).toEqual({ content: 'bar' });
      // Final finish-reason chunk
      expect(dataChunks[dataChunks.length - 1]?.choices[0]?.finish_reason).toBe('stop');
    });

    it('terminates with finish_reason "length" when the turn was halted early', async () => {
      const { app, bearer } = await withSetup({
        events: [
          { type: 'text_delta', text: 'partial' },
          { type: 'halt', kind: 'watcher', rule: 'loop-guard', message: 'paused' },
          { type: 'done', text: 'partial', turnCount: 1 },
        ],
      });
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      const frames = await collectSse(res.body);
      const finalRaw = frames[frames.length - 2];
      if (!finalRaw) throw new Error('expected a terminal chunk before [DONE]');
      const final = JSON.parse(finalRaw) as {
        choices: Array<{ delta: object; finish_reason: string | null }>;
      };
      expect(final.choices[0]?.finish_reason).toBe('length');
    });

    it('emits a usage chunk when stream_options.include_usage is set', async () => {
      const { app, bearer } = await withSetup({
        events: [
          { type: 'text_delta', text: 'ok' },
          { type: 'usage', inputTokens: 5, outputTokens: 2, estimatedCostUsd: 0 },
          { type: 'done', text: 'ok', turnCount: 1 },
        ],
      });
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      const frames = await collectSse(res.body);
      const usageChunkRaw = frames[frames.length - 2];
      if (!usageChunkRaw) throw new Error('expected a usage chunk before [DONE]');
      const usageChunk = JSON.parse(usageChunkRaw) as {
        choices: unknown[];
        usage?: { total_tokens: number };
      };
      expect(usageChunk.choices).toEqual([]);
      expect(usageChunk.usage?.total_tokens).toBe(7);
    });
  });

  // A session's personality is bound at creation and immutable. Stateful mode
  // is the one place an HTTP client restates both on every call — the session
  // in `X-Ethos-Session`, the personality in `model` — so it is the one place
  // they can disagree. That must read as a client error, not a 500 and not a
  // stream that dies mid-flight.
  describe('personality binding on a pinned session', () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      apiCallCount: 0,
      compactionCount: 0,
    };

    async function withBoundSession() {
      const ctx = await withSetup();
      await ctx.sessions.createSession({
        key: `openai:${ctx.apiKeyId}:pinned`,
        platform: 'openai',
        model: 'claude-test',
        provider: 'anthropic',
        personalityId: 'engineer',
        usage,
      });
      return ctx;
    }

    it('returns 400 personality_locked on the non-streaming path', async () => {
      const { app, bearer } = await withBoundSession();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: {
          ...bearer,
          'content-type': 'application/json',
          'X-Ethos-Session': 'pinned',
        },
        body: JSON.stringify({
          model: 'researcher',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; type: string; message: string } };
      expect(body.error.code).toBe('personality_locked');
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toContain('engineer');
      expect(body.error.message).toContain('researcher');
    });

    it('returns 400 personality_locked on the streaming path (no SSE opened)', async () => {
      const { app, bearer } = await withBoundSession();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: {
          ...bearer,
          'content-type': 'application/json',
          'X-Ethos-Session': 'pinned',
        },
        body: JSON.stringify({
          model: 'researcher',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).not.toMatch(/text\/event-stream/);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('personality_locked');
      expect(body.error.message).toContain('engineer');
    });

    it('proceeds when the pinned session and the requested personality agree', async () => {
      const { app, bearer } = await withBoundSession();
      const res = await app.request('/chat/completions', {
        method: 'POST',
        headers: {
          ...bearer,
          'content-type': 'application/json',
          'X-Ethos-Session': 'pinned',
        },
        body: JSON.stringify({
          model: 'engineer',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
    });
  });
});
