// The utterance-buffered fallback — what a batch STT provider sees when the
// session has no streaming provider. The point of these tests is that the
// adapter needs NOTHING injected: no filesystem, no temp path, no cleanup.

import type { PcmChunk, SttAudio, SttProvider } from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createBufferedSttAdapter } from '../buffered-stt';

function recordingProvider(): { provider: SttProvider; seen: SttAudio[] } {
  const seen: SttAudio[] = [];
  return {
    seen,
    provider: {
      name: 'batch-stt',
      caps: { kind: 'stt', formats: ['wav'], local: true, contractVersion: STT_CONTRACT_VERSION },
      transcribeBuffer: async (audio) => {
        seen.push(audio);
        return 'the transcript';
      },
    },
  };
}

async function* frames(chunks: PcmChunk[]): AsyncIterable<PcmChunk> {
  for (const chunk of chunks) yield chunk;
}

function chunk(samples: number[], sampleRate = 16_000): PcmChunk {
  return { data: Int16Array.from(samples), sampleRate };
}

async function drain(stream: AsyncIterable<{ text: string; isFinal: boolean }>) {
  const out: Array<{ text: string; isFinal: boolean }> = [];
  for await (const partial of stream) out.push(partial);
  return out;
}

describe('createBufferedSttAdapter', () => {
  it('carries the wrapped provider name and caps', () => {
    const { provider } = recordingProvider();
    const adapter = createBufferedSttAdapter(provider);
    expect(adapter.name).toBe('batch-stt');
    expect(adapter.caps).toBe(provider.caps);
  });

  it('encodes the buffered frames as a WAV and yields one final partial', async () => {
    const { provider, seen } = recordingProvider();
    const adapter = createBufferedSttAdapter(provider);

    const partials = await drain(
      adapter.transcribeStream(frames([chunk([1, 2]), chunk([3, 4, 5])])),
    );

    expect(partials).toEqual([{ text: 'the transcript', isFinal: true }]);
    expect(seen).toHaveLength(1);
    const audio = seen[0];
    expect(audio?.mimeType).toBe('audio/wav');
    expect(audio?.sampleRate).toBe(16_000);
    const data = audio?.data ?? new Uint8Array();
    expect(String.fromCharCode(...data.slice(0, 4))).toBe('RIFF');
    // 44-byte header + 5 samples × 2 bytes.
    expect(data.byteLength).toBe(44 + 10);
  });

  it('takes the sample rate from the captured frames', async () => {
    const { provider, seen } = recordingProvider();
    await drain(createBufferedSttAdapter(provider).transcribeStream(frames([chunk([1], 48_000)])));
    expect(seen[0]?.sampleRate).toBe(48_000);
  });

  it('forwards transcription options to the wrapped provider', async () => {
    const received: Array<{ language?: string } | undefined> = [];
    const provider: SttProvider = {
      name: 'opts-stt',
      caps: { kind: 'stt', formats: ['wav'], contractVersion: STT_CONTRACT_VERSION },
      transcribeBuffer: async (_audio, opts) => {
        received.push(opts);
        return 'ok';
      },
    };
    await drain(
      createBufferedSttAdapter(provider).transcribeStream(frames([chunk([1])]), {
        language: 'es',
      }),
    );
    expect(received[0]?.language).toBe('es');
  });

  it('passes a direct transcribeBuffer call straight through', async () => {
    const { provider, seen } = recordingProvider();
    const audio: SttAudio = { data: new Uint8Array([9]), mimeType: 'audio/webm' };
    await expect(createBufferedSttAdapter(provider).transcribeBuffer(audio)).resolves.toBe(
      'the transcript',
    );
    expect(seen[0]).toBe(audio);
  });

  // A spurious endpoint with no frames must not crash a live session.
  it('produces a valid empty WAV for an empty utterance', async () => {
    const { provider, seen } = recordingProvider();
    await drain(createBufferedSttAdapter(provider).transcribeStream(frames([])));
    expect(seen[0]?.data.byteLength).toBe(44);
    expect(seen[0]?.sampleRate).toBe(16_000);
  });
});
