import type { ObservabilityWriter } from '@ethosagent/types';
import type { VoiceTurnSpan } from '@ethosagent/voice-session';
import { describe, expect, it } from 'vitest';
import { EthosObservability } from '../observability/ethos-observability';
import { createObservabilitySpanSink } from '../voice-stack';

// What a flushed voice span turns into in the observability store.
//
// The realtime tier's stamp is the one under test. Its span carries
// `realtimeProvider` rather than `sttProvider`/`ttsProvider` — one hosted
// session owns hearing and speaking, so there is no listening/speaking split to
// name — and a sink that only copied the pipeline pair would store the tier's
// mouth-to-ear number with no way to say whose it was.

interface Recorded {
  traces: Array<{ traceId: string; attrs: Record<string, unknown> | undefined }>;
  spans: Array<{ name: string; attrs: Record<string, unknown> | undefined }>;
}

function observability(): { obs: EthosObservability; recorded: Recorded } {
  const recorded: Recorded = { traces: [], spans: [] };
  let seq = 0;
  const writer: ObservabilityWriter = {
    startTrace(opts) {
      const traceId = `trace-${++seq}`;
      recorded.traces.push({ traceId, attrs: opts.attrs });
      return traceId;
    },
    endTrace() {},
    startSpan(opts) {
      recorded.spans.push({ name: opts.name, attrs: opts.attrs });
      return `span-${++seq}`;
    },
    endSpan() {},
    recordEvent() {},
    flush() {},
  };
  return { obs: new EthosObservability(writer), recorded };
}

const realtimeSpan: VoiceTurnSpan = {
  turnId: 'turn-1',
  stage: 'realtime_first_audio',
  startTs: 1_000,
  endTs: 1_640,
  status: 'ok',
  laneKey: 'voice:web:browser:chat-9',
  realtimeProvider: 'openai-realtime',
};

describe('voice span sink', () => {
  it('stamps the realtime provider on both the turn trace and its span', () => {
    const { obs, recorded } = observability();

    createObservabilitySpanSink(obs).write([realtimeSpan]);

    expect(recorded.traces[0]?.attrs).toMatchObject({
      turnId: 'turn-1',
      realtimeProvider: 'openai-realtime',
    });
    expect(recorded.spans[0]).toMatchObject({
      name: 'realtime_first_audio',
      attrs: { turnId: 'turn-1', durationMs: 640, realtimeProvider: 'openai-realtime' },
    });
  });

  it('leaves the pipeline tier stamps alone', () => {
    const { obs, recorded } = observability();

    createObservabilitySpanSink(obs).write([
      {
        turnId: 'turn-2',
        stage: 'tts_first_audio',
        startTs: 0,
        endTs: 300,
        status: 'ok',
        sttProvider: 'whisper',
        ttsProvider: 'kokoro',
      },
    ]);

    expect(recorded.spans[0]?.attrs).toMatchObject({
      sttProvider: 'whisper',
      ttsProvider: 'kokoro',
    });
    expect(recorded.spans[0]?.attrs).not.toHaveProperty('realtimeProvider');
  });
});
