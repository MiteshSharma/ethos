// `ethos cas gc` — mark-and-sweep (plan/phases/model-visible-logged.md, D6).
// Deletes CAS blobs `ContextLog.listRefs()` doesn't reference; keeps the rest.

import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ContextEvent, ContextLog, ResolvedContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { gcCas } from '../commands/cas';

/** Only `listRefs` matters to `gcCas`; the rest throw if ever called. */
class FakeContextLog implements ContextLog {
  constructor(private readonly refs: string[]) {}
  async append(_event: ContextEvent): Promise<void> {
    throw new Error('not used by gcCas');
  }
  async resolveAt(_sessionId: string, _messageId: string): Promise<ResolvedContext> {
    throw new Error('not used by gcCas');
  }
  async listRefs(): Promise<string[]> {
    return this.refs;
  }
}

const REFERENCED = 'a'.repeat(64);
const ORPHAN = 'b'.repeat(64);
const casRoot = '/cas';

async function putBlob(storage: InMemoryStorage, hash: string): Promise<void> {
  const dir = join(casRoot, hash.slice(0, 2));
  await storage.mkdir(dir);
  await storage.writeAtomic(join(dir, hash.slice(2)), 'blob content');
}

describe('gcCas', () => {
  it('deletes unreferenced blobs and keeps referenced ones', async () => {
    const storage = new InMemoryStorage();
    await putBlob(storage, REFERENCED);
    await putBlob(storage, ORPHAN);
    const contextLog = new FakeContextLog([REFERENCED]);

    const result = await gcCas(storage, contextLog, casRoot);

    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(1);
    expect(result.deletedHashes).toEqual([ORPHAN]);

    expect(await storage.exists(join(casRoot, REFERENCED.slice(0, 2), REFERENCED.slice(2)))).toBe(
      true,
    );
    expect(await storage.exists(join(casRoot, ORPHAN.slice(0, 2), ORPHAN.slice(2)))).toBe(false);
  });

  it('is a no-op on an empty (or missing) CAS root', async () => {
    const storage = new InMemoryStorage();
    const contextLog = new FakeContextLog([]);

    const result = await gcCas(storage, contextLog, casRoot);

    expect(result).toEqual({ scanned: 0, deleted: 0, kept: 0, deletedHashes: [] });
  });
});
