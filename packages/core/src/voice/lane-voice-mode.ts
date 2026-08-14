/**
 * Durable per-lane voice mode.
 *
 * `shouldReplyWithVoice()` in `@ethosagent/voice-text` decides whether a turn
 * speaks; this decides what MODE that decision reads. The two are separate on
 * purpose — the decision is a pure function with no I/O, and persistence is
 * I/O with no decision in it.
 *
 * Shared by the gateway (channel lanes, keyed by the gateway lane key) and
 * web-api (the browser Chat surface, keyed by session key) so a mode set on
 * one surface is the same fact on the other, and neither carries its own copy.
 *
 * Storage-backed, not SQLite-backed: this is a handful of short strings, it is
 * read on every turn and written only when a human types `/voice`, and
 * `Storage` already covers `~/.ethos/` state. One JSON document written with
 * `writeAtomic` — a partial write here would lose every lane's mode at once.
 */

import { dirname, join } from 'node:path';
import { DEFAULT_VOICE_MODE, type Storage, VOICE_MODES, type VoiceMode } from '@ethosagent/types';

/** Where the lane voice-mode document lives, relative to an Ethos home dir. */
export function laneVoiceModePath(ethosDir: string): string {
  return join(ethosDir, 'voice', 'lane-modes.json');
}

export interface LaneVoiceModeStoreOptions {
  /**
   * Absent → in-memory only (tests, standalone). Same optional-seam pattern the
   * gateway uses for `storage` / `attachmentCache`.
   */
  storage?: Storage;
  /** Absolute path of the JSON document. Required when `storage` is given. */
  path?: string;
  /** `voice.defaultMode` from config. Defaults to `DEFAULT_VOICE_MODE`. */
  defaultMode?: VoiceMode;
  /**
   * Reports a write that did not land. Reads are deliberately NOT reported:
   * a missing or corrupt document is a normal state, not an error.
   */
  onError?: (err: string) => void;
}

function isVoiceMode(value: unknown): value is VoiceMode {
  return typeof value === 'string' && (VOICE_MODES as readonly string[]).includes(value);
}

export class LaneVoiceModeStore {
  /** The default a lane with no override gets. */
  readonly defaultMode: VoiceMode;

  private readonly persist: { storage: Storage; path: string } | null;
  private readonly onError: ((err: string) => void) | undefined;

  /** Loaded document. `null` until the first read; the cache thereafter. */
  private modes: Map<string, VoiceMode> | null = null;
  /** In-flight first read, so concurrent turns do not each parse the file. */
  private loading: Promise<Map<string, VoiceMode>> | null = null;

  constructor(opts: LaneVoiceModeStoreOptions = {}) {
    if (opts.storage && !opts.path) {
      throw new Error('LaneVoiceModeStore: `path` is required when `storage` is given');
    }
    this.persist = opts.storage && opts.path ? { storage: opts.storage, path: opts.path } : null;
    this.defaultMode = opts.defaultMode ?? DEFAULT_VOICE_MODE;
    this.onError = opts.onError;
  }

  /** The lane's mode, or the configured default when it has none. */
  async get(laneKey: string): Promise<VoiceMode> {
    const modes = await this.load();
    return modes.get(laneKey) ?? this.defaultMode;
  }

  /** Persist a lane's mode. */
  async set(laneKey: string, mode: VoiceMode): Promise<void> {
    const modes = await this.load();
    modes.set(laneKey, mode);
    await this.flush(modes);
  }

  /** Forget a lane's override — it reverts to the default. */
  async clear(laneKey: string): Promise<void> {
    const modes = await this.load();
    modes.delete(laneKey);
    await this.flush(modes);
  }

  /** Every lane with an explicit override. */
  async entries(): Promise<Record<string, VoiceMode>> {
    return Object.fromEntries(await this.load());
  }

  // ---------------------------------------------------------------------------

  private load(): Promise<Map<string, VoiceMode>> {
    const cached = this.modes;
    if (cached) return Promise.resolve(cached);
    const inFlight = this.loading;
    if (inFlight) return inFlight;
    const run = this.readDocument().then((modes) => {
      this.modes = modes;
      this.loading = null;
      return modes;
    });
    this.loading = run;
    return run;
  }

  /**
   * A missing file, unreadable file, invalid JSON, or unrecognised mode value
   * yields an empty map — and a document with one good entry and one bad one
   * keeps the good one. A config file the user hand-edited badly must never
   * stop the gateway from answering.
   */
  private async readDocument(): Promise<Map<string, VoiceMode>> {
    const out = new Map<string, VoiceMode>();
    if (!this.persist) return out;

    let raw: string | null;
    try {
      raw = await this.persist.storage.read(this.persist.path);
    } catch {
      return out;
    }
    if (!raw) return out;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return out;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;

    for (const [laneKey, mode] of Object.entries(parsed)) {
      if (isVoiceMode(mode)) out.set(laneKey, mode);
    }
    return out;
  }

  private async flush(modes: Map<string, VoiceMode>): Promise<void> {
    if (!this.persist) return;
    const doc = `${JSON.stringify(Object.fromEntries(modes), null, 2)}\n`;
    try {
      await this.persist.storage.mkdir(dirname(this.persist.path));
      await this.persist.storage.writeAtomic(this.persist.path, doc);
    } catch (err) {
      // The in-memory value already changed, so the turn still answers in the
      // mode the human asked for: losing durability is bad, losing the reply
      // is worse. The operator hears about the failed write through `onError`.
      this.onError?.(err instanceof Error ? err.message : String(err));
    }
  }
}
