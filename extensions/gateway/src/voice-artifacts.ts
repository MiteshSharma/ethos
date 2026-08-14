import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { type Storage, type VoiceAudioFormat, voiceAudioExtension } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Synthesized-audio artifact store.
//
// A voice obligation's payload is bytes, not a string. Redelivering it means
// re-sending the exact recording that was owed — re-synthesizing would hand the
// user a DIFFERENT take (TTS is not deterministic, and the personality's voice
// may have changed in between). So the bytes have to outlive the failed send,
// and something has to own their lifecycle.
//
// That lifecycle rides the ledger (voice V2, eng-review D9): an artifact is
// deleted when its obligation is confirmed, deleted again when its obligation
// is abandoned, and a total-size cap with oldest-first eviction backstops both.
// This module is only the storage half — the gateway drives the policy.
//
// Everything here is fail-soft. An artifact that cannot be written, read or
// deleted is a durability problem; making it a delivery problem too would mean
// a disk hiccup costs the user their reply.
// ---------------------------------------------------------------------------

/**
 * A ref is a BARE FILENAME (`<uuid>.<ext>`), never a path.
 *
 * The ledger persists this string in a SQLite column and the sweep feeds it
 * straight back here after a restart — i.e. it is data that re-enters the
 * process from durable storage, which is exactly the shape a path-traversal
 * primitive takes. Keeping refs opaque and validating on the way IN means a
 * hand-edited (or corrupted) `artifact_ref` can address nothing outside the
 * artifact directory: `../../id_rsa` does not match, so it is never joined.
 */
const REF_PATTERN = /^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;

export interface VoiceArtifactStore {
  /** Write an artifact. Returns its ref, or null when there is no storage. */
  put(data: Uint8Array, format: VoiceAudioFormat): Promise<string | null>;
  read(ref: string): Promise<Uint8Array | null>;
  remove(ref: string): Promise<void>;
  /** Evict oldest-first until the directory total is <= maxBytes. Returns bytes freed. */
  enforceSizeCap(maxBytes: number): Promise<number>;
}

export interface VoiceArtifactStoreOptions {
  /**
   * Absent → the store is a no-op: `put` returns null, nothing is persisted,
   * and a failed voice send simply cannot be redelivered. Same optional-seam
   * pattern the gateway uses for `storage` / `deliveryLedger`.
   */
  storage?: Storage;
  /** Absolute directory. Required when `storage` is given. */
  dir?: string;
  /** Reports an operation that did not land. Never rethrown. */
  onError?: (op: string, error: string) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ENOENT means the artifact is already gone, which is the desired end state. */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function createVoiceArtifactStore(opts: VoiceArtifactStoreOptions): VoiceArtifactStore {
  const storage = opts.storage;
  const dir = opts.dir;
  const onError = opts.onError;

  /**
   * Resolve a ref to its backing store + absolute path, or null when there is
   * no storage or the ref is not a valid one. Returns the pair rather than the
   * path alone so callers get a non-optional `Storage` without a cast.
   */
  const locate = (ref: string): { storage: Storage; path: string } | null => {
    if (!storage || !dir) return null;
    if (!REF_PATTERN.test(ref)) {
      onError?.('validate', `refusing malformed artifact ref '${ref}'`);
      return null;
    }
    return { storage, path: join(dir, ref) };
  };

  return {
    async put(data, format) {
      if (!storage || !dir) return null;
      const ref = `${randomUUID()}.${voiceAudioExtension(format)}`;
      try {
        await storage.mkdir(dir);
        // Not `writeAtomic`: a partial artifact is worthless but harmless — the
        // redelivery that reads it fails and the obligation stays pending,
        // which is the same outcome as no artifact at all. `writeAtomic` costs
        // a second file write per voice reply to protect against nothing.
        await storage.write(join(dir, ref), data);
        return ref;
      } catch (err) {
        onError?.('put', errMsg(err));
        return null;
      }
    },

    async read(ref) {
      const located = locate(ref);
      if (!located) return null;
      try {
        return await located.storage.readBytes(located.path);
      } catch (err) {
        onError?.('read', errMsg(err));
        return null;
      }
    },

    async remove(ref) {
      const located = locate(ref);
      if (!located) return;
      try {
        await located.storage.remove(located.path);
      } catch (err) {
        if (isMissing(err)) return;
        onError?.('remove', errMsg(err));
      }
    },

    async enforceSizeCap(maxBytes) {
      if (!storage || !dir) return 0;
      let entries: Awaited<ReturnType<Storage['listEntries']>>;
      try {
        entries = await storage.listEntries(dir);
      } catch (err) {
        onError?.('list', errMsg(err));
        return 0;
      }

      // `size` and `mtimeMs` are both optional on `StorageDirEntry` — a backend
      // with no stat semantics omits them. Size 0 is the conservative reading
      // (an unknown-size file cannot be counted toward the cap it might be
      // breaching, but neither can it be invented). `Infinity` for an unknown
      // mtime sorts the entry LAST: never evict what you cannot date.
      const files = entries
        .filter((e) => !e.isDir)
        .map((e) => ({
          name: e.name,
          size: e.size ?? 0,
          mtimeMs: e.mtimeMs ?? Number.POSITIVE_INFINITY,
        }));

      let total = files.reduce((sum, f) => sum + f.size, 0);
      if (total <= maxBytes) return 0;

      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let freed = 0;
      for (const file of files) {
        if (total <= maxBytes) break;
        try {
          await storage.remove(join(dir, file.name));
        } catch (err) {
          if (!isMissing(err)) {
            onError?.('evict', errMsg(err));
            // A file we could not delete is still on disk, so it must keep
            // counting toward the total — otherwise the loop would stop early
            // believing it had freed space it did not.
            continue;
          }
        }
        total -= file.size;
        freed += file.size;
      }
      return freed;
    },
  };
}
