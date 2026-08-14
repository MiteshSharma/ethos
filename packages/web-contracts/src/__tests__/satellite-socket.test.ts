import { describe, expect, it } from 'vitest';
import { pcm16FromBytes, pcm16ToBytes } from '../frame-codec';
import {
  decodeSatelliteClientFrame,
  decodeSatelliteServerFrame,
  encodeSatelliteFrame,
  SATELLITE_SOCKET_VERSION,
  type SatelliteClientFrame,
  type SatelliteServerFrame,
} from '../satellite-socket';
import { decodeVoiceClientFrame, decodeVoiceServerFrame, encodeVoiceFrame } from '../voice-socket';

// Build a frame by hand so a test can put bytes on the wire that
// `encodeSatelliteFrame` would never produce.
function rawFrame(version: number, headerText: string, payload = new Uint8Array()): Uint8Array {
  const header = new TextEncoder().encode(headerText);
  const out = new Uint8Array(3 + header.length + payload.length);
  out[0] = version;
  out[1] = (header.length >> 8) & 0xff;
  out[2] = header.length & 0xff;
  out.set(header, 3);
  out.set(payload, 3 + header.length);
  return out;
}

const CLIENT_FRAMES: SatelliteClientFrame[] = [
  {
    t: 'register',
    nodeId: 'kitchen-pi',
    displayName: 'Kitchen Pi',
    protocolVersion: SATELLITE_SOCKET_VERSION,
    capabilities: { edgeStt: true, playback: true, captureSampleRate: 16_000 },
    wakeEnabled: true,
  },
  { t: 'state', state: 'listening' },
  { t: 'state', state: 'degraded', detail: 'model file missing — sherpa-wake.onnx' },
  {
    t: 'doctor',
    probes: [
      { name: 'native-binary', ok: true },
      { name: 'wake-model', ok: false, detail: 'sherpa-wake.onnx not found' },
    ],
  },
  {
    t: 'wake',
    wakeId: 'w1',
    phrase: 'hey swing trader',
    routeId: 'r-trader',
    personalityId: 'swing-trader',
    confidence: 0.91,
  },
  { t: 'utterance_start', wakeId: 'w1', utteranceId: 'u1', sampleRate: 16_000 },
  { t: 'audio', utteranceId: 'u1', seq: 0 },
  { t: 'utterance_end', utteranceId: 'u1' },
  { t: 'transcript', utteranceId: 'u1', text: 'how are my positions' },
  { t: 'playback_done', utteranceId: 'u1' },
];

const SERVER_FRAMES: SatelliteServerFrame[] = [
  { t: 'ready', nodeId: 'kitchen-pi', laneId: 'voice:kitchen-pi:swing-trader', protocolVersion: 1 },
  {
    t: 'routes',
    routes: [
      {
        id: 'r-trader',
        phrase: 'hey swing trader',
        personalityId: 'swing-trader',
        privileged: false,
        enabled: true,
      },
      {
        id: 'r-ops',
        phrase: 'hey operator',
        personalityId: 'ops',
        privileged: true,
        enabled: false,
      },
    ],
    settings: {
      engine: 'sherpa-onnx',
      sensitivity: 0.6,
      confirmationFrames: 2,
      edgeStt: true,
      idleTimeoutMs: 30_000,
      inputDevice: 'hw:1,0',
      wakeEnabled: true,
    },
  },
  {
    t: 'speak_start',
    utteranceId: 'u1',
    segmentId: 's0',
    codec: 'pcm_s16le',
    mimeType: 'audio/pcm;codec=s16le',
    sampleRate: 24_000,
    channels: 1,
  },
  {
    t: 'speak_start',
    utteranceId: 'u1',
    segmentId: 's1',
    codec: 'encoded',
    mimeType: 'audio/ogg;codecs=opus',
  },
  { t: 'audio', utteranceId: 'u1', segmentId: 's0', seq: 4 },
  { t: 'segment_end', utteranceId: 'u1', segmentId: 's0' },
  {
    t: 'reply_text',
    utteranceId: 'u1',
    personalityId: 'swing-trader',
    text: 'You are up two percent on the week.',
  },
  { t: 'turn_end', utteranceId: 'u1', personalityId: 'swing-trader' },
  {
    t: 'transcript',
    utteranceId: 'u1',
    text: 'how are my positions',
    final: true,
    provider: 'sherpa',
  },
  { t: 'set_wake_enabled', enabled: false },
  { t: 'error', code: 'unknown_personality', message: 'no such personality', wakeId: 'w1' },
];

describe('satellite socket framing', () => {
  for (const frame of CLIENT_FRAMES) {
    it(`round-trips the client "${frame.t}" frame`, () => {
      const decoded = decodeSatelliteClientFrame(encodeSatelliteFrame(frame));
      expect(decoded?.header).toEqual(frame);
      expect(decoded?.payload.length).toBe(0);
    });
  }

  for (const frame of SERVER_FRAMES) {
    it(`round-trips the server "${frame.t}" frame`, () => {
      const decoded = decodeSatelliteServerFrame(encodeSatelliteFrame(frame));
      expect(decoded?.header).toEqual(frame);
      expect(decoded?.payload.length).toBe(0);
    });
  }

  it('carries a PCM payload through an audio frame byte-for-byte', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 4242]);
    const bytes = encodeSatelliteFrame(
      { t: 'audio', utteranceId: 'u9', seq: 12 },
      pcm16ToBytes(samples),
    );
    const decoded = decodeSatelliteClientFrame(bytes);
    expect(decoded?.header).toEqual({ t: 'audio', utteranceId: 'u9', seq: 12 });
    expect(Array.from(pcm16FromBytes(decoded?.payload ?? new Uint8Array()))).toEqual(
      Array.from(samples),
    );
  });

  it('refuses a frame carrying another lane’s version byte', () => {
    const bytes = encodeSatelliteFrame({ t: 'utterance_end', utteranceId: 'u1' });
    const wrongVersion = Uint8Array.from(bytes);
    wrongVersion[0] = SATELLITE_SOCKET_VERSION + 1;
    expect(decodeSatelliteClientFrame(wrongVersion)).toBeNull();
  });

  it('refuses a truncated frame whose header length overruns the bytes present', () => {
    // Claims a 40-byte header; three bytes arrived.
    expect(
      decodeSatelliteClientFrame(new Uint8Array([SATELLITE_SOCKET_VERSION, 0, 40])),
    ).toBeNull();
    expect(decodeSatelliteClientFrame(new Uint8Array([]))).toBeNull();
  });

  it('refuses a header that is not JSON', () => {
    expect(decodeSatelliteClientFrame(rawFrame(SATELLITE_SOCKET_VERSION, '{"t":'))).toBeNull();
  });

  it('refuses a structurally invalid header, proving zod actually runs', () => {
    // `nodeId` as a number is exactly what a hand-rolled satellite would send,
    // and it would silently become the lane key if the header were cast.
    const numericNodeId = rawFrame(
      SATELLITE_SOCKET_VERSION,
      JSON.stringify({
        t: 'register',
        nodeId: 7,
        protocolVersion: 1,
        capabilities: { edgeStt: false, playback: true, captureSampleRate: 16_000 },
        wakeEnabled: true,
      }),
    );
    expect(decodeSatelliteClientFrame(numericNodeId)).toBeNull();

    // An unknown listening state must not pass either — the mic indicator
    // renders this value.
    const badState = rawFrame(
      SATELLITE_SOCKET_VERSION,
      JSON.stringify({ t: 'state', state: 'probably_listening' }),
    );
    expect(decodeSatelliteClientFrame(badState)).toBeNull();
  });

  it('keeps the two unions apart in both directions', () => {
    // A satellite must not be able to push a routing table at itself, and a
    // server decoder must not accept a node's registration as a command.
    const clientFrame = encodeSatelliteFrame({ t: 'playback_done', utteranceId: 'u1' });
    expect(decodeSatelliteServerFrame(clientFrame)).toBeNull();

    const serverFrame = encodeSatelliteFrame({ t: 'set_wake_enabled', enabled: true });
    expect(decodeSatelliteClientFrame(serverFrame)).toBeNull();

    // `reply_text` is server→satellite only. A node must not be able to put
    // words in an agent's mouth on the way UP: the lane's `transcript` frame is
    // what a satellite says, and the two must not be interchangeable.
    const replyText = encodeSatelliteFrame({
      t: 'reply_text',
      utteranceId: 'u1',
      personalityId: 'swing-trader',
      text: 'You are up two percent on the week.',
    });
    expect(decodeSatelliteClientFrame(replyText)).toBeNull();
  });

  it('lets an older satellite ignore reply_text instead of breaking on it', () => {
    // The frame is ADDITIVE — `SATELLITE_SOCKET_VERSION` deliberately did not
    // move for it — so the compatibility claim rests entirely on what a decoder
    // that has never heard of `t: 'reply_text'` does with one. This is that
    // decoder: a union with the variant absent must return null, not throw, and
    // must leave a well-formed frame of a kind it DOES know still decodable.
    const unknownToThisBuild = rawFrame(
      SATELLITE_SOCKET_VERSION,
      JSON.stringify({ t: 'some_future_frame', utteranceId: 'u1', text: 'hello' }),
    );
    expect(decodeSatelliteServerFrame(unknownToThisBuild)).toBeNull();
    expect(
      decodeSatelliteServerFrame(
        encodeSatelliteFrame({ t: 'turn_end', utteranceId: 'u1', personalityId: 'p' }),
      )?.header,
    ).toEqual({ t: 'turn_end', utteranceId: 'u1', personalityId: 'p' });
  });

  it('is rejected by the browser voice lane wherever the frames differ', () => {
    // Sharing the codec must not make the two lanes one protocol. Every
    // satellite-specific frame is refused by the browser lane's decoders.
    expect(
      decodeVoiceClientFrame(encodeSatelliteFrame({ t: 'playback_done', utteranceId: 'u1' })),
    ).toBeNull();
    expect(
      decodeVoiceServerFrame(encodeSatelliteFrame({ t: 'set_wake_enabled', enabled: true })),
    ).toBeNull();

    // What separates the lanes in production is the MOUNT PATH, not the bytes:
    // a handful of pure control frames (`utterance_end`) are deliberately
    // wire-identical in both, and asserting otherwise would be asserting a
    // coincidence. The version byte is the escape hatch if they ever must
    // diverge — which is why the codec takes it as a parameter.
    expect(
      decodeSatelliteClientFrame(encodeVoiceFrame({ t: 'utterance_end', utteranceId: 'u1' }))
        ?.header,
    ).toEqual({ t: 'utterance_end', utteranceId: 'u1' });
  });
});
