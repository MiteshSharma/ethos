import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { satelliteLaneKey } from '@ethosagent/core';
import type { AgentEvent, VoiceMode } from '@ethosagent/types';
import {
  decodeSatelliteServerFrame,
  encodeSatelliteFrame,
  pcm16ToBytes,
  SATELLITE_SOCKET_PATH,
  type SatelliteClientFrame,
  type SatelliteServerFrame,
  VOICE_SOCKET_PATH,
} from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { WakeRoutingTable } from '../../repositories/config.repository';
import type { VoiceService } from '../../services/voice.service';
import type { SatelliteLaneDeps } from '../satellite-lane';
import { SatelliteRegistry } from '../satellite-registry';
import { createSatelliteSocket, type SatelliteSocket } from '../satellite-socket';
import { createVoiceSocket, readCookie, type VoiceSocket } from '../voice-socket';

// The socket half of the wake lane, over a REAL `ws` connection on an ephemeral
// port — the same harness shape as `voice-socket.test.ts`, because the things
// worth catching here (upgrade policy, frame round trips, who ends up on which
// lane key) only exist once bytes cross a socket.

const COOKIE = 'ethos_auth=good-token';

function table(overrides: Partial<WakeRoutingTable> = {}): WakeRoutingTable {
  return {
    routes: [
      {
        id: 'eng',
        phrase: 'hey engineer',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
        implicit: false,
      },
      {
        id: 'res',
        phrase: 'hey researcher',
        personalityId: 'researcher',
        privileged: false,
        enabled: true,
        implicit: false,
      },
      {
        id: 'off',
        phrase: 'hey nobody',
        personalityId: 'researcher',
        privileged: false,
        enabled: false,
        implicit: false,
      },
      {
        id: 'root',
        phrase: 'hey root',
        personalityId: 'admin',
        privileged: false,
        enabled: true,
        implicit: false,
      },
    ],
    nodes: {},
    settings: {
      engine: 'fallback',
      sensitivity: 0.5,
      confirmationFrames: 2,
      edgeStt: false,
      idleTimeoutMs: 30_000,
      wakeEnabled: true,
    },
    ...overrides,
  };
}

/** A VoiceService stand-in — only the two methods the browser lane calls. */
function fakeVoiceService(): VoiceService {
  return {
    transcribeBytes: () => Promise.resolve({ text: 'over the wire', provider: 'fake-stt' }),
    synthesizeStream: async function* () {
      yield { audio: new Uint8Array([7, 8, 9]), format: 'opus' as const, provider: 'fake-tts' };
    },
  } as unknown as VoiceService;
}

describe('satellite socket', () => {
  let server: Server;
  let satellite: SatelliteSocket;
  let voice: VoiceSocket;
  let registry: SatelliteRegistry;
  let url: string;

  /** What the fake loop was asked to do, and on which lane. */
  let turns: Array<{ text: string; sessionKey: string; personalityId: string }>;
  /** Stand-in session store: lane key → the turns filed under it. */
  let sessions: Map<string, string[]>;
  let transcribeCalls: number;
  /** TTS calls. The whole point of the playback gate is that this stays 0. */
  let synthesizeCalls: number;
  /** The exact text each `synthesize` call received, in order. */
  let synthesized: string[];
  /** The deltas the fake loop streams for the next turn. */
  let replyDeltas: string[];
  /**
   * Interleaving of `delta:<n>` and `synth:<text>`, so a test can pin that
   * synthesis STARTS before the reply finishes streaming.
   */
  let order: string[];
  /** Audit rows the lane wrote, in order. */
  let observed: Array<{ code: string; details: Record<string, unknown> }>;
  let currentTable: WakeRoutingTable;
  let mode: VoiceMode;
  /** Personalities the deployment has, and whether each is privileged. */
  let privileged: Set<string>;

  function deps(): SatelliteLaneDeps {
    return {
      transcribe: () => {
        transcribeCalls += 1;
        return Promise.resolve({ text: 'how are my positions', provider: 'fake-stt' });
      },
      synthesize: async function* (text: string) {
        synthesizeCalls += 1;
        synthesized.push(text);
        order.push(`synth:${text}`);
        yield { audio: new Uint8Array([1, 2]), format: 'opus' as const, provider: 'fake-tts' };
      },
      resolvePersonality: (id) =>
        Promise.resolve(
          id === 'ghost'
            ? { exists: false, privileged: true }
            : { exists: true, privileged: privileged.has(id) },
        ),
      runTurn: ({ text, sessionKey, personalityId }): AsyncIterable<AgentEvent> => {
        turns.push({ text, sessionKey, personalityId });
        sessions.set(sessionKey, [...(sessions.get(sessionKey) ?? []), text]);
        return (async function* () {
          // Deliberately marked up: both `reply_text` AND the synthesized audio
          // carry the SPEAKABLE form, so a delta with markdown in it is what
          // proves the sanitizer ran rather than the raw reply being forwarded.
          for (const [i, delta] of replyDeltas.entries()) {
            order.push(`delta:${i}`);
            yield { type: 'text_delta' as const, text: delta };
            // A real provider's deltas arrive over a socket. Yielding the
            // macrotask queue between them is what lets the lane's synthesis
            // chain actually run mid-stream — without it the whole reply is
            // drained in one microtask burst and "streaming" is unobservable.
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          yield { type: 'done' as const, text: replyDeltas.join(''), turnCount: 1 };
        })();
      },
      voiceMode: () => Promise.resolve(mode),
      // The REAL builder, so the encoding guarantee is what this suite
      // exercises rather than a template string that happens to agree.
      laneKey: (nodeId, personalityId) => satelliteLaneKey('web', nodeId, personalityId),
      observe: (code, details) => observed.push({ code, details }),
    };
  }

  beforeEach(async () => {
    turns = [];
    sessions = new Map();
    transcribeCalls = 0;
    synthesizeCalls = 0;
    synthesized = [];
    replyDeltas = ['**All good.** '];
    order = [];
    observed = [];
    currentTable = table();
    mode = 'mirror_inbound';
    privileged = new Set(['admin']);
    registry = new SatelliteRegistry({ readTable: () => Promise.resolve(currentTable) });

    server = createServer((_req, res) => res.end('ok'));
    const authenticate = (req: { headers: { cookie?: string } }) =>
      Promise.resolve(readCookie(req.headers.cookie, 'ethos_auth') === 'good-token');
    satellite = createSatelliteSocket({ registry, deps, authenticate });
    voice = createVoiceSocket({ voice: fakeVoiceService(), authenticate });
    // Deliberately attached in the order that used to break: the voice lane's
    // handler was the only `upgrade` listener and 404'd everything else.
    voice.attach(server);
    satellite.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await satellite.close();
    await voice.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function open(
    headers: Record<string, string> = { cookie: COOKIE },
    path = SATELLITE_SOCKET_PATH,
  ) {
    const ws = new WebSocket(`${url}${path}`, { headers });
    const frames: SatelliteServerFrame[] = [];
    const payloads: Uint8Array[] = [];
    ws.on('message', (data: Buffer) => {
      const decoded = decodeSatelliteServerFrame(new Uint8Array(data));
      if (decoded) {
        frames.push(decoded.header);
        payloads.push(decoded.payload);
      }
    });
    const send = (frame: SatelliteClientFrame, payload?: Uint8Array) =>
      ws.send(encodeSatelliteFrame(frame, payload));
    return { ws, frames, payloads, send };
  }

  async function connect(nodeId = 'kitchen', edgeStt = false, playback = true) {
    const client = open();
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));
    client.send({
      t: 'register',
      nodeId,
      displayName: 'Kitchen Pi',
      protocolVersion: 1,
      capabilities: { edgeStt, playback, captureSampleRate: 16_000 },
      wakeEnabled: true,
    });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'routes')).toBe(true));
    return client;
  }

  /** Wake, speak, and wait for the turn to finish. */
  async function speak(
    client: Awaited<ReturnType<typeof connect>>,
    wakeId: string,
    phrase: string,
    routeId: string,
    personalityId: string,
  ) {
    const utteranceId = `u-${wakeId}`;
    client.send({ t: 'wake', wakeId, phrase, routeId, personalityId });
    client.send({ t: 'utterance_start', wakeId, utteranceId, sampleRate: 16_000 });
    client.send({ t: 'audio', utteranceId, seq: 0 }, pcm16ToBytes(Int16Array.from([1, 2, 3])));
    client.send({ t: 'utterance_end', utteranceId });
    await vi.waitFor(() =>
      expect(client.frames.some((f) => f.t === 'turn_end' && f.utteranceId === utteranceId)).toBe(
        true,
      ),
    );
    return utteranceId;
  }

  describe('upgrade router', () => {
    it('serves both lanes off one listener', async () => {
      const sat = open();
      const browser = new WebSocket(`${url}${VOICE_SOCKET_PATH}`, { headers: { cookie: COOKIE } });
      await Promise.all([
        new Promise<void>((resolve) => sat.ws.on('open', () => resolve())),
        new Promise<void>((resolve) => browser.on('open', () => resolve())),
      ]);
      expect(sat.ws.readyState).toBe(WebSocket.OPEN);
      expect(browser.readyState).toBe(WebSocket.OPEN);
      sat.ws.close();
      browser.close();
    });

    it('404s a path neither lane claims', async () => {
      const { ws } = open({ cookie: COOKIE }, '/nope');
      const status = await new Promise<number>((resolve) => {
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => resolve(0));
      });
      expect(status).toBe(404);
    });

    it('401s a satellite with no credential', async () => {
      const { ws } = open({});
      const status = await new Promise<number>((resolve) => {
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => resolve(0));
      });
      expect(status).toBe(401);
      expect(satellite.laneCount).toBe(0);
    });
  });

  it('answers register with ready + the current routing table', async () => {
    const client = await connect();
    expect(client.frames[0]).toMatchObject({ t: 'ready', nodeId: 'kitchen', protocolVersion: 1 });
    const routes = client.frames.find((f) => f.t === 'routes');
    expect(routes).toMatchObject({
      routes: [
        { id: 'eng', phrase: 'hey engineer', personalityId: 'engineer', enabled: true },
        { id: 'res' },
        { id: 'off', enabled: false },
        { id: 'root' },
      ],
      settings: { engine: 'fallback', idleTimeoutMs: 30_000, wakeEnabled: true },
    });
    expect(registry.list()).toMatchObject([{ nodeId: 'kitchen', displayName: 'Kitchen Pi' }]);
    client.ws.close();
  });

  it('pushes a new table to a connected node when the config changes', async () => {
    const client = await connect();
    currentTable = table({
      routes: [
        {
          id: 'trader',
          phrase: 'hey swing trader',
          personalityId: 'trader',
          privileged: false,
          enabled: true,
          implicit: false,
        },
      ],
    });
    await registry.refreshRoutes();

    await vi.waitFor(() => expect(client.frames.filter((f) => f.t === 'routes')).toHaveLength(2));
    const latest = client.frames.filter((f) => f.t === 'routes').at(-1);
    expect(latest).toMatchObject({ routes: [{ id: 'trader', phrase: 'hey swing trader' }] });
    client.ws.close();
  });

  it('runs a wake turn on the satellite lane key and speaks the reply back', async () => {
    const client = await connect();
    const utteranceId = await speak(client, 'w1', 'hey engineer', 'eng', 'engineer');

    expect(turns).toEqual([
      {
        text: 'how are my positions',
        sessionKey: 'voice:web:satellite:kitchen:engineer',
        personalityId: 'engineer',
      },
    ]);
    expect(client.frames.find((f) => f.t === 'transcript')).toMatchObject({
      text: 'how are my positions',
      final: true,
    });
    const order = client.frames
      .filter((f) => ['speak_start', 'audio', 'segment_end', 'turn_end'].includes(f.t))
      .map((f) => f.t);
    expect(order).toEqual(['speak_start', 'audio', 'segment_end', 'turn_end']);
    // A node with a speaker AND a screen gets both: the text is not a fallback
    // for nodes that cannot play. Its position relative to the audio segments
    // is deliberately NOT asserted — the frame is sent as soon as the words are
    // known, without waiting on the synthesis tail — but it is always before
    // `turn_end`, the cue the node re-arms on.
    expect(client.frames.find((f) => f.t === 'reply_text')).toEqual({
      t: 'reply_text',
      utteranceId,
      personalityId: 'engineer',
      text: 'All good.',
    });
    expect(client.frames.findIndex((f) => f.t === 'reply_text')).toBeLessThan(
      client.frames.findIndex((f) => f.t === 'turn_end'),
    );
    const audioIndex = client.frames.findIndex((f) => f.t === 'audio');
    expect(Array.from(client.payloads[audioIndex] ?? [])).toEqual([1, 2]);
    expect(client.frames.at(-1)).toMatchObject({
      t: 'turn_end',
      utteranceId,
      personalityId: 'engineer',
    });
    // Regression guard for the playback gate below: a node that CAN play still
    // pays for TTS exactly as before.
    expect(synthesizeCalls).toBe(1);
    expect(observed).toEqual([]);
    client.ws.close();
  });

  // --- speakable text -------------------------------------------------------
  //
  // A satellite is a loudspeaker in a room. Every other surface that speaks
  // runs its text through `sanitizeForSpeech` first; this lane used to feed the
  // sentence chunker RAW deltas, so `**done**` was read out as "asterisk
  // asterisk done", a code fence was spelled character by character, and a URL
  // was read slash by slash. These three pin the fix.

  /** Markdown emphasis, a fence spanning several sentences, and a bare URL. */
  const MARKED_UP = [
    'Deployed **cleanly** to prod. ',
    'Here is the patch.\n\n```js\n',
    'const a = load(); // step one. ',
    'a.run(); // step two. ',
    'const b = a.next(); // step three. ',
    '```\n\n',
    'Full details live at https://ci.example.com/runs/42 for now. ',
    'Nothing else broke.',
  ];

  it('synthesizes sanitized prose, not the raw markdown', async () => {
    replyDeltas = MARKED_UP;
    const client = await connect();
    const utteranceId = await speak(client, 'w1', 'hey engineer', 'eng', 'engineer');

    // Asserted on the ARGUMENT, not the call count: "TTS ran" was already true
    // when it was running on `**cleanly**`.
    expect(synthesized).toEqual([
      'Deployed cleanly to prod.',
      'Here is the patch.',
      'Full details live at for now.',
      'Nothing else broke.',
    ]);
    // …and `reply_text` is those same sentences rejoined, not a second
    // sanitize pass over the raw reply. The operator reads what the room hears.
    expect(client.frames.find((f) => f.t === 'reply_text')).toEqual({
      t: 'reply_text',
      utteranceId,
      personalityId: 'engineer',
      text: synthesized.join(' '),
    });
    client.ws.close();
  });

  it('strips a fence that spans sentence boundaries, which per-sentence sanitizing cannot', async () => {
    // The discriminating case. Sanitizing each chunker sentence looks correct
    // and is not: the piece holding the OPENING fence is stripped by the
    // unterminated-fence rule, and every piece after it — up to the close — has
    // no fence marker left in it, so it survives and gets read aloud. Here that
    // would speak "echo done." into the room. Sanitizing the accumulated reply
    // and chunking what it grew by removes the fence whole.
    replyDeltas = ['Ready. ', '```sh\n', 'rm -rf tmp. ', 'echo done. ', '```\n', 'That is all.'];
    const client = await connect();
    await speak(client, 'w1', 'hey engineer', 'eng', 'engineer');

    expect(synthesized).toEqual(['Ready.', 'That is all.']);
    client.ws.close();
  });

  it('starts synthesizing before the reply has finished streaming', async () => {
    replyDeltas = MARKED_UP;
    const client = await connect();
    await speak(client, 'w1', 'hey engineer', 'eng', 'engineer');

    // Sanitizing the whole accumulated buffer per delta must not turn the lane
    // into "buffer the reply, then speak" — that is the latency the chunker
    // exists to avoid. The first sentence is spoken while later deltas are
    // still arriving.
    const firstSynth = order.findIndex((e) => e.startsWith('synth:'));
    const lastDelta = order.lastIndexOf(`delta:${MARKED_UP.length - 1}`);
    expect(firstSynth).toBeGreaterThanOrEqual(0);
    expect(firstSynth).toBeLessThan(lastDelta);
    client.ws.close();
  });

  it('sends no audio when the lane mode is off, but still ends the turn', async () => {
    mode = 'off';
    const client = await connect();
    await speak(client, 'w1', 'hey engineer', 'eng', 'engineer');
    // `off` is an explicit opt-out and nothing overrides it, wake included —
    // but the node still needs its re-arm cue.
    expect(client.frames.some((f) => f.t === 'speak_start')).toBe(false);
    expect(client.frames.some((f) => f.t === 'turn_end')).toBe(true);
    // `off` suppresses SPEECH, not the answer — the same way it suppresses a
    // voice note on a chat channel while the text reply still goes out. A
    // satellite has no other channel to put the text on, so withholding it here
    // would make the turn produce nothing observable at all.
    expect(client.frames.find((f) => f.t === 'reply_text')).toMatchObject({
      personalityId: 'engineer',
      text: 'All good.',
    });
    client.ws.close();
  });

  it('runs the whole turn without synthesizing for a node that declared no playback', async () => {
    const client = await connect('headless', false, false);
    const utteranceId = await speak(client, 'w1', 'hey engineer', 'eng', 'engineer');

    // The turn is unchanged: it ran, it was transcribed, and the node got the
    // cue it re-arms on.
    expect(turns).toMatchObject([{ text: 'how are my positions', personalityId: 'engineer' }]);
    expect(client.frames.find((f) => f.t === 'transcript')).toMatchObject({
      text: 'how are my positions',
      final: true,
    });
    expect(client.frames.at(-1)).toMatchObject({ t: 'turn_end', utteranceId });
    // What changed: nothing was spoken, and — the point of the fix — nothing
    // was synthesized either. `ethos listen` discards playout frames on
    // arrival, so a TTS call here is latency and provider spend for bytes
    // nobody ever hears.
    expect(client.frames.some((f) => ['speak_start', 'audio', 'segment_end'].includes(f.t))).toBe(
      false,
    );
    expect(synthesizeCalls).toBe(0);
    // …and the point of `reply_text`: with synthesis skipped, this frame is the
    // ONLY thing the node learns about the answer. Sanitized, and attributed to
    // the personality that actually ran, so an operator watching `ethos listen`
    // can see that the right agent answered and what it said.
    const reply = client.frames.findIndex((f) => f.t === 'reply_text');
    expect(client.frames[reply]).toEqual({
      t: 'reply_text',
      utteranceId,
      personalityId: 'engineer',
      text: 'All good.',
    });
    expect(reply).toBeLessThan(client.frames.findIndex((f) => f.t === 'turn_end'));
    // Attributable, not silent.
    expect(observed).toEqual([
      {
        code: 'satellite.voice_no_playback',
        details: { nodeId: 'headless', personalityId: 'engineer', utteranceId },
      },
    ]);
    client.ws.close();
  });

  it('suppresses speech once, not twice, when mode is off AND the node cannot play', async () => {
    mode = 'off';
    const client = await connect('headless', false, false);
    await speak(client, 'w1', 'hey engineer', 'eng', 'engineer');

    expect(client.frames.some((f) => ['speak_start', 'audio', 'segment_end'].includes(f.t))).toBe(
      false,
    );
    expect(client.frames.some((f) => f.t === 'turn_end')).toBe(true);
    expect(synthesizeCalls).toBe(0);
    // No `voice_no_playback` row: the turn was never going to speak, so
    // attributing its silence to the missing loudspeaker would name the wrong
    // cause. `off` is the reason, and it is the user's own.
    expect(observed).toEqual([]);
    client.ws.close();
  });

  it('resumes a personality lane and switches lanes for another (D15)', async () => {
    const client = await connect();
    await speak(client, 'w1', 'hey engineer', 'eng', 'engineer');
    await speak(client, 'w2', 'hey engineer', 'eng', 'engineer');
    await speak(client, 'w3', 'hey researcher', 'res', 'researcher');

    const engineerLane = 'voice:web:satellite:kitchen:engineer';
    const researcherLane = 'voice:web:satellite:kitchen:researcher';
    // Two wakes of the same personality land in ONE conversation…
    expect(sessions.get(engineerLane)).toHaveLength(2);
    // …and the other personality keeps its own history.
    expect(sessions.get(researcherLane)).toHaveLength(1);
    expect([...sessions.keys()]).toEqual([engineerLane, researcherLane]);
    client.ws.close();
  });

  it('refuses an unknown route without running a turn', async () => {
    const client = await connect();
    client.send({ t: 'wake', wakeId: 'w1', phrase: 'hey nothing', personalityId: 'engineer' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'error')).toBe(true));
    expect(client.frames.find((f) => f.t === 'error')).toMatchObject({
      code: 'unknown_route',
      wakeId: 'w1',
    });
    expect(turns).toEqual([]);
    client.ws.close();
  });

  it('refuses a disabled route without running a turn', async () => {
    const client = await connect();
    client.send({
      t: 'wake',
      wakeId: 'w1',
      phrase: 'hey nobody',
      routeId: 'off',
      personalityId: 'researcher',
    });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'error')).toBe(true));
    expect(client.frames.find((f) => f.t === 'error')).toMatchObject({ code: 'route_disabled' });
    expect(turns).toEqual([]);
    client.ws.close();
  });

  it('refuses a route naming a personality that no longer exists', async () => {
    currentTable = table({
      routes: [
        {
          id: 'g',
          phrase: 'hey ghost',
          personalityId: 'ghost',
          privileged: false,
          enabled: true,
          implicit: false,
        },
      ],
    });
    const client = await connect();
    client.send({
      t: 'wake',
      wakeId: 'w1',
      phrase: 'hey ghost',
      routeId: 'g',
      personalityId: 'ghost',
    });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'error')).toBe(true));
    expect(client.frames.find((f) => f.t === 'error')).toMatchObject({
      code: 'unknown_personality',
    });
    expect(turns).toEqual([]);
    client.ws.close();
  });

  it('keeps a privileged personality off the wake surface unless its route opts in', async () => {
    const client = await connect();
    client.send({
      t: 'wake',
      wakeId: 'w1',
      phrase: 'hey root',
      routeId: 'root',
      personalityId: 'admin',
    });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'error')).toBe(true));
    expect(client.frames.find((f) => f.t === 'error')).toMatchObject({ code: 'privileged_route' });
    expect(turns).toEqual([]);
    client.ws.close();
  });

  it('lets a privileged personality through when the route opts in', async () => {
    currentTable = table({
      routes: [
        {
          id: 'root',
          phrase: 'hey root',
          personalityId: 'admin',
          privileged: true,
          enabled: true,
          implicit: false,
        },
      ],
    });
    const client = await connect();
    await speak(client, 'w1', 'hey root', 'root', 'admin');
    expect(turns).toMatchObject([
      { personalityId: 'admin', sessionKey: 'voice:web:satellite:kitchen:admin' },
    ]);
    client.ws.close();
  });

  it('runs an edge-mode turn from a transcript without ever calling STT', async () => {
    const client = await connect('office', true);
    client.send({
      t: 'wake',
      wakeId: 'w1',
      phrase: 'hey engineer',
      routeId: 'eng',
      personalityId: 'engineer',
    });
    client.send({ t: 'utterance_start', wakeId: 'w1', utteranceId: 'u1', sampleRate: 16_000 });
    client.send({ t: 'transcript', utteranceId: 'u1', text: 'did CI pass' });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'turn_end')).toBe(true));

    // The privacy claim of edge mode is that no audio leaves the machine. If
    // the server transcribed anything, it did not hold.
    expect(transcribeCalls).toBe(0);
    expect(turns).toMatchObject([{ text: 'did CI pass', personalityId: 'engineer' }]);
    // No server transcript is echoed back either — the node produced its own.
    expect(client.frames.some((f) => f.t === 'transcript')).toBe(false);
    client.ws.close();
  });

  it('refuses an utterance with no authorized wake', async () => {
    const client = await connect();
    client.send({ t: 'utterance_start', wakeId: 'never', utteranceId: 'u1', sampleRate: 16_000 });
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'error')).toBe(true));
    expect(client.frames.find((f) => f.t === 'error')).toMatchObject({ code: 'no_wake' });
    expect(turns).toEqual([]);
    client.ws.close();
  });

  it('tracks reported state and returns to listening on playback_done', async () => {
    const client = await connect();
    client.send({ t: 'state', state: 'degraded', detail: 'model file missing' });
    await vi.waitFor(() =>
      expect(registry.list()[0]).toMatchObject({
        state: 'degraded',
        stateDetail: 'model file missing',
      }),
    );
    client.send({ t: 'doctor', probes: [{ name: 'mic', ok: false, detail: 'no device' }] });
    await vi.waitFor(() =>
      expect(registry.list()[0]?.probes).toEqual([{ name: 'mic', ok: false, detail: 'no device' }]),
    );
    client.send({ t: 'playback_done', utteranceId: 'u1' });
    await vi.waitFor(() => expect(registry.list()[0]).toMatchObject({ state: 'listening' }));
    client.ws.close();
  });

  it('mutes one node from the UI and drops its row on disconnect', async () => {
    const client = await connect();
    expect(registry.setWakeEnabled('kitchen', false)).toBe(true);
    await vi.waitFor(() =>
      expect(client.frames.some((f) => f.t === 'set_wake_enabled')).toBe(true),
    );
    expect(registry.list()[0]?.wakeEnabled).toBe(false);
    expect(registry.setWakeEnabled('bedroom', false)).toBe(false);

    client.ws.terminate();
    await vi.waitFor(() => expect(registry.list()).toEqual([]));
  });

  it('ignores a malformed frame with an error rather than dropping the socket', async () => {
    const client = open();
    await new Promise<void>((resolve) => client.ws.on('open', () => resolve()));
    client.ws.send(Buffer.from([9, 9, 9, 9]));
    await vi.waitFor(() => expect(client.frames.some((f) => f.t === 'error')).toBe(true));
    expect(client.frames.find((f) => f.t === 'error')).toMatchObject({ code: 'bad_frame' });
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it('cannot alias another node lane through a nodeId carrying a separator', async () => {
    const a = await connect('kitchen:engineer');
    const b = await connect('kitchen');
    await speak(a, 'wa', 'hey engineer', 'eng', 'engineer');
    await speak(b, 'wb', 'hey engineer', 'eng', 'engineer');

    const keys = [...sessions.keys()];
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
    a.ws.close();
    b.ws.close();
  });
});
