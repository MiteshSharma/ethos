// Item 7 stage 3 — persistence for micro-compaction state.
//
// Kept out of `micro-compaction.ts` so the state machine stays a pure function
// of (previous state, messages, ratio) — same split `tool-result-aging` uses.
// Unlike aging, micro-compaction has TWO callers on opposite ends of the turn
// (turn-end writes, context assembly reads), so the load/save pair lives here
// rather than being inlined into one of them.
//
// Best-effort throughout: any storage error degrades to "no micro-compaction"
// rather than breaking the turn. A miss just re-derives the state at the next
// step crossing.

import type { Storage } from '@ethosagent/types';
import {
  DEFAULT_MICRO_STATE,
  type MicroCompactionState,
  parseMicroState,
} from './micro-compaction';

export function microStatePath(dataDir: string, sessionId: string): string {
  return `${dataDir}/micro/${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

export async function loadMicroState(
  storage: Storage | undefined,
  dataDir: string | undefined,
  sessionId: string,
): Promise<MicroCompactionState> {
  if (!storage || !dataDir) return DEFAULT_MICRO_STATE;
  try {
    const raw = await storage.read(microStatePath(dataDir, sessionId));
    return raw ? parseMicroState(raw) : DEFAULT_MICRO_STATE;
  } catch {
    return DEFAULT_MICRO_STATE;
  }
}

export async function saveMicroState(
  storage: Storage | undefined,
  dataDir: string | undefined,
  sessionId: string,
  state: MicroCompactionState,
): Promise<void> {
  if (!storage || !dataDir) return;
  try {
    await storage.mkdir(`${dataDir}/micro`);
    await storage.writeAtomic(microStatePath(dataDir, sessionId), JSON.stringify(state));
  } catch {
    // Best-effort — a persistence miss just re-derives the state next crossing.
  }
}
