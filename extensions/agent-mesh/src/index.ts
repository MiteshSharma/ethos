import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

export class AgentMesh {
  private readonly path: string;

  constructor(registryPath = defaultRegistryPath()) {
    this.path = registryPath;
  }

  private read(): MeshEntry[] {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as MeshEntry[];
    } catch {
      return [];
    }
  }

  private write(entries: MeshEntry[]): void {
    const now = Date.now();
    const live = entries.filter((e) => now - e.lastHeartbeatAt < STALE_MS);
    // trim to hard cap — keep newest registered
    const capped =
      live.length > MAX_ENTRIES
        ? live.sort((a, b) => b.registeredAt - a.registeredAt).slice(0, MAX_ENTRIES)
        : live;
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(capped, null, 2));
  }

  register(entry: Omit<MeshEntry, 'registeredAt' | 'lastHeartbeatAt'>): void {
    const entries = this.read();
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
    this.write(entries);
  }

  heartbeat(agentId: string, activeSessions: number): void {
    const entries = this.read();
    const idx = entries.findIndex((e) => e.agentId === agentId);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], lastHeartbeatAt: Date.now(), activeSessions };
      this.write(entries);
    }
  }

  unregister(agentId: string): void {
    this.write(this.read().filter((e) => e.agentId !== agentId));
  }

  // Returns least-busy live agent advertising the given capability.
  // Tie-break: lowest registeredAt (first registered wins).
  route(capability: string): MeshEntry | null {
    const now = Date.now();
    const candidates = this.read()
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

  list(): MeshEntry[] {
    const now = Date.now();
    return this.read().filter((e) => now - e.lastHeartbeatAt < STALE_MS);
  }

  // Starts a 10-second heartbeat. Returns a cleanup function.
  startHeartbeat(agentId: string, getActiveSessions: () => number): () => void {
    const id = setInterval(() => {
      this.heartbeat(agentId, getActiveSessions());
    }, 10_000);
    return () => clearInterval(id);
  }
}
