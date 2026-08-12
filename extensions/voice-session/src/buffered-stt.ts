// Utterance-buffered fallback: wrap a batch SttProvider so the session can
// treat it as a StreamingSttProvider. It buffers the utterance's PCM frames,
// encodes them as a WAV *in memory*, hands the bytes to the batch provider,
// and yields a single final partial. Endpointing is worse (no live partials)
// but the contract is identical.
//
// It needs nothing injected — no filesystem, no temp path, no cleanup
// obligation — which is what makes `VoiceSession` construction TOTAL: any
// configured provider yields a working session. Before the buffer contract
// this wrapper required a `pcmToPath` materializer, and a session built
// without one threw at construction.

import type { PcmChunk, StreamingSttProvider, SttProvider } from '@ethosagent/types';
import { encodeWav } from './wav';

/** Sample rate assumed when an utterance somehow commits with no frames. */
const FALLBACK_SAMPLE_RATE = 16_000;

export function createBufferedSttAdapter(provider: SttProvider): StreamingSttProvider {
  return {
    name: provider.name,
    caps: provider.caps,
    transcribeBuffer: (audio, opts) => provider.transcribeBuffer(audio, opts),
    async *transcribeStream(audio, opts) {
      const chunks: PcmChunk[] = [];
      for await (const chunk of audio) chunks.push(chunk);
      const text = await provider.transcribeBuffer(
        {
          data: encodeWav(chunks),
          mimeType: 'audio/wav',
          sampleRate: chunks[0]?.sampleRate ?? FALLBACK_SAMPLE_RATE,
        },
        opts,
      );
      yield { text, isFinal: true };
    },
  };
}
