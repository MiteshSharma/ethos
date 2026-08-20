import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ContentStore, Storage } from '@ethosagent/types';

const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Content-addressed store backing `ContentStore` — the byte-storage half of
 * the "model-visible ⟺ logged" invariant (plan/phases/model-visible-logged.md).
 *
 * Blobs are stored under <root>/<aa>/<rest>, where <aa> is the first two hex
 * characters of the full (untruncated) SHA-256 of the content and <rest> is
 * the remaining 62. Unlike `extensions/observability-sqlite/src/blob-store.ts`
 * (whose hash+shard pattern this copies), CAS blobs are **not** gzipped or
 * base64-encoded — content is written raw as utf-8 — and writes go through
 * `Storage.writeAtomic`, not `storage.write`, per the plan's explicit
 * no-partial-write requirement for this store.
 *
 * `root` must be an absolute path (e.g. `join(ethosDir(), 'cas')`) — the
 * `Storage` interface does not manage a root, so the caller computes and
 * passes it in, the same way `BlobStore` does.
 */
export class FsContentStore implements ContentStore {
  constructor(
    private readonly root: string,
    private readonly storage: Storage,
  ) {}

  async put(content: string): Promise<string> {
    const key = this.hash(content);
    const path = this.blobPath(key);
    const dir = join(this.root, key.slice(0, 2));

    // Idempotent — content-addressing makes a same-hash write a safe no-op.
    if (await this.storage.exists(path)) return key;

    await this.storage.mkdir(dir);
    await this.storage.writeAtomic(path, content);
    return key;
  }

  async get(hash: string): Promise<string | null> {
    if (!HASH_RE.test(hash)) return null;
    return await this.storage.read(this.blobPath(hash));
  }

  async has(hash: string): Promise<boolean> {
    if (!HASH_RE.test(hash)) return false;
    return await this.storage.exists(this.blobPath(hash));
  }

  hash(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  private blobPath(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash.slice(2));
  }
}
