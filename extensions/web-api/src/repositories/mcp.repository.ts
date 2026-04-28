import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServerInfo } from '@ethosagent/web-contracts';

// File-backed inventory of MCP servers configured at
// `~/.ethos/mcp.json`. Mirrors `loadMcpConfig` from
// @ethosagent/tools-mcp but stays in-package so the web-api doesn't
// import a runtime extension just to read JSON.

interface RawMcpEntry {
  name?: unknown;
  transport?: unknown;
  command?: unknown;
  url?: unknown;
}

export interface McpRepositoryOptions {
  /** Root data dir — `~/.ethos/`. */
  dataDir: string;
}

export class McpRepository {
  constructor(private readonly opts: McpRepositoryOptions) {}

  async listServers(): Promise<McpServerInfo[]> {
    const path = join(this.opts.dataDir, 'mcp.json');
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: McpServerInfo[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as RawMcpEntry;
      if (typeof e.name !== 'string' || typeof e.transport !== 'string') continue;
      if (e.transport !== 'stdio' && e.transport !== 'sse') continue;
      out.push({
        name: e.name,
        transport: e.transport,
        command: typeof e.command === 'string' ? e.command : null,
        url: typeof e.url === 'string' ? e.url : null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
