// Backend-aware memory assembly (memory-lifecycle vault gaps, plan §3a/§3b).
//
// One module decides, per configured backend, where the undecorated write
// provider lives, where its provenance history is rooted, and how the approval
// gate composes around it. Shared by:
//   - build-infrastructure — the runtime write path (the `markdown` and `vault`
//     registry factories compose the same history + pending-gate stack);
//   - build-agent-loop — proactive capture's undecorated base + history;
//   - createMemoryProviderFromConfig — nightly consolidation/decay and other
//     out-of-loop writers that must target the configured backend.
//
// Placement decision (deliberate, §3b): memory CONTENT and its provenance
// history follow the backend — for a vault that means history JSONL + blobs
// under `<vaultRoot>/<agentDir>/.ethos-meta/` (dot-prefixed so Obsidian
// ignores it), written through the vault's ScopedStorage. The approval-gate
// machinery (pending queue + tombstones) is gate state, NOT memory content,
// and stays rooted at `~/.ethos` for every backend so `ethos memory pending`,
// the web pending RPCs, and capture's tombstone consultation work unchanged
// across backends.

import { join, resolve } from 'node:path';
import {
  type PendingGateObservability,
  PendingMemoryStore,
  TombstoneStore,
  withPendingGate,
} from '@ethosagent/memory-approval';
import { type HistorySource, HistoryStore, withHistory } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { VaultMemoryProvider } from '@ethosagent/memory-vault';
import { defaultAlwaysDeny, ScopedStorage } from '@ethosagent/storage-fs';
import type {
  GlobalMemoryStore,
  Logger,
  MemoryContext,
  MemoryProvider,
  Storage,
} from '@ethosagent/types';

/** Subdir under the vault's agent root holding history JSONL + blobs (§3a). */
const VAULT_META_DIR = '.ethos-meta';

/** The config slice that selects a memory backend. Both `EthosConfig` and
 *  `WiringConfig` satisfy this structurally. */
export interface MemoryBackendSelection {
  memory?: 'markdown' | 'vector' | 'vault';
  memoryVault?: {
    path?: string;
    agentDir?: string;
    prefetch?: string[];
    exclude?: string[];
  };
  /** Per-key markdown ceilings, in characters. Absent → 512K per key. */
  memoryCharLimits?: { memory?: number; user?: number };
}

export interface UndecoratedBackend {
  /** Undecorated write provider for the configured backend. */
  base: MemoryProvider & GlobalMemoryStore;
  /** Provenance history rooted with the backend's content. */
  history: HistoryStore;
  /**
   * Root under which per-scope memory files and the `memory-meta.json`
   * sidecar resolve (`<memoryRoot>/personalities/<id>/…`). The vault mirrors
   * the markdown layout under `<vaultRoot>/<agentDir>`.
   */
  memoryRoot: string;
  /** Storage handle confined appropriately for sidecar I/O under memoryRoot. */
  storage: Storage;
}

export interface VaultBackend extends UndecoratedBackend {
  base: VaultMemoryProvider;
}

/**
 * Construct the undecorated vault provider plus its ScopedStorage confinement
 * (read the whole vault so search can find the user's notes; write only inside
 * the agent's own subtree — the sensitive-path floor applies beneath both) and
 * its `.ethos-meta` history store.
 */
export function buildVaultBackend(opts: {
  vault: MemoryBackendSelection['memoryVault'];
  storage: Storage;
  logger?: Logger;
}): VaultBackend {
  const vault = opts.vault;
  if (!vault?.path) {
    throw new Error('memory: vault requires memoryVault.path to be set in config.');
  }
  const vaultRoot = resolve(vault.path);
  const agentDir = vault.agentDir ?? 'Ethos';
  const agentRoot = join(vaultRoot, agentDir);
  const scoped = new ScopedStorage(opts.storage, {
    read: [`${vaultRoot}/`],
    write: [`${agentRoot}/`],
    alwaysDeny: defaultAlwaysDeny(),
  });
  const base = new VaultMemoryProvider({
    vaultRoot,
    agentDir,
    storage: scoped,
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(vault.prefetch && vault.prefetch.length > 0 ? { prefetchKeys: vault.prefetch } : {}),
    ...(vault.exclude && vault.exclude.length > 0 ? { exclude: vault.exclude } : {}),
  });
  const metaDir = join(agentRoot, VAULT_META_DIR);
  const history = new HistoryStore({ dataDir: metaDir, storage: scoped });
  return { base, history, memoryRoot: agentRoot, storage: scoped };
}

/**
 * Resolve the undecorated provider + history for the configured backend.
 * `markdown` (and, for out-of-loop writers, `vector` — nightly consolidation
 * has always operated on the markdown store beside the vector index) root at
 * `dataDir`; `vault` roots at `<vaultRoot>/<agentDir>` with `.ethos-meta`
 * history.
 */
export function createUndecoratedBackend(opts: {
  selection: MemoryBackendSelection;
  dataDir: string;
  storage: Storage;
  logger?: Logger;
}): UndecoratedBackend {
  if (opts.selection.memory === 'vault') {
    return buildVaultBackend({
      vault: opts.selection.memoryVault,
      storage: opts.storage,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
  }
  const base = new MarkdownFileMemoryProvider({
    dir: opts.dataDir,
    storage: opts.storage,
    ...(opts.selection.memoryCharLimits ? { charLimits: opts.selection.memoryCharLimits } : {}),
  });
  const history = new HistoryStore({ dataDir: opts.dataDir, storage: opts.storage });
  return { base, history, memoryRoot: opts.dataDir, storage: opts.storage };
}

export interface ComposeGatedMemoryOptions {
  base: MemoryProvider & GlobalMemoryStore;
  /** The backend's own history store (vault: `.ethos-meta`; markdown: dataDir). */
  history: HistoryStore;
  approval?: { mode?: 'off' | 'automated' | 'all'; cap?: number; ttlDays?: number };
  /** Gate-machinery root — ALWAYS `~/.ethos` (see module docstring). */
  dataDir: string;
  /** Gate-machinery storage — the raw wiring storage, never the vault scope. */
  storage: Storage;
  observability?: PendingGateObservability;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GatedMemoryStack {
  /** The agent-facing write handle (history + gate composed). */
  provider: MemoryProvider & GlobalMemoryStore;
  /** The pending queue — present only when the gate is on. */
  pending?: PendingMemoryStore;
}

/**
 * Compose the agent-facing write stack around an undecorated backend: the M1
 * history decorator plus (when enabled) the L2 approve-before-store gate.
 *
 * Compose HISTORY OUTSIDE GATE: a gated write parks in the pending queue and
 * touches no bytes, so the outer history sees before === after and records
 * nothing; a non-gated write flows through to the provider and is recorded
 * once. Approve replays through `apply` (a fresh history handle carrying the
 * ORIGINAL source + approvedBy) against the BACKEND provider, so an approved
 * candidate is recorded exactly once, on apply, in the backend's history.
 */
export function composeGatedMemory(opts: ComposeGatedMemoryOptions): GatedMemoryStack {
  const approvalMode = opts.approval?.mode ?? 'off';
  if (approvalMode === 'off') {
    return { provider: withHistory(opts.base, opts.history, { source: 'tool' }) };
  }
  const tombstones = new TombstoneStore({ storage: opts.storage, dataDir: opts.dataDir });
  const pending = new PendingMemoryStore({
    storage: opts.storage,
    dataDir: opts.dataDir,
    tombstones,
    ...(opts.approval?.cap !== undefined ? { cap: opts.approval.cap } : {}),
    ...(opts.approval?.ttlDays !== undefined ? { ttlMs: opts.approval.ttlDays * DAY_MS } : {}),
    ...(opts.observability ? { observability: opts.observability } : {}),
    apply: async (entry, approvedBy) => {
      const handle = withHistory(opts.base, opts.history, { source: entry.source, approvedBy });
      const ctx: MemoryContext = {
        scopeId: entry.scopeId,
        sessionId: entry.sessionId ?? '',
        sessionKey: entry.sessionKey ?? 'cli',
        platform: 'cli',
        workingDir: '',
      };
      await handle.sync([entry.update], ctx);
    },
  });
  const gate = withPendingGate(opts.base, { store: pending, mode: approvalMode, source: 'tool' });
  return { provider: withHistory(gate, opts.history, { source: 'tool' }), pending };
}

export interface CreateMemoryProviderFromConfigOptions {
  /** Backend selection — pass the app config (`EthosConfig` / `WiringConfig`). */
  config: MemoryBackendSelection;
  /** Root data directory (typically `~/.ethos`). */
  dataDir: string;
  /** Storage backend. Injected by the composition root; required. */
  storage: Storage;
  /** Provenance-history source label baked into the returned handle. */
  source?: HistorySource;
  logger?: Logger;
}

export interface ConfiguredMemoryBackend {
  /** History-decorated write handle targeting the configured backend. */
  provider: MemoryProvider & GlobalMemoryStore;
  /** The backend's history store (for rotate / direct records). */
  history: HistoryStore;
  /** Root for per-scope memory files + `memory-meta.json` sidecars. */
  memoryRoot: string;
  /** Storage handle for sidecar I/O under `memoryRoot`. */
  storage: Storage;
}

/**
 * Backend-aware sibling of `createMemoryProvider`: returns a history-decorated
 * handle for the CONFIGURED backend (`memory: vault` → the vault, everything
 * else → markdown at dataDir, today's behavior), plus the pieces out-of-loop
 * writers need — the history store for rotation and the sidecar root/storage.
 * Used by the nightly pass so consolidation/decay target the same store the
 * agent reads from.
 */
export function createMemoryProviderFromConfig(
  opts: CreateMemoryProviderFromConfigOptions,
): ConfiguredMemoryBackend {
  const backend = createUndecoratedBackend({
    selection: opts.config,
    dataDir: opts.dataDir,
    storage: opts.storage,
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  return {
    provider: withHistory(backend.base, backend.history, { source: opts.source ?? 'tool' }),
    history: backend.history,
    memoryRoot: backend.memoryRoot,
    storage: backend.storage,
  };
}
