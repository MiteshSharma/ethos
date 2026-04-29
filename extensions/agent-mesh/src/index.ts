import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';

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
}

const STALE_MS = 30_000;
const MAX_ENTRIES = 100;

export function defaultRegistryPath(): string {
  return join(homedir(), '.ethos', 'mesh-registry.json');
}

export interface AgentMeshOptions {
  /** Storage backend. Defaults to FsStorage. */
  storage?: Storage;
}

export class AgentMesh {
  private readonly path: string;
  private readonly storage: Storage;

  constructor(registryPath: string = defaultRegistryPath(), opts: AgentMeshOptions = {}) {
    this.path = registryPath;
    this.storage = opts.storage ?? new FsStorage();
  }

  private async read(): Promise<MeshEntry[]> {
    const src = await this.storage.read(this.path);
    if (!src) return [];
    try {
      return JSON.parse(src) as MeshEntry[];
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

  async register(entry: Omit<MeshEntry, 'registeredAt' | 'lastHeartbeatAt'>): Promise<void> {
    const entries = await this.read();
    const now = Date.now();
    const idx = entries.findIndex((e) => e.agentId === entry.agentId);
    if (idx >= 0) {
      // preserve original registeredAt on re-registration
      entries[idx] = {
        ...entry,
        registeredAt: entries[idx].registeredAt,
        lastHeartbeatAt: now,
      };
    } else {
      entries.push({ ...entry, registeredAt: now, lastHeartbeatAt: now });
    }
    await this.write(entries);
  }

  async heartbeat(agentId: string, activeSessions: number): Promise<void> {
    const entries = await this.read();
    const idx = entries.findIndex((e) => e.agentId === agentId);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], lastHeartbeatAt: Date.now(), activeSessions };
      await this.write(entries);
    }
  }

  async unregister(agentId: string): Promise<void> {
    const entries = await this.read();
    await this.write(entries.filter((e) => e.agentId !== agentId));
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
