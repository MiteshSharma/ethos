import type { AgentEvent, PcmChunk, VoiceMode } from '@ethosagent/types';
import { encodeWav } from '@ethosagent/voice-session';
import {
  matchWakePhrase,
  SentenceChunker,
  sanitizeForSpeech,
  shouldReplyWithVoice,
  stripWakePhrase,
} from '@ethosagent/voice-text';
import {
  pcm16FromBytes,
  SATELLITE_SOCKET_VERSION,
  type SatelliteClientFrame,
  type SatelliteServerFrame,
} from '@ethosagent/web-contracts';
import type { WakeRoute } from '../repositories/config.repository';
import { isNoSpeechError } from './no-speech';
import type { SatelliteNode, SatelliteRegistry } from './satellite-registry';
import { MIME_BY_FORMAT } from './voice-lane';

// One connected wake satellite, server-side.
//
// Same posture as `VoiceLane`, deliberately: a lane owns EXACTLY one WebSocket
// and nothing outside it, every field below is an instance field, and the
// transport is injected as `send` so the protocol is testable without a socket.
// Two microphones in two rooms are two `SatelliteLane` objects that cannot
// observe each other. The one shared object is the `SatelliteRegistry`, which
// holds the per-node ROWS the UI renders — never per-utterance audio.
//
// What is different from the browser lane is what a room is: the client is an
// appliance nobody is looking at, so a wake it sends must be RE-RESOLVED here
// (its pushed routing table can be one push stale), the reply is spoken into a
// room rather than into a tab, and the microphone must be told when it may
// listen again.
//
// ── WHO DECIDES THAT A TURN HAPPENS ──────────────────────────────────────────
//
// A microphone in a room hears everything. What separates an instruction from
// a conversation happening near the appliance is ADDRESSING, and this lane is
// where addressing is decided, because this is where the transcript is:
//
//   phraseMatch: true   The node compared sound against the pushed table before
//                       it sent anything. Its `wake` names a route; we
//                       re-resolve and trust it, and we do NOT match again —
//                       a second gate on a transcript that renders the phrase
//                       differently from the way the spotter heard it would
//                       refuse the utterance the node correctly woke on.
//
//   phraseMatch: false  The node heard SOUND. Every utterance is transcribed
//                       and then matched HERE against the effective route
//                       table. A match picks the personality and is stripped
//                       from the text; an unmatched utterance inside the
//                       addressing window continues the conversation already in
//                       progress; anything else runs no turn, calls no model,
//                       and is discarded with a `transcript` and a `turn_end`.
//
// THE ADDRESSING WINDOW is per-lane and per-connection. It holds who the room
// is talking to and when it last said something, so "tell me more" reaches the
// personality that answered a moment ago. It is NOT the session: the session
// lives in the store under a lane key derived from the stable node id, so a
// reconnect — which an operator experiences as a fresh start — drops the window
// and keeps every word of the history (eng-review D15).

/** Provider seams the lane drives. All per-turn, all abortable. */
export interface SatelliteLaneDeps {
  /** Transcribe one complete utterance (WAV bytes) → text + provider that ran. */
  transcribe(
    audio: { data: Uint8Array; mimeType: string },
    opts: { personalityId?: string; signal: AbortSignal },
  ): Promise<{ text: string; provider: string }>;
  /** Stream one reply sentence's audio. */
  synthesize(
    text: string,
    opts: { personalityId?: string; signal: AbortSignal },
  ): AsyncIterable<{ audio: Uint8Array; format: 'opus' | 'mp3' | 'wav' | 'pcm'; provider: string }>;
  /**
   * Refresh the personality registry, then report what this id resolves to.
   *
   * One seam rather than two because the refresh is not optional: the whole
   * point of re-resolving a wake is that the satellite's table can name a
   * personality that has since been deleted, renamed, or had a consequential
   * tool added to its toolset. Splitting "refresh" from "look up" is how a
   * caller ends up doing the second without the first.
   */
  resolvePersonality(id: string): Promise<{ exists: boolean; privileged: boolean }>;
  /** Run one turn on the agent loop. */
  runTurn(input: {
    text: string;
    sessionKey: string;
    personalityId: string;
    signal: AbortSignal;
  }): AsyncIterable<AgentEvent>;
  /** The persisted voice mode for a lane key. */
  voiceMode(laneKey: string): Promise<VoiceMode>;
  /** This deployment's satellite lane key — `satelliteLaneKey` with a botKey. */
  laneKey(nodeId: string, personalityId: string): string;
  /**
   * Structured lane events for the audit trail. Never user-facing — the node
   * learns about its turn from frames, not from this.
   *
   * Optional: absent means no rows, never a broken turn.
   */
  observe?(code: string, details: Record<string, unknown>): void;
}

/**
 * The audit sink lane events are written through.
 *
 * Structurally the method wiring's `EthosObservability` already exposes, so
 * boot code can pass that instance straight in. `recordSafetyBlock` is this
 * codebase's generic event sink — the gateway's skipped voice notes ride it
 * too — not a claim that a satellite with no loudspeaker is a safety
 * violation.
 */
export interface SatelliteObservability {
  recordSafetyBlock(opts: { code: string; details?: Record<string, unknown> }): void;
}

export interface SatelliteLaneLimits {
  /** Cap on captured audio per utterance. Beyond it the utterance is dropped. */
  maxUtteranceBytes: number;
  /** How many utterances a lane remembers. Older ones count as superseded. */
  maxTrackedUtterances: number;
  /** How many resolved-but-unspoken wakes a lane holds. */
  maxPendingWakes: number;
}

export const DEFAULT_SATELLITE_LANE_LIMITS: SatelliteLaneLimits = {
  // ~4 minutes of 16 kHz mono PCM — the same bound the browser lane uses, for
  // the same reason: long enough for any real utterance, small enough that a
  // stuck or hostile node cannot grow the heap without bound.
  maxUtteranceBytes: 8 * 1024 * 1024,
  maxTrackedUtterances: 8,
  maxPendingWakes: 4,
};

export interface SatelliteLaneOptions {
  laneId: string;
  deps: SatelliteLaneDeps;
  registry: SatelliteRegistry;
  /** Deliver one frame to THIS lane's socket. */
  send(frame: SatelliteServerFrame, payload?: Uint8Array): void;
  limits?: Partial<SatelliteLaneLimits>;
}

/** A wake waiting for the utterance it triggered. */
interface PendingWake {
  wakeId: string;
  /**
   * The authorized personality, or null when the SERVER still has to decide.
   *
   * Null is the gating case: the node reported speech, not a phrase, so there
   * is nothing to authorize until the transcript exists. See {@link
   * SatelliteLane.address}.
   */
  personalityId: string | null;
  /**
   * `ethos listen --route`: only this route may match on this microphone.
   *
   * A NARROWING, never a bypass. A pinned node still has to be addressed by
   * phrase — the pin only says which phrase this host is allowed to answer to,
   * which is how one microphone is dedicated to one agent in a house whose
   * table holds six.
   */
  pinnedRouteId?: string;
}

interface UtteranceState {
  id: string;
  /**
   * Who this utterance is for. Null until the gate decides — see `address`.
   * Everything downstream (the lane key, the reply attribution, `turn_end`)
   * reads it AFTER that point.
   */
  personalityId: string | null;
  /** Carried from the wake: the route this microphone is pinned to, if any. */
  pinnedRouteId?: string;
  sampleRate: number;
  chunks: PcmChunk[];
  bytes: number;
  controller: AbortController;
  superseded: boolean;
  /**
   * Which input path this utterance committed to. `audio` and `edge` are
   * ALTERNATIVES per the wire contract — a node sends PCM or a transcript,
   * never both — and recording the choice is what lets the second one be
   * refused instead of quietly running the turn twice.
   */
  input: 'audio' | 'edge' | null;
  /**
   * Whether this utterance's `turn_end` has been accounted for — either sent,
   * or deliberately withheld because a newer utterance took the floor. See
   * {@link SatelliteLane.endTurn}; this flag is what makes the emit point
   * single and the emission exactly-once.
   */
  ended: boolean;
  /** Serializes this utterance's synthesis so reply segments stay in order. */
  synthChain: Promise<void>;
}

export class SatelliteLane {
  private readonly opts: SatelliteLaneOptions;
  private readonly limits: SatelliteLaneLimits;
  private readonly wakes = new Map<string, PendingWake>();
  private readonly utterances = new Map<string, UtteranceState>();
  /** Per-utterance segment counter, so segment ids are ordered and unique. */
  private readonly segmentSeq = new Map<string, number>();
  private nodeId: string | null = null;
  /**
   * Whether this node has somewhere to PLAY audio, from its `register` frame.
   *
   * Read at the synthesis call site and nowhere else — see `runTurn`. False
   * until a node registers, which is unreachable in practice (a turn needs a
   * `nodeId`) and the safe way round if it ever stops being.
   */
  private playback = false;
  /**
   * Whether this node matches wake phrases itself, from its `register` frame.
   *
   * False until a node registers, and that is the fail-closed direction: an
   * unregistered lane cannot run a turn anyway, and if it ever could, the
   * server gating is the half that refuses rather than the half that trusts.
   */
  private phraseMatch = false;
  /**
   * Who the room is talking to, and when it last said something to them.
   *
   * Gating nodes only — a `phraseMatch: true` node addresses every utterance
   * explicitly, so there is no window to hold. Null means the next utterance
   * must open with a wake phrase.
   */
  private conversation: { personalityId: string; lastTurnAt: number; timeoutMs: number } | null =
    null;
  private closed = false;
  /** Serializes frame dispatch — see {@link handle}. */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: SatelliteLaneOptions) {
    this.opts = opts;
    this.limits = { ...DEFAULT_SATELLITE_LANE_LIMITS, ...opts.limits };
  }

  /**
   * Handle one decoded client frame.
   *
   * SERIALIZED, and that is load-bearing. A satellite sends `wake` and then
   * `utterance_start` back to back, and resolving the wake is asynchronous —
   * it re-reads the routing table and re-resolves the personality. Dispatching
   * each frame the moment it arrives means the utterance looks up a wake that
   * has not finished authorizing yet, and the turn is dropped with `no_wake`.
   * Frames arrive in order on the wire; this is what makes them HANDLED in
   * order too.
   *
   * The chain only covers the fast, ordering-critical work. Transcription and
   * the turn itself detach (see `dispatch`), so a long reply cannot stall the
   * `state` and `playback_done` frames that keep the microphone honest.
   *
   * Never throws. A room-scale listener that loses its socket to an unhandled
   * rejection stops listening silently, which is the failure the supervised
   * capture state machine exists to avoid — so every path out of here is an
   * `error` frame, and an UNEXPECTED one also marks the row degraded so the
   * Settings row can say the node is not answering properly. A refused wake is
   * not degraded: the microphone is fine, the routing table is wrong.
   */
  handle(frame: SatelliteClientFrame, payload: Uint8Array): void {
    if (this.closed) return;
    this.chain = this.chain.then(() => this.guard(() => this.dispatch(frame, payload)));
  }

  private async dispatch(frame: SatelliteClientFrame, payload: Uint8Array): Promise<void> {
    if (this.closed) return;
    switch (frame.t) {
      case 'register':
        await this.onRegister(frame);
        return;
      case 'state':
        this.patchNode({
          state: frame.state,
          ...(frame.detail ? { stateDetail: frame.detail } : { stateDetail: undefined }),
        });
        return;
      case 'doctor':
        this.patchNode({ probes: frame.probes.map((p) => ({ ...p })) });
        return;
      case 'wake':
        await this.onWake(frame);
        return;
      case 'utterance_start':
        this.startUtterance(frame.wakeId, frame.utteranceId, frame.sampleRate);
        return;
      case 'audio':
        this.appendAudio(frame.utteranceId, payload);
        return;
      // The two turn entry points DETACH: everything before them had to be in
      // order, everything after them is a conversation that may run for a
      // minute, and blocking the frame chain on it would deafen the node. Both
      // go through `withTurnEnd`, which is what guarantees the node gets its
      // microphone back however the turn finishes.
      case 'utterance_end':
        void this.guard(() =>
          this.withTurnEnd(frame.utteranceId, (state) => this.finishUtterance(state)),
        );
        return;
      case 'transcript':
        void this.guard(() =>
          this.withTurnEnd(frame.utteranceId, (state) => this.onEdgeTranscript(state, frame.text)),
        );
        return;
      case 'playback_done':
        this.patchNode({ state: 'listening', stateDetail: undefined });
        return;
    }
  }

  /** Socket closed. Abort everything in flight; keep no audio around. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.utterances.values()) {
      state.superseded = true;
      state.chunks = [];
      state.controller.abort();
    }
    this.utterances.clear();
    this.wakes.clear();
    // The addressing window dies with the connection, and the SESSION does not.
    // An operator who restarts a satellite (or watches it survive a router
    // reboot) experiences a fresh start, and having the room still be
    // mid-conversation with whoever it addressed before the outage would be a
    // turn arriving at a personality nobody in the room named. The history is
    // untouched: it is filed under a lane key derived from the stable node id,
    // so re-waking the same personality resumes it word for word (D15).
    this.conversation = null;
    if (this.nodeId) this.opts.registry.unregister(this.nodeId, this.opts.laneId);
    this.nodeId = null;
  }

  // --- registration -------------------------------------------------------

  private async onRegister(frame: Extract<SatelliteClientFrame, { t: 'register' }>): Promise<void> {
    // Load the table BEFORE announcing readiness: a node that gets `ready` and
    // no `routes` has nothing to listen for, and would have to guess whether
    // the push is coming.
    await this.opts.registry.table();
    const node: SatelliteNode = {
      nodeId: frame.nodeId,
      laneId: this.opts.laneId,
      ...(frame.displayName ? { displayName: frame.displayName } : {}),
      capabilities: { ...frame.capabilities },
      // Trusted from the node until its first `state` frame: only the node can
      // see its own capture loop, and claiming `listening` on its behalf here
      // is the mic-indicator lie the `state` frame exists to prevent.
      state: frame.wakeEnabled ? 'listening' : 'wake_off',
      wakeEnabled: frame.wakeEnabled,
      probes: [],
      connectedAt: Date.now(),
    };
    this.nodeId = frame.nodeId;
    this.playback = frame.capabilities.playback;
    this.phraseMatch = frame.capabilities.phraseMatch;
    this.opts.registry.register(node, this.opts.send);
    this.opts.send({
      t: 'ready',
      nodeId: frame.nodeId,
      laneId: this.opts.laneId,
      protocolVersion: SATELLITE_SOCKET_VERSION,
    });
    this.opts.registry.pushRoutes(frame.nodeId);
  }

  // --- wake ---------------------------------------------------------------

  private async onWake(frame: Extract<SatelliteClientFrame, { t: 'wake' }>): Promise<void> {
    const nodeId = this.nodeId;
    if (!nodeId) {
      this.fail('not_registered', 'Send `register` before waking.', { wakeId: frame.wakeId });
      return;
    }
    if (!this.phraseMatch) {
      // NOTHING TO AUTHORIZE YET. This node reported speech onset, not a
      // phrase; who was addressed is a question about words nobody has
      // transcribed. The wake is recorded unresolved and `address` decides once
      // the transcript exists — including the refusal paths, which is why
      // `authorizeRoute` is one function called from two places.
      this.rememberWake({
        wakeId: frame.wakeId,
        personalityId: null,
        ...(frame.routeId ? { pinnedRouteId: frame.routeId } : {}),
      });
      return;
    }
    const table = await this.opts.registry.table();
    // Resolve against the SERVER's table, never the satellite's claim. The
    // frame carries `personalityId` because the node already matched, but its
    // copy can be one push stale — and the personality is what decides toolset
    // and memory scope.
    const phrase = frame.phrase;
    const route = frame.routeId
      ? table.routes.find((r) => r.id === frame.routeId)
      : phrase
        ? table.routes.find((r) => r.phrase.toLowerCase() === phrase.toLowerCase())
        : undefined;
    if (!route) {
      // Named by whichever the node actually sent — a route id and a phrase
      // are different claims, and quoting an id as though it were something
      // somebody said sends the operator looking for the wrong thing.
      this.fail(
        'unknown_route',
        frame.routeId === undefined
          ? `No wake route matches "${phrase ?? ''}".`
          : `No wake route "${frame.routeId}" in this deployment's table.`,
        { wakeId: frame.wakeId },
      );
      return;
    }
    const personalityId = await this.authorizeRoute(route, { wakeId: frame.wakeId });
    if (personalityId === null) return;
    this.rememberWake({ wakeId: frame.wakeId, personalityId });
    this.patchNode({
      lastWake: { phrase: route.phrase, personalityId, at: Date.now() },
    });
  }

  private rememberWake(wake: PendingWake): void {
    this.wakes.set(wake.wakeId, wake);
    this.evictOldest(this.wakes, this.limits.maxPendingWakes);
  }

  /**
   * MAY THIS ROUTE RUN A TURN? The one authorization decision on this lane.
   *
   * Extracted because it now runs at two points in the flow — when a
   * phrase-matching node sends a `wake`, and when the server's own gate matches
   * a transcript — and two copies of an access-control rule is one copy that
   * eventually says yes where the other says no. Returns the personality id, or
   * null having already told the node why not.
   */
  private async authorizeRoute(
    route: WakeRoute,
    ids: { wakeId?: string; utteranceId?: string },
  ): Promise<string | null> {
    if (!route.enabled) {
      this.fail('route_disabled', `Wake route "${route.id}" is disabled.`, ids);
      return null;
    }
    const resolved = await this.opts.deps.resolvePersonality(route.personalityId);
    if (!resolved.exists) {
      this.fail('unknown_personality', `Route "${route.id}" names an unknown personality.`, ids);
      return null;
    }
    // eng-review D13: a privileged personality is reachable by voice only when
    // the route says so out loud. Refused, never downgraded to some safer
    // default — a wake that answers as somebody else is worse than one that
    // does not answer.
    if (resolved.privileged && !route.privileged) {
      this.fail(
        'privileged_route',
        `"${route.personalityId}" is privileged; set voice.wake.routes.${route.id}.privileged: true to reach it by voice.`,
        ids,
      );
      return null;
    }
    return route.personalityId;
  }

  // --- capture ------------------------------------------------------------

  private startUtterance(wakeId: string, id: string, sampleRate: number): void {
    const wake = this.wakes.get(wakeId);
    if (!wake) {
      // Either the wake was refused or it never arrived. Running the turn
      // anyway would mean picking a personality nobody authorized.
      this.fail('no_wake', 'No authorized wake for this utterance.', { utteranceId: id });
      return;
    }
    // A new utterance supersedes every older one — including a restart under
    // the same id: the speaker moved on, and a reply still in flight for a
    // previous utterance must not reach the room.
    for (const previous of this.utterances.keys()) this.supersede(previous);
    this.utterances.set(id, {
      id,
      personalityId: wake.personalityId,
      ...(wake.pinnedRouteId ? { pinnedRouteId: wake.pinnedRouteId } : {}),
      sampleRate,
      chunks: [],
      bytes: 0,
      controller: new AbortController(),
      superseded: false,
      input: null,
      ended: false,
      synthChain: Promise.resolve(),
    });
    this.evictOverflow();
  }

  private appendAudio(id: string, payload: Uint8Array): void {
    const state = this.utterances.get(id);
    if (!state || state.superseded) return;
    if (state.input === 'edge') {
      this.fail('duplicate_input', 'This utterance was already transcribed on-device.', {
        utteranceId: id,
      });
      return;
    }
    state.input = 'audio';
    if (state.bytes + payload.length > this.limits.maxUtteranceBytes) {
      this.fail('utterance_too_long', 'Utterance exceeded the capture limit and was discarded.', {
        utteranceId: id,
      });
      // Ended here, before the discard: the node is still capturing and will
      // send `utterance_end` next, which suppresses its microphone until a
      // `turn_end` that `finishUtterance` will never send for an utterance it
      // finds already superseded. `endTurn` before `supersede`, so the order on
      // the wire is `error` → `turn_end`.
      this.endTurn(state);
      this.supersede(id);
      return;
    }
    state.bytes += payload.length;
    state.chunks.push({ data: pcm16FromBytes(payload), sampleRate: state.sampleRate });
  }

  private async finishUtterance(state: UtteranceState): Promise<void> {
    const id = state.id;
    const chunks = state.chunks;
    // The captured PCM is not needed once it has been handed to STT; holding it
    // would keep raw voice from someone's kitchen in memory for no reason.
    state.chunks = [];
    let text: string;
    let provider: string;
    try {
      const result = await this.opts.deps.transcribe(
        { data: encodeWav(chunks, state.sampleRate), mimeType: 'audio/wav' },
        {
          // Absent on a gating node: which personality this utterance belongs
          // to is decided FROM the transcript, so it cannot bias the
          // recognizer that produces it.
          ...(state.personalityId ? { personalityId: state.personalityId } : {}),
          signal: state.controller.signal,
        },
      );
      text = result.text;
      provider = result.provider;
    } catch (err) {
      if (this.isStale(state)) return;
      // NOTHING WAS SAID IS NOT A FAILURE, and it must not be dressed as one.
      // A satellite watches an open microphone in a room, so an utterance that
      // turns out to be a door closing is ordinary traffic — the node's own
      // minimum-speech guard drops most of them before they ever get here, and
      // the ones that survive it are the provider agreeing there was no speech.
      // An `error` frame for that tells the user something broke and invites
      // them to repeat a thing they never said.
      //
      // NO NEW FRAME TYPE. The two frames that already say it are `transcript`
      // — what the server HEARD, which is nothing — and `turn_end`, the cue the
      // node re-arms on. The `turn_end` is not sent here: `withTurnEnd` sends it
      // for EVERY way out of this function, which is what makes this path no
      // longer special (`error` alone used to leave the node parked in
      // `speaking` until its playback watchdog fired, minutes later — and so
      // did the genuine-failure path below).
      if (isNoSpeechError(err)) {
        this.opts.deps.observe?.('satellite.no_speech', {
          nodeId: this.nodeId,
          personalityId: state.personalityId,
          utteranceId: id,
        });
        this.opts.send({ t: 'transcript', utteranceId: id, text: '', final: true });
        return;
      }
      this.fail('transcribe_failed', errorMessage(err, 'Could not transcribe audio'), {
        utteranceId: id,
      });
      return;
    }
    if (this.isStale(state)) return;
    // Sent BEFORE the gate, and for a gating node that is the point: the
    // operator sees what the room said whether or not it was addressed to
    // anybody, so an unmatched utterance is legible rather than a silence.
    this.opts.send({ t: 'transcript', utteranceId: id, text, final: true, provider });
    await this.addressAndRun(state, text);
  }

  /**
   * EDGE MODE — the node transcribed on-device, so no audio ever left it.
   *
   * The turn starts here and `utterance_end` never comes: on an edge node the
   * transcript IS the end of the utterance.
   */
  private async onEdgeTranscript(state: UtteranceState, text: string): Promise<void> {
    if (state.input === 'audio') {
      // Refused, and the turn ends with it. A node that streams audio AND a
      // transcript for one utterance is breaking the wire contract, so there
      // is no correct moment to re-arm it; ending here at least bounds the
      // damage to "re-armed early" instead of "deaf for two minutes".
      this.fail('duplicate_input', 'This utterance already streamed audio upstream.', {
        utteranceId: state.id,
      });
      return;
    }
    state.input = 'edge';
    // No `transcript` echo: the node produced these words itself and already
    // has them. It still learns an unaddressed utterance ran no turn, from a
    // `turn_end` that names no personality.
    await this.addressAndRun(state, text);
  }

  // --- addressing -----------------------------------------------------------

  private async addressAndRun(state: UtteranceState, text: string): Promise<void> {
    const addressed = await this.address(state, text);
    if (addressed === null) return;
    state.personalityId = addressed.personalityId;
    await this.runTurn(state, addressed.text);
  }

  /**
   * WHO WAS THIS SAID TO, and what did they actually ask?
   *
   * Null means nobody — no turn, no model call, no reply. That is the ordinary
   * case for a microphone in a room, not an error, so it is quiet: the
   * transcript has already gone back so the operator can see what was heard,
   * `withTurnEnd` sends the re-arm cue behind this, and the only other trace is
   * an audit row.
   */
  private async address(
    state: UtteranceState,
    text: string,
  ): Promise<{ personalityId: string; text: string } | null> {
    // A phrase-matching node already addressed this utterance and the wake was
    // authorized on arrival. Matching again here would be a SECOND gate over a
    // transcript the spotter never saw.
    const authorized = state.personalityId;
    if (authorized !== null) return { personalityId: authorized, text };

    const table = await this.opts.registry.table();
    // The EFFECTIVE table — implicit `auto:` routes included, because
    // `readTable` merges them. Disabled routes are not part of the wake
    // surface, so an utterance that opens with a disabled route's phrase is
    // simply not addressed to anyone rather than an error about a route the
    // speaker cannot see.
    //
    // Matched against the WHOLE table even when this microphone is pinned,
    // which is the difference between "nobody was addressed" and "somebody
    // else was". Narrowing the candidates first would make "hey engineer" at a
    // researcher-pinned mic look like an unaddressed sentence and hand it to
    // whatever conversation was open — putting one agent's words in another
    // agent's mouth, which is exactly what the pin exists to prevent.
    const pin = state.pinnedRouteId;
    const enabled = table.routes.filter((route) => route.enabled);
    const match = matchWakePhrase(
      enabled.map((route) => ({ id: route.id, phrase: route.phrase })),
      text,
      table.settings.sensitivity,
    );
    const matched = match === null ? undefined : enabled.find((r) => r.id === match.id);

    if (match !== null && matched !== undefined) {
      if (pin !== undefined && matched.id !== pin) {
        // Addressed — to an agent this microphone does not serve. Not a
        // follow-up and not an error: the speaker named somebody, and it was
        // not the one this host was dedicated to.
        this.opts.deps.observe?.('satellite.not_pinned', {
          nodeId: this.nodeId,
          utteranceId: state.id,
          routeId: matched.id,
          pinnedRouteId: pin,
        });
        return null;
      }
      // The MATCHED route decides, not whatever the wake frame claimed — a
      // gating node claims nothing, and this is why it does not have to.
      const personalityId = await this.authorizeRoute(matched, { utteranceId: state.id });
      if (personalityId === null) return null;
      this.patchNode({ lastWake: { phrase: matched.phrase, personalityId, at: Date.now() } });
      this.touchConversation(personalityId, table.settings.idleTimeoutMs);
      // The phrase is ADDRESSING, not content: "hey researcher, what's the
      // weather" is a question about the weather. A bare phrase strips to
      // nothing, and an empty turn is worse than a redundant one, so the full
      // text stands in — someone who says only "hey researcher" is asking for
      // attention and should get an answer, not silence.
      const remainder = stripWakePhrase(text, match);
      return { personalityId, text: remainder.length > 0 ? remainder : text };
    }

    // No phrase. Is the room already mid-conversation with somebody?
    const continuing = this.openConversation(table.settings.idleTimeoutMs);
    if (continuing !== null) {
      this.opts.deps.observe?.('satellite.follow_up', {
        nodeId: this.nodeId,
        personalityId: continuing,
        utteranceId: state.id,
      });
      this.touchConversation(continuing, table.settings.idleTimeoutMs);
      // Nothing to strip: there was no phrase in front of it.
      return { personalityId: continuing, text };
    }

    // Nobody was addressed. `chars` rather than the words themselves — the
    // audit trail is not the place to keep a recording of somebody's kitchen.
    this.opts.deps.observe?.('satellite.no_match', {
      nodeId: this.nodeId,
      utteranceId: state.id,
      chars: text.length,
      ...(pin === undefined ? {} : { pinnedRouteId: pin }),
    });
    return null;
  }

  /**
   * The personality the room is still talking to, or null.
   *
   * Reads the clock rather than holding a timer: a timer would fire in a
   * process that has nothing to do with the answer, and the only moment the
   * answer is needed is when an unaddressed utterance arrives.
   */
  private openConversation(timeoutMs: number): string | null {
    const current = this.conversation;
    if (current === null) return null;
    // `>=`, so a timeout of zero means "no window at all" rather than "a window
    // one millisecond wide". Config bounds it at 5 s, but the wire frame allows
    // zero and the honest reading of zero is off.
    if (Date.now() - current.lastTurnAt >= timeoutMs) {
      this.conversation = null;
      this.patchNode({ conversation: undefined });
      return null;
    }
    return current.personalityId;
  }

  /** Open or extend the addressing window, and say so on the node's row. */
  private touchConversation(personalityId: string, timeoutMs: number): void {
    const at = Date.now();
    this.conversation = { personalityId, lastTurnAt: at, timeoutMs };
    this.patchNode({ conversation: { personalityId, until: at + timeoutMs } });
  }

  // --- the turn -----------------------------------------------------------

  private async runTurn(state: UtteranceState, text: string): Promise<void> {
    const nodeId = this.nodeId;
    // `address` sets the personality before this is reached, on both paths.
    // Narrowed rather than asserted, per the codebase's no-`!` rule.
    const personalityId = state.personalityId;
    if (!nodeId || personalityId === null || this.isStale(state)) return;
    const sessionKey = this.opts.deps.laneKey(nodeId, personalityId);
    // The ONE voice-reply decision (voice V1a, eng-review D3). A wake turn is
    // voice-origin even though the transcript is text by the time it gets here,
    // which is what `wakeTriggered` says — and `off` still wins, because it is
    // an explicit user opt-out and nothing overrides it, wake included.
    const speak = shouldReplyWithVoice({
      mode: await this.opts.deps.voiceMode(sessionKey),
      inboundHadAudio: true,
      wakeTriggered: true,
    });
    if (this.isStale(state)) return;
    // TRANSPORT, not policy — and the two must stay apart.
    //
    // `shouldReplyWithVoice` above is the ONE place "should this turn speak?"
    // is answered, and `playback` is deliberately NOT one of its inputs: the
    // answer is the same whether or not the node owns a loudspeaker. What
    // `capabilities.playback: false` says is that there is nowhere to send the
    // bytes — `ethos listen` on a headless Pi warns once and discards them —
    // so synthesizing anyway buys full TTS latency and provider spend for
    // audio thrown away on arrival. Gate the SEND here, after the decision;
    // do NOT fold this into `shouldReplyWithVoice`, or every surface that
    // shares that function inherits one lane's transport problem as policy.
    const speakAudio = speak && this.playback;
    if (speak && !this.playback) {
      this.opts.deps.observe?.('satellite.voice_no_playback', {
        nodeId,
        personalityId,
        utteranceId: state.id,
      });
    }
    // `speaking` only when something will actually be spoken: a row that says
    // speaking for a node with no loudspeaker is the same class of lie as a
    // mic indicator that says listening when the capture loop is wedged.
    if (speakAudio) this.patchNode({ state: 'speaking', stateDetail: undefined });

    const chunker = new SentenceChunker();
    // SANITIZE THE ACCUMULATED REPLY, CHUNK WHAT IT GREW BY.
    //
    // The chunker must never see markup: `**done**` read aloud is "asterisk
    // asterisk done", a fence is gibberish, a URL is spelled out. But the
    // sanitizer works on WHOLE constructs, not sentences — a fence or a
    // `<think>` block opened in one sentence and closed four later is
    // invisible to a per-sentence call, so sanitizing the chunker's OUTPUT
    // leaks exactly the middle of the fence that sanitizing the document
    // removes. The gateway sidesteps this by synthesizing the reply in one
    // batch call (`deliverVoiceReply`), so it sanitizes once; a streaming lane
    // cannot, because buffering the whole reply is the latency the chunker
    // exists to avoid.
    //
    // So the sanitizer runs on the accumulated raw reply after every delta,
    // and the chunker is fed only the suffix that grew. The trade-off is one
    // re-sanitize per delta over a string bounded by the reply length — pure,
    // allocation-only work, no I/O — bought against playing markup into a
    // room. What makes the suffix safe to slice is that the constructs which
    // span sentences are removed from the moment they OPEN: an unterminated
    // fence or `<think>` swallows everything after it
    // (`CODE_FENCE_UNTERMINATED`), so the sanitized text simply stops growing
    // until the construct closes, and the prefix already fed stays put.
    let reply = '';
    let fed = 0;
    // Exactly the text handed to `synthesize`, in order. `reply_text` is built
    // from this rather than sanitizing `reply` a second time, so the words the
    // operator reads and the words the room hears are the same by
    // construction, not by two pipelines happening to agree.
    const spoken: string[] = [];
    const say = (sentence: string): void => {
      spoken.push(sentence);
      this.queueSpeech(state, sentence, speakAudio);
    };
    try {
      for await (const event of this.opts.deps.runTurn({
        text,
        sessionKey,
        personalityId,
        signal: state.controller.signal,
      })) {
        if (this.isStale(state)) return;
        if (event.type === 'text_delta') {
          reply += event.text;
          const clean = sanitizeForSpeech(reply);
          // `>` and not `!==`: an opening fence makes the sanitized text
          // SHRINK, and there is nothing to do about that — what has been
          // spoken cannot be unspoken. Feeding resumes when the fence closes
          // and the text grows past the mark again.
          if (clean.length > fed) {
            const grown = clean.slice(fed);
            fed = clean.length;
            for (const sentence of chunker.push(grown)) say(sentence);
          }
          continue;
        }
        if (event.type === 'error') {
          this.fail('turn_failed', event.error, { utteranceId: state.id });
        }
      }
      const remainder = chunker.flush();
      if (remainder) say(remainder);
    } catch (err) {
      if (this.isStale(state)) return;
      this.fail('turn_failed', errorMessage(err, 'The turn failed'), { utteranceId: state.id });
    }
    // The answer in TEXT, once per turn, and BEFORE the synthesis tail is
    // awaited: the words are known now, and a node with a screen should not
    // wait on TTS for audio it may not even be receiving. Sent whatever
    // `speak` and `playback` decided — a turn that produced an answer must be
    // observable somewhere, and on a satellite there is no other channel.
    // Sanitized, because this lane is a speech surface (see the frame's own
    // contract) — and sanitized ONCE, up in the delta loop: this is the
    // synthesized sentences rejoined, not a second pass over the raw reply.
    // Sentences come out of the splitter trimmed, so a single space is the
    // separator that reconstructs them (the same reconstruction
    // `VoiceSession.reply_complete` uses). A turn that produced no speakable
    // text at all sends nothing.
    const replyText = spoken.join(' ');
    if (replyText.length > 0 && !this.isStale(state)) {
      this.opts.send({
        t: 'reply_text',
        utteranceId: state.id,
        personalityId,
        text: replyText,
      });
    }
    // Every queued segment must be on the wire before `turn_end`, which is the
    // node's cue that nothing further will be spoken — so this await is what
    // holds the turn open, and `withTurnEnd` sends the frame once it returns.
    await state.synthChain;
  }

  /**
   * Queue one sentence for synthesis.
   *
   * Serialized per utterance so segment frames cannot interleave on the wire.
   * The node still receives sentence N+1 while N is playing — synthesis is far
   * faster than playout — without having to reassemble an out-of-order stream.
   */
  private queueSpeech(state: UtteranceState, sentence: string, speakAudio: boolean): void {
    if (!speakAudio) return;
    state.synthChain = state.synthChain.then(() => this.speak(state, sentence));
  }

  private async speak(state: UtteranceState, sentence: string): Promise<void> {
    if (this.isStale(state)) return;
    const segmentId = `${state.id}-s${this.nextSegment(state)}`;
    let seq = 0;
    let started = false;
    try {
      const stream = this.opts.deps.synthesize(sentence, {
        // Always set by the time a sentence is queued — synthesis only happens
        // inside a turn, and a turn only starts once `address` has decided.
        ...(state.personalityId ? { personalityId: state.personalityId } : {}),
        signal: state.controller.signal,
      });
      for await (const chunk of stream) {
        if (this.isStale(state)) return;
        if (!started) {
          started = true;
          this.opts.send({
            t: 'speak_start',
            utteranceId: state.id,
            segmentId,
            codec: chunk.format === 'pcm' ? 'pcm_s16le' : 'encoded',
            mimeType: MIME_BY_FORMAT[chunk.format] ?? 'application/octet-stream',
          });
        }
        this.opts.send({ t: 'audio', utteranceId: state.id, segmentId, seq: seq++ }, chunk.audio);
      }
      if (started) this.opts.send({ t: 'segment_end', utteranceId: state.id, segmentId });
    } catch (err) {
      if (this.isStale(state)) return;
      // Close the segment the node is already buffering, then say why — a node
      // left holding an unterminated segment never plays it and never re-arms.
      if (started) this.opts.send({ t: 'segment_end', utteranceId: state.id, segmentId });
      this.fail('synthesize_failed', errorMessage(err, 'Speech synthesis failed'), {
        utteranceId: state.id,
      });
    }
  }

  private nextSegment(state: UtteranceState): number {
    const next = (this.segmentSeq.get(state.id) ?? 0) + 1;
    this.segmentSeq.set(state.id, next);
    return next;
  }

  // --- plumbing -----------------------------------------------------------

  /** Run an async frame handler; an unexpected throw becomes an error frame
   *  AND a `degraded` row, because a lane that half-failed is not healthy. */
  private async guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.laneError(err);
    }
  }

  /**
   * Run one turn's work to completion and END THE TURN, whatever happens.
   *
   * THE INVARIANT THIS EXISTS FOR: a satellite that has started an utterance is
   * DEAF until it sees `turn_end`. Its `CaptureMachine` models the
   * `utterance_end` → `turn_end` interval as playback — that is the window in
   * which a reply is being produced, and the microphone must not wake the agent
   * with its own voice — and the only other way out of that window is a 120 s
   * playback watchdog. So a terminal path that sends an `error` and stops does
   * not merely fail the turn; it costs the room two minutes of dead microphone
   * for a failure it could have recovered from at once.
   *
   * Which is why the two turn entry points are wrapped HERE rather than each
   * terminal site remembering to send the frame for itself. Remembering is what
   * failed: the happy path and the no-speech path each sent their own
   * `turn_end`, and the failure paths beside them did not. A terminal path
   * added inside `work` later — another provider, another refusal, a throw
   * nobody predicted — is now covered by construction rather than by review.
   *
   * The unexpected-throw error frame is emitted here rather than left to
   * `guard`, because the ordering the node sees must always be
   * `… → error → turn_end`: the reason first, so the operator still gets it,
   * then the cue that gives the microphone back.
   */
  private async withTurnEnd(
    id: string,
    work: (state: UtteranceState) => Promise<void>,
  ): Promise<void> {
    const state = this.utterances.get(id);
    if (!state || state.superseded) return;
    try {
      await work(state);
    } catch (err) {
      if (!this.isStale(state)) this.laneError(err, id);
    } finally {
      this.endTurn(state);
    }
  }

  /**
   * Send this utterance's `turn_end` — the ONE place it is sent, at most once
   * per utterance. See {@link withTurnEnd} for why the frame is load-bearing.
   *
   * Two cases deliberately send nothing:
   *
   * - The lane is CLOSED. There is no socket to write to, and a node that
   *   reconnects re-registers and rebuilds its own capture state from scratch,
   *   so it needs no cue from the connection that went away.
   * - The utterance was RETIRED by `supersede` because a newer one took the
   *   floor. `endPlayback()` on the node re-arms unconditionally and resets the
   *   capture buffer with it, so a stale `turn_end` would abort the utterance
   *   that replaced this one. The newer utterance ends its own turn.
   */
  private endTurn(state: UtteranceState): void {
    if (state.ended) return;
    state.ended = true;
    // A turn that RAN extends the addressing window, whatever it produced. The
    // user is mid-conversation whether or not they re-addressed the agent, and
    // a turn that errored still means they are talking to that personality —
    // making them say the phrase again to hear why it failed would be the
    // machine punishing them for its own fault. An utterance that ran NO turn
    // (nobody addressed, no speech in it) has a null personality and touches
    // nothing.
    const conversation = this.conversation;
    if (conversation !== null && state.personalityId === conversation.personalityId) {
      this.touchConversation(conversation.personalityId, conversation.timeoutMs);
    }
    if (this.closed) return;
    this.opts.send({
      t: 'turn_end',
      utteranceId: state.id,
      // Absent means nobody answered — the utterance was not addressed to any
      // personality. The node renders that as "heard, not addressed".
      ...(state.personalityId ? { personalityId: state.personalityId } : {}),
    });
  }

  /** An unexpected throw: name it to the node, and mark the row degraded. */
  private laneError(err: unknown, utteranceId?: string): void {
    const message = errorMessage(err, 'Satellite lane error');
    this.patchNode({ state: 'degraded', stateDetail: message });
    this.fail('lane_error', message, utteranceId ? { utteranceId } : {});
  }

  private fail(
    code: string,
    message: string,
    ids: { utteranceId?: string; wakeId?: string } = {},
  ): void {
    this.opts.send({
      t: 'error',
      code,
      message,
      ...(ids.utteranceId ? { utteranceId: ids.utteranceId } : {}),
      ...(ids.wakeId ? { wakeId: ids.wakeId } : {}),
    });
  }

  private patchNode(patch: Partial<SatelliteNode>): void {
    if (!this.nodeId) return;
    this.opts.registry.update(this.nodeId, this.opts.laneId, patch);
  }

  private supersede(id: string): void {
    const state = this.utterances.get(id);
    if (!state || state.superseded) return;
    state.superseded = true;
    // RETIRED: whatever ends this utterance, it is not a `turn_end` of ours.
    // Either the newer utterance that displaced it will send its own — and a
    // stale one would reset the capture that replaced this — or the caller has
    // already ended the turn itself (see `appendAudio`'s capture-limit path).
    state.ended = true;
    state.chunks = [];
    state.controller.abort();
  }

  private isStale(state: UtteranceState): boolean {
    return this.closed || state.superseded || this.utterances.get(state.id) !== state;
  }

  /** Keep the tracked-utterance map bounded; evicted utterances are stale. */
  private evictOverflow(): void {
    while (this.utterances.size > this.limits.maxTrackedUtterances) {
      const oldest = this.utterances.keys().next();
      if (oldest.done) return;
      this.supersede(oldest.value);
      this.utterances.delete(oldest.value);
      this.segmentSeq.delete(oldest.value);
    }
  }

  private evictOldest(map: Map<string, unknown>, max: number): void {
    while (map.size > max) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
    }
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
