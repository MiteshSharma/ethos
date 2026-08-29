import type { SttAudio } from '@ethosagent/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  audioFilePart,
  baseMimeType,
  synthesizeOpenAiCompat,
  transcribeOpenAiCompat,
} from '../openai-compat';

/** A tiny in-memory utterance. No temp file: the transport takes bytes. */
function audio(mimeType?: string): SttAudio {
  return { data: new Uint8Array([1, 2, 3, 4]), ...(mimeType ? { mimeType } : {}) };
}

describe('openai-compat shared transport', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('audioFilePart', () => {
    it.each([
      ['audio/webm', 'audio.webm', 'audio/webm'],
      ['audio/wav', 'audio.wav', 'audio/wav'],
      ['audio/mpeg', 'audio.mp3', 'audio/mpeg'],
      ['audio/ogg', 'audio.ogg', 'audio/ogg'],
    ])('maps %s to %s', (mime, filename, contentType) => {
      expect(audioFilePart(mime)).toEqual({ filename, contentType });
    });

    it('strips codec parameters — MediaRecorder reports audio/webm;codecs=opus', () => {
      expect(baseMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
      expect(audioFilePart('audio/webm;codecs=opus')).toEqual({
        filename: 'audio.webm',
        contentType: 'audio/webm',
      });
    });

    it('falls back to octet-stream for an unknown or absent MIME', () => {
      const fallback = { filename: 'audio', contentType: 'application/octet-stream' };
      expect(audioFilePart('audio/x-nonsense')).toEqual(fallback);
      expect(audioFilePart(undefined)).toEqual(fallback);
    });
  });

  describe('transcribeOpenAiCompat', () => {
    it('POSTs multipart to {baseUrl}/audio/transcriptions with file + model', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) =>
          new Response(JSON.stringify({ text: 'hi there' })),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const text = await transcribeOpenAiCompat({
        baseUrl: 'http://localhost:8000/v1',
        model: 'whisper-large-v3',
        audio: audio('audio/ogg'),
        label: 'Local STT',
      });

      expect(text).toBe('hi there');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:8000/v1/audio/transcriptions');
      expect(init.method).toBe('POST');
      const body = init.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect(body.get('model')).toBe('whisper-large-v3');
      expect(body.get('file')).toBeInstanceOf(Blob);
    });

    it('uploads the exact bytes it was handed', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' })),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await transcribeOpenAiCompat({
        baseUrl: 'http://localhost:8000/v1',
        model: 'm',
        audio: { data: new Uint8Array([9, 8, 7]), mimeType: 'audio/wav' },
        label: 'Local STT',
      });

      const file = (fetchMock.mock.calls[0][1].body as FormData).get('file') as File;
      expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([9, 8, 7]);
    });

    it('sends Authorization when an apiKey is present', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' })),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await transcribeOpenAiCompat({
        baseUrl: 'https://api.openai.com/v1',
        model: 'whisper-1',
        audio: audio('audio/ogg'),
        apiKey: 'sk-secret',
        label: 'OpenAI STT',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
    });

    it('omits Authorization entirely when no apiKey (local case)', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' })),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await transcribeOpenAiCompat({
        baseUrl: 'http://localhost:8000/v1',
        model: 'whisper-large-v3',
        audio: audio('audio/ogg'),
        label: 'Local STT',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers as Record<string, string>).not.toHaveProperty('Authorization');
    });

    it.each([
      ['audio/webm', 'audio.webm', 'audio/webm'],
      ['audio/wav', 'audio.wav', 'audio/wav'],
      ['audio/mpeg', 'audio.mp3', 'audio/mpeg'],
      ['audio/ogg', 'audio.ogg', 'audio/ogg'],
    ])('sends %s as %s with content-type %s', async (mime, name, contentType) => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' })),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await transcribeOpenAiCompat({
        baseUrl: 'http://localhost:8000/v1',
        model: 'whisper-large-v3',
        audio: audio(mime),
        label: 'Local STT',
      });

      const [, init] = fetchMock.mock.calls[0];
      const file = (init.body as FormData).get('file') as File;
      expect(file.name).toBe(name);
      expect(file.type).toBe(contentType);
    });

    it('falls back to octet-stream + "audio" filename for an unknown MIME', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' })),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await transcribeOpenAiCompat({
        baseUrl: 'http://localhost:8000/v1',
        model: 'whisper-large-v3',
        audio: audio('audio/x-nonsense'),
        label: 'Local STT',
      });

      const [, init] = fetchMock.mock.calls[0];
      const file = (init.body as FormData).get('file') as File;
      expect(file.name).toBe('audio');
      expect(file.type).toBe('application/octet-stream');
    });

    it('forwards a language hint, and omits the part when none is given', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: 'ok' })),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const call = {
        baseUrl: 'http://localhost:8000/v1',
        model: 'm',
        audio: audio('audio/wav'),
        label: 'Local STT',
      };
      await transcribeOpenAiCompat({ ...call, language: 'es' });
      await transcribeOpenAiCompat(call);

      expect((fetchMock.mock.calls[0][1].body as FormData).get('language')).toBe('es');
      expect((fetchMock.mock.calls[1][1].body as FormData).get('language')).toBeNull();
    });

    it('threads an abort signal into fetch and rejects when aborted', async () => {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return new Response(JSON.stringify({ text: 'ok' }));
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        transcribeOpenAiCompat({
          baseUrl: 'http://localhost:8000/v1',
          model: 'whisper-large-v3',
          audio: audio('audio/ogg'),
          label: 'Local STT',
          signal: AbortSignal.abort(),
        }),
      ).rejects.toThrow(/Aborted/);
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('throws with the label prefix on a non-ok response', async () => {
      globalThis.fetch = vi.fn(
        async () => new Response('boom', { status: 500 }),
      ) as unknown as typeof fetch;

      await expect(
        transcribeOpenAiCompat({
          baseUrl: 'http://localhost:8000/v1',
          model: 'm',
          audio: audio('audio/ogg'),
          label: 'Local STT',
        }),
      ).rejects.toThrow(/Local STT failed \(500\)/);
    });
  });

  describe('synthesizeOpenAiCompat', () => {
    it('POSTs json to {baseUrl}/audio/speech and returns opus bytes', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(new Uint8Array([9, 8, 7]).buffer),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await synthesizeOpenAiCompat({
        baseUrl: 'http://localhost:8880/v1',
        model: 'kokoro',
        voice: 'af_bella',
        input: 'hello',
        label: 'Local TTS',
      });

      expect(result.format).toBe('opus');
      expect(Array.from(result.audio)).toEqual([9, 8, 7]);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:8880/v1/audio/speech');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      const parsed = JSON.parse(init.body as string);
      expect(parsed).toMatchObject({
        model: 'kokoro',
        voice: 'af_bella',
        input: 'hello',
        response_format: 'opus',
      });
    });

    it('sends Authorization when an apiKey is present', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(new Uint8Array([0]).buffer),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await synthesizeOpenAiCompat({
        baseUrl: 'https://api.openai.com/v1',
        model: 'tts-1',
        voice: 'alloy',
        input: 'hi',
        apiKey: 'sk-cloud',
        label: 'OpenAI TTS',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-cloud');
    });

    it('omits Authorization entirely when no apiKey (local case)', async () => {
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(new Uint8Array([0]).buffer),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await synthesizeOpenAiCompat({
        baseUrl: 'http://localhost:8880/v1',
        model: 'kokoro',
        voice: 'af_bella',
        input: 'hi',
        label: 'Local TTS',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers as Record<string, string>).not.toHaveProperty('Authorization');
    });
  });
});
