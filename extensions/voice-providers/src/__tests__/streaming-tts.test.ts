// Streaming TTS — the two providers that advertise `caps.streaming`.
//
// Before this, `StreamingTtsProvider` had zero implementations and
// `isStreamingTtsProvider()` was false for every provider in the repo, so both
// streaming branches in `VoiceSession` were dead code. These tests pin that it
// is now live for one cloud provider (`openai-tts`) and one local server
// provider (`local-tts`), and that a batch-only provider is still gated OFF.

import type {
  Logger,
  SecretsResolver,
  TtsProvider,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { isStreamingTtsProvider } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateTtsProvider } from '../conformance';
import { localTtsFactory } from '../local-tts';
import { openaiTtsFactory } from '../openai-tts';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

const noopSecrets: SecretsResolver = {
  async get() {
    return null;
  },
  async set() {},
  async delete() {},
  async list() {
    return [];
  },
};

function ctx(config: Record<string, unknown>): VoiceProviderFactoryContext {
  return { config, secrets: noopSecrets, logger: noopLogger };
}

async function* sentences(...texts: string[]): AsyncIterable<string> {
  for (const text of texts) yield text;
}

/** A response body the test pushes into, one chunk at a time. */
function pushableBody(): {
  stream: ReadableStream<Uint8Array>;
  push: (byte: number) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (byte) => controller.enqueue(new Uint8Array([byte])),
    close: () => controller.close(),
  };
}

async function collect(
  chunks: AsyncIterable<{ audio: Uint8Array; format: string }>,
): Promise<number[]> {
  const bytes: number[] = [];
  for await (const chunk of chunks) bytes.push(chunk.audio[0] ?? -1);
  return bytes;
}

describe('streaming TTS capability', () => {
  it('local-tts and openai-tts advertise caps.streaming and satisfy the type guard', () => {
    const local = localTtsFactory(ctx({}));
    const cloud = openaiTtsFactory(ctx({ apiKey: 'sk-test' }));

    for (const provider of [local, cloud] as TtsProvider[]) {
      expect(provider.caps.streaming).toBe(true);
      expect(isStreamingTtsProvider(provider)).toBe(true);
      expect(validateTtsProvider(provider)).toEqual([]);
    }
  });

  it('gates OFF a batch-only provider', () => {
    const batch: TtsProvider = {
      name: 'batch-only',
      caps: { kind: 'tts', formats: ['mp3'], contractVersion: 1 },
      synthesize: async () => ({ audio: new Uint8Array([1]), format: 'mp3' }),
    };
    expect(isStreamingTtsProvider(batch)).toBe(false);
    expect(validateTtsProvider(batch)).toEqual([]);
  });
});

describe('local-tts synthesizeStream', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('yields chunks as the body arrives, in order, before the response completes', async () => {
    const body = pushableBody();
    globalThis.fetch = (async () => new Response(body.stream)) as unknown as typeof fetch;

    const provider = localTtsFactory(ctx({}));
    const iterator = provider.synthesizeStream(sentences('Hello there.'))[Symbol.asyncIterator]();

    body.push(11);
    const first = await iterator.next();
    // Delivered while the body is still open — this is the streaming claim.
    expect(first.done).toBe(false);
    expect(first.value?.audio[0]).toBe(11);
    expect(first.value?.format).toBe('opus');

    body.push(22);
    body.close();
    expect((await iterator.next()).value?.audio[0]).toBe(22);
    expect((await iterator.next()).done).toBe(true);
  });

  it('issues one request per sentence and keeps audio in sentence order', async () => {
    let byte = 0;
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
      byte += 1;
      return new Response(new Uint8Array([byte]).buffer);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = localTtsFactory(ctx({ voice: 'af_bella' }));
    const bytes = await collect(provider.synthesizeStream(sentences('One.', 'Two.', 'Three.')));

    expect(bytes).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string).input as string),
    ).toEqual(['One.', 'Two.', 'Three.']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).voice).toBe('af_bella');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8880/v1/audio/speech');
  });

  it('skips blank text without calling the server', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]).buffer));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const bytes = await collect(localTtsFactory(ctx({})).synthesizeStream(sentences('   ', '')));

    expect(bytes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with the server body on a non-2xx, like the batch method', async () => {
    globalThis.fetch = (async () =>
      new Response('model not found', { status: 404 })) as unknown as typeof fetch;

    await expect(
      collect(localTtsFactory(ctx({})).synthesizeStream(sentences('Hello.'))),
    ).rejects.toThrow('Local TTS failed (404): model not found');
  });

  it('a bodyless response degrades to zero chunks rather than throwing', async () => {
    globalThis.fetch = (async () => new Response(null)) as unknown as typeof fetch;

    expect(await collect(localTtsFactory(ctx({})).synthesizeStream(sentences('Hello.')))).toEqual(
      [],
    );
  });

  it('the batch synthesize method still works unchanged', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([5]).buffer));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await localTtsFactory(ctx({})).synthesize('Hello.');

    expect(Array.from(result.audio)).toEqual([5]);
    expect(result.format).toBe('opus');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('openai-tts synthesizeStream', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('streams over the cloud endpoint with the bearer key and per-call voice', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(new Uint8Array([3, 4]).buffer),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = openaiTtsFactory(ctx({ apiKey: 'sk-test' }));
    const bytes = await collect(
      provider.synthesizeStream(sentences('Hello.'), { voice: 'nova', speed: 1.25 }),
    );

    expect(bytes).toEqual([3]); // one chunk, first byte
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const payload = JSON.parse(init.body as string);
    expect(payload.voice).toBe('nova');
    expect(payload.speed).toBe(1.25);
  });

  it('aborts the in-flight request when the caller signals (barge-in)', async () => {
    const controller = new AbortController();
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      init.signal?.throwIfAborted();
      return new Response(new Uint8Array([1]).buffer);
    }) as unknown as typeof fetch;

    const provider = openaiTtsFactory(ctx({ apiKey: 'sk-test' }));
    controller.abort();

    await expect(
      collect(provider.synthesizeStream(sentences('Hello.'), { signal: controller.signal })),
    ).rejects.toThrow();
  });
});
