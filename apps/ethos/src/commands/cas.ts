import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { SQLiteContextLog } from '@ethosagent/session-sqlite';
import type { ContextLog, Storage } from '@ethosagent/types';
import { writeJson } from '../json-output';
import { getStorage } from '../wiring';

// ---------------------------------------------------------------------------
// ethos cas gc [--json]
//
// Manual, never automatic (D6 of plan/phases/model-visible-logged.md) —
// mark-and-sweep against `ContextLog.listRefs()` (the global set of hashes
// still referenced by any session's context events) over the CAS blob
// directory (`~/.ethos/cas/<shard>/<rest>`). Deletes blobs that are not
// referenced; never deletes a referenced one. Session deletion does not
// cascade into this — a sweep only ever runs when explicitly invoked.
//
// Walks the CAS root directly through `Storage` rather than `ContentStore`:
// `ContentStore` is frozen at exactly four methods (put/get/has/hash, no
// "list everything" or "delete" — ARCHITECTURE.md §VII) and GC is ops
// tooling, not a content-store consumer.
// ---------------------------------------------------------------------------

const SHARD_RE = /^[0-9a-f]{2}$/;
const BLOB_RE = /^[0-9a-f]{62}$/;

export interface CasGcResult {
  scanned: number;
  deleted: number;
  kept: number;
  deletedHashes: string[];
}

/** Mark-and-sweep, factored out from `runCas` so it's testable against an
 *  `InMemoryStorage` + a `ContextLog` fixture without touching `~/.ethos`. */
export async function gcCas(
  storage: Storage,
  contextLog: ContextLog,
  casRoot: string,
): Promise<CasGcResult> {
  const refs = new Set(await contextLog.listRefs());

  let scanned = 0;
  const deletedHashes: string[] = [];

  const shardEntries = await storage.listEntries(casRoot);
  for (const shard of shardEntries) {
    if (!shard.isDir || !SHARD_RE.test(shard.name)) continue;
    const shardDir = join(casRoot, shard.name);
    const blobEntries = await storage.listEntries(shardDir);
    for (const blob of blobEntries) {
      if (blob.isDir || !BLOB_RE.test(blob.name)) continue;
      const hash = `${shard.name}${blob.name}`;
      scanned++;
      if (refs.has(hash)) continue;
      await storage.remove(join(shardDir, blob.name));
      deletedHashes.push(hash);
    }
  }

  return {
    scanned,
    deleted: deletedHashes.length,
    kept: scanned - deletedHashes.length,
    deletedHashes,
  };
}

function parseFlags(argv: string[]): { json: boolean } {
  return { json: argv.includes('--json') };
}

export async function runCas(sub: string, argv: string[]): Promise<void> {
  if (sub !== 'gc') {
    console.log('Usage: ethos cas gc [--json]');
    return;
  }

  const flags = parseFlags(argv);
  const storage = getStorage();
  const contextLog = new SQLiteContextLog(join(ethosDir(), 'sessions.db'));

  try {
    const result = await gcCas(storage, contextLog, join(ethosDir(), 'cas'));

    if (flags.json) {
      writeJson(result);
      return;
    }

    console.log(`\nCAS garbage collection`);
    console.log('══════════════════════');
    console.log(`  Scanned: ${result.scanned}`);
    console.log(`  Deleted: ${result.deleted}`);
    console.log(`  Kept:    ${result.kept}`);
    console.log();
  } finally {
    contextLog.close();
  }
}
