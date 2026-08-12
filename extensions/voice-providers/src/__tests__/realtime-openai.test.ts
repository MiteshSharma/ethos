import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createFakeRealtimeServer,
  REALTIME_CONTRACT_CHECKS,
  type RealtimeConformanceTarget,
  runRealtimeContractSuite,
} from '../realtime-conformance';
import { OpenAiRealtimeProvider } from '../realtime-openai';

const target: RealtimeConformanceTarget = {
  label: 'openai-realtime',
  createProvider: (socketFactory) =>
    new OpenAiRealtimeProvider({ apiKey: 'test-key', socketFactory }),
  confirmSession: [{ type: 'session.created', session: { id: 'sess_1', model: 'gpt-realtime' } }],
  audioDelta: (pcmBase64) => ({ type: 'response.output_audio.delta', delta: pcmBase64 }),
  userTranscript: {
    partial: { type: 'conversation.item.input_audio_transcription.delta', delta: 'what is ' },
    partialText: 'what is ',
    final: {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'what is the weather',
    },
    finalText: 'what is the weather',
  },
  assistantTranscript: {
    partial: { type: 'response.output_audio_transcript.delta', delta: 'it is ' },
    partialText: 'it is ',
    final: { type: 'response.output_audio_transcript.done', transcript: 'it is sunny' },
    finalText: 'it is sunny',
  },
  toolCall: (callId, name, args) => ({
    type: 'response.function_call_arguments.done',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  }),
  speechStarted: { type: 'input_audio_buffer.speech_started' },
  providerError: {
    frame: { type: 'error', error: { message: 'rate limited', code: 'rate_limit_exceeded' } },
    error: 'rate limited',
    code: 'rate_limit_exceeded',
  },
  expectAudioWrite: (sent, pcm) => {
    if (sent.length !== 1) return [`expected 1 audio frame, got ${sent.length}`];
    const frame = sent[0] as { type?: string; audio?: string };
    const errors: string[] = [];
    if (frame.type !== 'input_audio_buffer.append') {
      errors.push(`audio frame type was "${frame.type}"`);
    }
    if (frame.audio !== Buffer.from(pcm).toString('base64')) {
      errors.push('audio frame did not carry the base64 of the supplied PCM');
    }
    return errors;
  },
  expectToolResultWrite: (sent, callId, output) => {
    if (sent.length !== 2)
      return [`expected 2 frames (item + response.create), got ${sent.length}`];
    const errors: string[] = [];
    const create = sent[0] as {
      type?: string;
      item?: { type?: string; call_id?: string; output?: string };
    };
    if (create.type !== 'conversation.item.create') errors.push(`frame 0 was "${create.type}"`);
    if (create.item?.type !== 'function_call_output') {
      errors.push(`item type was "${create.item?.type}"`);
    }
    if (create.item?.call_id !== callId) errors.push(`item call_id was "${create.item?.call_id}"`);
    if (create.item?.output !== output) errors.push(`item output was "${create.item?.output}"`);
    if ((sent[1] as { type?: string }).type !== 'response.create') {
      errors.push('sendToolResult did not ask the model to resume');
    }
    return errors;
  },
  expectInterruptWrite: (sent) => {
    if (sent.length !== 1) return [`expected 1 cancel frame, got ${sent.length}`];
    const frame = sent[0] as { type?: string };
    return frame.type === 'response.cancel' ? [] : [`cancel frame was "${frame.type}"`];
  },
};

describe('openai-realtime — shared realtime contract suite', () => {
  let results: Map<string, string[]>;

  beforeAll(async () => {
    const checks = await runRealtimeContractSuite(target);
    results = new Map(checks.map((check) => [check.name, check.errors]));
  });

  for (const name of REALTIME_CONTRACT_CHECKS) {
    it(name, () => {
      expect(results.get(name) ?? ['the check did not run']).toEqual([]);
    });
  }
});

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
