import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Storage } from '@ethosagent/types';

/**
 * Delivery mode for a peer's `/notify` endpoint (Lane C,
 * kanban-hooks-notify-parity). `wake`/`notify+wake` force a full agent turn;
 * `notify` is a passive delivery, surfaced later via the pending-notify
 * `ContextInjector` at the target's own next turn rather than forcing one.
 */
export type NotifyMode = 'notify' | 'wake' | 'notify+wake';

/**
 * One board this agent watches, plus its durable delivery-mode preference
 * (D7). `mode` undefined falls back to `notify+wake` — the only behavior that
 * existed before per-subscription preference did.
 */
export interface BoardSubscription {
  board: string;
  mode?: NotifyMode;
}

export interface MeshEntry {
  agentId: string;
  capabilities: string[];
  model: string;
  pid: number;
  host: string;
  port: number;
  registeredAt: number;
  lastHeartbeatAt: number;
  activeSessions: number;
  /** Personality directory name — internal addressing key for /notify routing. */
  personalityId?: string;
  /** Human-facing label (e.g. "Engineer", "Swing Trader"). */
  displayName?: string;
  /** Board/team subscriptions — which boards this agent watches, and how. */
  boardSubscriptions?: BoardSubscription[];
  /**
   * Name of the `SecretsResolver` entry holding this peer's ACP bearer
   * token — never the token value itself (ARCHITECTURE.md S9: secret
   * values live only in `SecretsResolver`; a config/registry file may hold
   * a reference by name). A caller that needs to authenticate to this
   * peer's `AcpServer` resolves the value through an injected
   * `SecretsResolver` at call time. Absent when the peer has no configured
   * bearer token to share (e.g. its `AcpServer` fell back to a
   * process-local random token).
   */
  authTokenRef?: string;
}

/**
 * D7 backward compat: `boardSubscriptions` used to be a flat `string[]` of
 * board ids. A registry.json written before this restructure lands still has
 * that shape on disk — no migration machinery exists for this JSON-file
 * registry, so a plain string entry is upgraded to `{ board: <string> }` on
 * every read instead. `mode` stays absent, which every reader already treats
 * as "fall back to notify+wake" — the exact behavior a bare board id used to
 * mean.
 */
function normalizeBoardSubscriptions(raw: unknown): BoardSubscription[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) =>
    typeof item === 'string' ? { board: item } : (item as BoardSubscription),
  );
}

function normalizeEntry(entry: MeshEntry): MeshEntry {
  const normalized = normalizeBoardSubscriptions(entry.boardSubscriptions);
  return normalized ? { ...entry, boardSubscriptions: normalized } : entry;
}

const STALE_MS = 30_000;
const MAX_ENTRIES = 100;
const LOCK_TTL_MS = 5_000;
const LOCK_RETRY_MS = 10;

export function meshesDir(): string {
  return join(homedir(), '.ethos', 'meshes');
}

export function meshRegistryPath(meshName: string): string {
  return join(meshesDir(), meshName, 'registry.json');
}

export function defaultRegistryPath(): string {
  return meshRegistryPath('default');
}

async function acquireRegistryLock(lockPath: string): Promise<() => void> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TTL_MS;
  while (Date.now() < deadline) {
    try {
      writeFileSync(lockPath, '', { flag: 'wx' });
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Stale lock detection: if the lock file is older than TTL, assume the holder crashed.
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* race: another holder already cleaned it up */
          }
          continue;
        }
      } catch {
        /* lock file disappeared between check and stat — retry immediately */
        continue;
      }
      await new Promise<void>((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  throw new Error(`Failed to acquire registry lock at ${lockPath} within ${LOCK_TTL_MS}ms`);
}

export interface AgentMeshOptions {
  /** Storage backend. Injected by the composition root; required. */
  storage: Storage;
}

export class AgentMesh {
  private readonly path: string;
  private readonly storage: Storage;

  /**
   * This process's own registration descriptor, cached so `heartbeat()` can
   * re-insert the entry after it was pruned. Any peer's `write()` drops every
   * entry that has not heartbeaten within `STALE_MS`, so a single gap longer
   * than 30s — a paused VM, or a plain network stall — erases us from the
   * registry. Self-registration is one-shot at process start, so without this
   * cache a `heartbeat()` that finds no entry has nothing to re-insert and the
   * instance stays invisible to routing until it restarts.
   *
   * Pinned to the FIRST `agentId` registered through this instance: that is
   * the self-registration `ethos serve` / `ethos boot` performs at startup.
   * Later `register()` calls carrying a different `agentId` arrive over the
   * peer-facing `mesh.register` RPC (`apps/acp-server`) and must not steal the
   * slot — one instance must never resurrect another's entry from stale data.
   */
  private self: {
    descriptor: Omit<MeshEntry, 'registeredAt' | 'lastHeartbeatAt'>;
    registeredAt: number;
  } | null = null;

  constructor(registryPath: string = defaultRegistryPath(), opts: AgentMeshOptions) {
    this.path = registryPath;
    this.storage = opts.storage;
  }

  private lockPath(): string {
    return this.path.replace(/\.json$/, '.lock');
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquireRegistryLock(this.lockPath());
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async read(): Promise<MeshEntry[]> {
    const src = await this.storage.read(this.path);
    if (!src) return [];
    try {
      const parsed = JSON.parse(src) as MeshEntry[];
      return parsed.map(normalizeEntry);
    } catch {
      return [];
    }
  }

  private async write(entries: MeshEntry[]): Promise<void> {
    const now = Date.now();
    const live = entries.filter((e) => now - e.lastHeartbeatAt < STALE_MS);
    // trim to hard cap — keep newest registered
    const capped =
      live.length > MAX_ENTRIES
        ? live.sort((a, b) => b.registeredAt - a.registeredAt).slice(0, MAX_ENTRIES)
        : live;
    await this.storage.mkdir(dirname(this.path));
    await this.storage.write(this.path, JSON.stringify(capped, null, 2));
  }

  /**
   * Read-modify-write of a single entry. MUST be called with the registry lock
   * already held — both callers (`register()` and `heartbeat()`'s re-insert)
   * run inside `withLock`, and re-entering it would deadlock on the `wx`
   * sentinel file until its 5s TTL expired.
   *
   * `registeredAt` is preserved from the on-disk entry when one exists, and
   * otherwise falls back to `fallbackRegisteredAt` — which is how a re-insert
   * keeps the ORIGINAL registration time rather than resetting it. That value
   * is what `MAX_ENTRIES` eviction and `route()`'s tie-break sort on. Returns
   * the `registeredAt` actually written.
   */
  private async upsertLocked(
    entry: Omit<MeshEntry, 'registeredAt' | 'lastHeartbeatAt'>,
    fallbackRegisteredAt?: number,
  ): Promise<number> {
    const entries = await this.read();
    const now = Date.now();
    const idx = entries.findIndex((e) => e.agentId === entry.agentId);
    const registeredAt = idx >= 0 ? entries[idx].registeredAt : (fallbackRegisteredAt ?? now);
    const next: MeshEntry = { ...entry, registeredAt, lastHeartbeatAt: now };
    if (idx >= 0) {
      entries[idx] = next;
    } else {
      entries.push(next);
    }
    await this.write(entries);
    return registeredAt;
  }

  async register(entry: Omit<MeshEntry, 'registeredAt' | 'lastHeartbeatAt'>): Promise<void> {
    await this.withLock(async () => {
      const registeredAt = await this.upsertLocked(entry);
      if (!this.self || this.self.descriptor.agentId === entry.agentId) {
        this.self = { descriptor: entry, registeredAt };
      }
    });
  }

  async heartbeat(agentId: string, activeSessions: number): Promise<void> {
    await this.withLock(async () => {
      const entries = await this.read();
      const idx = entries.findIndex((e) => e.agentId === agentId);
      if (idx >= 0) {
        entries[idx] = { ...entries[idx], lastHeartbeatAt: Date.now(), activeSessions };
        await this.write(entries);
        return;
      }
      // Missing entry: some peer's `write()` pruned us for a >STALE_MS gap.
      // Re-insert from the cached self descriptor instead of no-op'ing —
      // a no-op here is permanent invisibility, since nothing re-runs the
      // one-shot startup `register()`. An `agentId` this instance never
      // registered has no cached descriptor and stays a no-op.
      const self = this.self;
      if (!self || self.descriptor.agentId !== agentId) return;
      await this.upsertLocked({ ...self.descriptor, activeSessions }, self.registeredAt);
    });
  }

  async unregister(agentId: string): Promise<void> {
    await this.withLock(async () => {
      const entries = await this.read();
      await this.write(entries.filter((e) => e.agentId !== agentId));
    });
  }

  // Returns least-busy live agent advertising the given capability.
  // Tie-break: lowest registeredAt (first registered wins).
  async route(capability: string): Promise<MeshEntry | null> {
    const now = Date.now();
    const entries = await this.read();
    const candidates = entries
      .filter((e) => now - e.lastHeartbeatAt < STALE_MS)
      .filter((e) => e.capabilities.includes(capability));

    if (candidates.length === 0) return null;

    return (
      candidates.sort((a, b) =>
        a.activeSessions !== b.activeSessions
          ? a.activeSessions - b.activeSessions
          : a.registeredAt - b.registeredAt,
      )[0] ?? null
    );
  }

  async list(): Promise<MeshEntry[]> {
    const now = Date.now();
    const entries = await this.read();
    return entries.filter((e) => now - e.lastHeartbeatAt < STALE_MS);
  }

  async findByPersonality(personalityId: string): Promise<MeshEntry[]> {
    const now = Date.now();
    const entries = await this.read();
    return entries.filter(
      (e) => now - e.lastHeartbeatAt < STALE_MS && e.personalityId === personalityId,
    );
  }

  // Starts a 10-second heartbeat. Returns a cleanup function. The async
  // heartbeat call is fire-and-forget — failures are swallowed; the next
  // tick retries.
  startHeartbeat(agentId: string, getActiveSessions: () => number): () => void {
    const id = setInterval(() => {
      void this.heartbeat(agentId, getActiveSessions()).catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }
}

export type { MeshJournalEntry, MeshJournalObservability } from './journal';
export { appendMeshJournal, meshJournalPath, setMeshObservabilityService } from './journal';
