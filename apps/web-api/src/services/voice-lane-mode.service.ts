import { LaneVoiceModeStore, laneVoiceModePath } from '@ethosagent/core';
import type { Storage, VoiceMode } from '@ethosagent/types';

// Per-conversation voice mode for the browser Chat surface.
//
// The durable document (`<ethosDir>/voice/lane-modes.json`) is SHARED with the
// gateway's channel lanes, which is the point: a mode is one fact, not one fact
// per surface. It also means the two key spaces live in one map, so a web
// conversation's key is prefixed rather than being the bare session key — see
// `webLaneKey`.

/**
 * Lane key for a browser conversation.
 *
 * The `web:` prefix is load-bearing. Gateway lanes are keyed
 * `${platform}:${botKey}:${chatId}`, and web session keys are operator- and
 * client-chosen strings; without a namespace of its own a web session could be
 * named to collide with a channel lane and the two conversations would silently
 * share one mode. Prefixing is also what lets a future reader tell the two
 * apart when it lists the document.
 */
function webLaneKey(sessionId: string): string {
  return `web:${sessionId}`;
}

export interface VoiceLaneModeServiceOptions {
  storage: Storage;
  /** Ethos home directory — the lane document lives under `<dataDir>/voice/`. */
  dataDir: string;
  /** `voice.defaultMode`. Absent → the store's own `mirror_inbound`. */
  defaultMode?: VoiceMode;
  /** Reports a write that did not land; the in-memory value still changed. */
  onError?: (err: string) => void;
}

export class VoiceLaneModeService {
  /** One store for the process. Constructed once so the parsed document is
   *  cached across requests instead of being re-read per header render. */
  private readonly store: LaneVoiceModeStore;

  constructor(opts: VoiceLaneModeServiceOptions) {
    this.store = new LaneVoiceModeStore({
      storage: opts.storage,
      path: laneVoiceModePath(opts.dataDir),
      ...(opts.defaultMode ? { defaultMode: opts.defaultMode } : {}),
      ...(opts.onError ? { onError: opts.onError } : {}),
    });
  }

  /**
   * The conversation's mode plus the deployment default it would inherit.
   *
   * Both are returned because a lane with no override is INHERITING, and a
   * three-state toggle that cannot say so has to pretend the inherited value
   * was chosen.
   */
  async get(sessionId: string): Promise<{ mode: VoiceMode; default: VoiceMode }> {
    return {
      mode: await this.store.get(webLaneKey(sessionId)),
      default: this.store.defaultMode,
    };
  }

  /**
   * The mode for an ALREADY-NAMESPACED lane key — one built by `voiceLaneKey`
   * or `satelliteLaneKey`, which start with `voice:`.
   *
   * No `web:` prefix, deliberately. That prefix exists because a browser
   * session id is an arbitrary operator-chosen string that could be named to
   * collide with a channel lane. A `voice:` key is not arbitrary: it is built
   * segment-encoded by the one lane-key encoder, and the gateway's own voice
   * lanes live under it in this same document. Prefixing would put a satellite
   * in a different key space than every other voice conversation, which is the
   * opposite of the "a mode is one fact" property this store exists for.
   */
  async getForLane(laneKey: string): Promise<VoiceMode> {
    return this.store.get(laneKey);
  }

  /** Persist this conversation's mode. */
  async set(sessionId: string, mode: VoiceMode): Promise<{ mode: VoiceMode }> {
    await this.store.set(webLaneKey(sessionId), mode);
    return { mode };
  }
}
