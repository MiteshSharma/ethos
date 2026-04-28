import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpRepository } from '../../repositories/mcp.repository';

describe('McpRepository', () => {
  let dir: string;
  let repo: McpRepository;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-mcp-'));
    repo = new McpRepository({ dataDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty when mcp.json does not exist', async () => {
    expect(await repo.listServers()).toEqual([]);
  });

  it('parses stdio + sse entries, sorted by name', async () => {
    await writeFile(
      join(dir, 'mcp.json'),
      JSON.stringify([
        { name: 'remote', transport: 'sse', url: 'https://mcp.example/server' },
        { name: 'local', transport: 'stdio', command: 'npx my-mcp' },
      ]),
    );
    const servers = await repo.listServers();
    expect(servers).toEqual([
      { name: 'local', transport: 'stdio', command: 'npx my-mcp', url: null },
      { name: 'remote', transport: 'sse', command: null, url: 'https://mcp.example/server' },
    ]);
  });

  it('drops malformed entries rather than throwing', async () => {
    await writeFile(
      join(dir, 'mcp.json'),
      JSON.stringify([
        { name: 'good', transport: 'stdio', command: 'ok' },
        { name: 42, transport: 'stdio' }, // bad name
        { name: 'bad-transport', transport: 'http' },
        null,
      ]),
    );
    const servers = await repo.listServers();
    expect(servers.map((s) => s.name)).toEqual(['good']);
  });

  it('returns empty for non-array JSON', async () => {
    await writeFile(join(dir, 'mcp.json'), JSON.stringify({ servers: [] }));
    expect(await repo.listServers()).toEqual([]);
  });
});
