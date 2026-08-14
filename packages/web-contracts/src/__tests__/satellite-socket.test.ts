import { describe, expect, it } from 'vitest';
import { pcm16FromBytes, pcm16ToBytes } from '../frame-codec';
import {
  decodeSatelliteClientFrame,
  decodeSatelliteServerFrame,
  encodeSatelliteFrame,
  SATELLITE_SOCKET_VERSION,
  type SatelliteClientFrame,
  type SatelliteFrameDecode,
  type SatelliteServerFrame,
} from '../satellite-socket';
import { decodeVoiceClientFrame, decodeVoiceServerFrame, encodeVoiceFrame } from '../voice-socket';

/** Narrow a decode to its success arm, failing the test with the reason if not. */
function decoded<T>(result: SatelliteFrameDecode<T>): { header: T; payload: Uint8Array } {
  if (!result.ok) throw new Error(`expected a decodable frame, got: ${result.reason}`);
  return result;
}

/** Narrow a decode to its failure arm. */
function refused<T>(result: SatelliteFrameDecode<T>): { reason: string; frameType?: string } {
  if (result.ok) throw new Error('expected the frame to be refused');
  return result;
}

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
    capabilities: { edgeStt: true, playback: true, captureSampleRate: 16_000, phraseMatch: true },
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
  // The gating shape: a node that heard SOUND names no phrase and no
  // personality, because it has matched neither.
  { t: 'wake', wakeId: 'w2', confidence: 1 },
  // …and the same node, pinned by `ethos listen --route`: `routeId` alone,
  // which on a `phraseMatch: false` node means "only this route may address
  // me" rather than "this is what I matched".
  { t: 'wake', wakeId: 'w3', routeId: 'r-trader', confidence: 1 },
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
  // No personality: nobody answered, because nobody was addressed.
  { t: 'turn_end', utteranceId: 'u2' },
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
      const result = decoded(decodeSatelliteClientFrame(encodeSatelliteFrame(frame)));
      expect(result.header).toEqual(frame);
      expect(result.payload.length).toBe(0);
    });
  }

  for (const frame of SERVER_FRAMES) {
    it(`round-trips the server "${frame.t}" frame`, () => {
      const result = decoded(decodeSatelliteServerFrame(encodeSatelliteFrame(frame)));
      expect(result.header).toEqual(frame);
      expect(result.payload.length).toBe(0);
    });
  }

  it('carries a PCM payload through an audio frame byte-for-byte', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 4242]);
    const bytes = encodeSatelliteFrame(
      { t: 'audio', utteranceId: 'u9', seq: 12 },
      pcm16ToBytes(samples),
    );
    const result = decoded(decodeSatelliteClientFrame(bytes));
    expect(result.header).toEqual({ t: 'audio', utteranceId: 'u9', seq: 12 });
    expect(Array.from(pcm16FromBytes(result.payload))).toEqual(Array.from(samples));
  });

  it('refuses a frame carrying another lane’s version byte, and says so', () => {
    const bytes = encodeSatelliteFrame({ t: 'utterance_end', utteranceId: 'u1' });
    const wrongVersion = Uint8Array.from(bytes);
    wrongVersion[0] = SATELLITE_SOCKET_VERSION + 1;
    expect(refused(decodeSatelliteClientFrame(wrongVersion)).reason).toBe(
      `framing version ${SATELLITE_SOCKET_VERSION + 1}, and this lane speaks ${SATELLITE_SOCKET_VERSION}`,
    );
  });

  it('refuses a truncated frame whose header length overruns the bytes present', () => {
    // Claims a 40-byte header; three bytes arrived.
    expect(
      refused(decodeSatelliteClientFrame(new Uint8Array([SATELLITE_SOCKET_VERSION, 0, 40]))).reason,
    ).toBe('header claims 40 bytes but only 0 arrived');
    expect(refused(decodeSatelliteClientFrame(new Uint8Array([]))).reason).toBe(
      'frame is 0 bytes, shorter than the 3-byte prefix',
    );
  });

  it('refuses a header that is not JSON', () => {
    expect(
      refused(decodeSatelliteClientFrame(rawFrame(SATELLITE_SOCKET_VERSION, '{"t":'))).reason,
    ).toBe('the 5-byte header is not JSON');
  });

  it('names the frame and the failing field rather than saying "unrecognized"', () => {
    // The whole point of the discriminated result. A `wake` with a field of the
    // wrong type must come back naming `wake` and naming `confidence` — the
    // refusal an operator reads is the only thing standing between them and
    // bisecting their satellite build.
    const badWake = rawFrame(
      SATELLITE_SOCKET_VERSION,
      JSON.stringify({ t: 'wake', wakeId: 'w1', confidence: 'very' }),
    );
    const failure = refused(decodeSatelliteClientFrame(badWake));
    expect(failure.frameType).toBe('wake');
    expect(failure.reason).toBe('confidence: invalid_type');
  });

  it('never echoes a received value into the refusal', () => {
    // The header on this lane can carry a transcript of somebody's kitchen, so
    // a decoder that interpolated the input into its reason would turn a
    // diagnostic into a recording.
    const secret = 'my card number is 4111 1111 1111 1111';
    const leaky = rawFrame(
      SATELLITE_SOCKET_VERSION,
      JSON.stringify({ t: 'transcript', utteranceId: 'u1', text: { spoken: secret } }),
    );
    const failure = refused(decodeSatelliteClientFrame(leaky));
    expect(failure.frameType).toBe('transcript');
    expect(failure.reason).toBe('text: invalid_type');
    expect(failure.reason).not.toContain('4111');
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
    expect(refused(decodeSatelliteClientFrame(numericNodeId)).reason).toBe('nodeId: invalid_type');

    // An unknown listening state must not pass either — the mic indicator
    // renders this value.
    const badState = rawFrame(
      SATELLITE_SOCKET_VERSION,
      JSON.stringify({ t: 'state', state: 'probably_listening' }),
    );
    expect(refused(decodeSatelliteClientFrame(badState)).frameType).toBe('state');
  });

  it('keeps the two unions apart in both directions', () => {
    // A satellite must not be able to push a routing table at itself, and a
    // server decoder must not accept a node's registration as a command.
    const clientFrame = encodeSatelliteFrame({ t: 'playback_done', utteranceId: 'u1' });
    expect(decodeSatelliteServerFrame(clientFrame).ok).toBe(false);

    const serverFrame = encodeSatelliteFrame({ t: 'set_wake_enabled', enabled: true });
    expect(decodeSatelliteClientFrame(serverFrame).ok).toBe(false);

    // `reply_text` is server→satellite only. A node must not be able to put
    // words in an agent's mouth on the way UP: the lane's `transcript` frame is
    // what a satellite says, and the two must not be interchangeable.
    const replyText = encodeSatelliteFrame({
      t: 'reply_text',
      utteranceId: 'u1',
      personalityId: 'swing-trader',
      text: 'You are up two percent on the week.',
    });
    expect(decodeSatelliteClientFrame(replyText).ok).toBe(false);
  });

  it('registers a satellite that predates phraseMatch, and gates it', () => {
    // The compatibility claim behind not bumping `SATELLITE_SOCKET_VERSION`:
    // an installed satellite on somebody's Pi that has never heard of this
    // field must still be able to connect. It lands on `false`, which is the
    // half where the SERVER matches — a node that does not say it matches
    // phrases does not get trusted to have matched one.
    const old = rawFrame(
      SATELLITE_SOCKET_VERSION,
      JSON.stringify({
        t: 'register',
        nodeId: 'kitchen-pi',
        protocolVersion: 1,
        capabilities: { edgeStt: false, playback: true, captureSampleRate: 16_000 },
        wakeEnabled: true,
      }),
    );
    const { header } = decoded(decodeSatelliteClientFrame(old));
    expect(header).toMatchObject({ t: 'register' });
    expect(header.t === 'register' ? header.capabilities.phraseMatch : 'not-a-register').toBe(
      false,
    );
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
    expect(refused(decodeSatelliteServerFrame(unknownToThisBuild)).frameType).toBe(
      'some_future_frame',
    );
    expect(
      decoded(
        decodeSatelliteServerFrame(
          encodeSatelliteFrame({ t: 'turn_end', utteranceId: 'u1', personalityId: 'p' }),
        ),
      ).header,
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
      decoded(
        decodeSatelliteClientFrame(encodeVoiceFrame({ t: 'utterance_end', utteranceId: 'u1' })),
      ).header,
    ).toEqual({ t: 'utterance_end', utteranceId: 'u1' });
  });
});
