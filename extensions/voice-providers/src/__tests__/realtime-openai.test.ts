import { afterEach, describe, expect, it } from 'vitest';
import { createFakeRealtimeServer } from '../realtime-conformance';
import { OpenAiRealtimeProvider } from '../realtime-openai';

// The shared 11-check contract suite runs from `realtime-contract.test.ts`,
// which drives every REGISTERED provider. What stays here is this provider's
// own wire detail — the part no other provider shares.

describe('openai-realtime wire details', () => {
  it('opens a model-pinned socket with the key in the Authorization header', async () => {
    const server = createFakeRealtimeServer();
    const provider = new OpenAiRealtimeProvider({
      apiKey: 'sk-test',
      model: 'gpt-realtime',
      socketFactory: server.factory,
    });
    const session = await provider.open({ instructions: 'be brief' });

    expect(server.init?.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime');
    expect(server.init?.headers?.Authorization).toBe('Bearer sk-test');
    await session.close();
  });

  it('sends instructions, voice, language and tools in the session configuration', async () => {
    const server = createFakeRealtimeServer();
    const provider = new OpenAiRealtimeProvider({ apiKey: 'k', socketFactory: server.factory });
    const session = await provider.open({
      instructions: 'You are Ethos.',
      voice: 'marin',
      language: 'en-GB',
      tools: [
        { name: 'agent_consult', description: 'ask the agent', parameters: { type: 'object' } },
      ],
    });

    const update = server.sent[0] as {
      type?: string;
      session?: {
        instructions?: string;
        audio?: {
          input?: { transcription?: { language?: string }; format?: { rate?: number } };
          output?: { voice?: string; format?: { rate?: number } };
        };
        tools?: Array<{ type?: string; name?: string }>;
      };
    };
    expect(update.type).toBe('session.update');
    expect(update.session?.instructions).toBe('You are Ethos.');
    expect(update.session?.audio?.output?.voice).toBe('marin');
    expect(update.session?.audio?.input?.transcription?.language).toBe('en-GB');
    expect(update.session?.audio?.input?.format?.rate).toBe(24_000);
    expect(update.session?.audio?.output?.format?.rate).toBe(24_000);
    expect(update.session?.tools).toEqual([
      {
        type: 'function',
        name: 'agent_consult',
        description: 'ask the agent',
        parameters: { type: 'object' },
      },
    ]);
    await session.close();
  });

  it('say() asks for a spoken response pinned to the supplied text', async () => {
    const server = createFakeRealtimeServer();
    const provider = new OpenAiRealtimeProvider({ apiKey: 'k', socketFactory: server.factory });
    const session = await provider.open({ instructions: 'x' });
    server.deliver({ type: 'session.created', session: { id: 's' } });

    await session.say?.('One moment while I look that up.');

    const frame = server.sent.at(-1) as {
      type?: string;
      response?: { instructions?: string; output_modalities?: string[] };
    };
    expect(frame.type).toBe('response.create');
    expect(frame.response?.output_modalities).toEqual(['audio']);
    expect(frame.response?.instructions).toContain('One moment while I look that up.');
    await session.close();
  });

  it('reports an unparseable tool-call argument list instead of calling with empty args', async () => {
    const server = createFakeRealtimeServer();
    const provider = new OpenAiRealtimeProvider({ apiKey: 'k', socketFactory: server.factory });
    const session = await provider.open({ instructions: 'x' });
    const seen: string[] = [];
    const drain = (async () => {
      for await (const event of session.events) seen.push(event.type);
    })();

    server.deliver({ type: 'session.created', session: { id: 's' } });
    server.deliver({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'lookup',
      arguments: '{not json',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.close();
    await drain;

    expect(seen).toContain('error');
    expect(seen).not.toContain('tool_call');
  });

  it('rejects open() when the socket fails before it is established', async () => {
    const provider = new OpenAiRealtimeProvider({
      apiKey: 'k',
      socketFactory: (_init, handlers) => {
        queueMicrotask(() => handlers.onError('DNS failure'));
        return { send: () => {}, close: () => {} };
      },
    });
    await expect(provider.open({ instructions: 'x' })).rejects.toThrow(/DNS failure/);
  });
});

describe('openai-realtime ephemeral token', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('mints a client secret against the realtime sessions endpoint', async () => {
    let seenUrl = '';
    let seenBody: unknown;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ value: 'ek_abc', expires_at: 1_800_000_000 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const provider = new OpenAiRealtimeProvider({ apiKey: 'sk-test', model: 'gpt-realtime' });
    const token = await provider.mintEphemeralToken({ instructions: 'hi' });

    expect(seenUrl).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect((seenBody as { session?: { instructions?: string } }).session?.instructions).toBe('hi');
    expect(token).toEqual({
      token: 'ek_abc',
      expiresAt: 1_800_000_000_000,
      url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime',
      model: 'gpt-realtime',
    });
  });

  it('reads the older nested client_secret shape', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ client_secret: { value: 'ek_old', expires_at: 1_700_000_000 } }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const provider = new OpenAiRealtimeProvider({ apiKey: 'k' });
    const token = await provider.mintEphemeralToken({ instructions: 'hi' });
    expect(token.token).toBe('ek_old');
    expect(token.expiresAt).toBe(1_700_000_000_000);
  });

  it('throws with the server body on a non-2xx', async () => {
    globalThis.fetch = (async () =>
      new Response('no realtime access', { status: 403 })) as unknown as typeof fetch;

    const provider = new OpenAiRealtimeProvider({ apiKey: 'k' });
    await expect(provider.mintEphemeralToken({ instructions: 'hi' })).rejects.toThrow(
      /403.*no realtime access/,
    );
  });
});
