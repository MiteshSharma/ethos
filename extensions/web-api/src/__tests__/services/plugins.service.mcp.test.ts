import { homedir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { PluginsService } from '../../services/plugins.service';

// Targeted at the MCP-config sanitisation + sort the service performs
// after replacing the old McpRepository with a direct loadMcpConfig call.
// Uses InMemoryStorage so the test can pre-populate the path
// loadMcpConfig will look at (homedir/.ethos/mcp.json).

const MCP_PATH = join(homedir(), '.ethos', 'mcp.json');

describe('PluginsService — MCP server listing', () => {
  let storage: InMemoryStorage;
  let service: PluginsService;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    await storage.mkdir(join(homedir(), '.ethos'));
    // scanInstalledPlugins points at a non-existent plugins root so it
    // returns []; only the MCP config side is exercised in this file.
    service = new PluginsService({
      storage,
      dataDir: '/nonexistent-plugins-root',
    });
  });

  it('returns empty when mcp.json does not exist', async () => {
    const { mcpServers } = await service.list();
    expect(mcpServers).toEqual([]);
  });

  it('parses stdio + sse entries, sorted by name', async () => {
    await storage.write(
      MCP_PATH,
      JSON.stringify([
        { name: 'remote', transport: 'sse', url: 'https://mcp.example/server' },
        { name: 'local', transport: 'stdio', command: 'npx my-mcp' },
      ]),
    );
    const { mcpServers } = await service.list();
    expect(mcpServers).toEqual([
      { name: 'local', transport: 'stdio', command: 'npx my-mcp', url: null },
      { name: 'remote', transport: 'sse', command: null, url: 'https://mcp.example/server' },
    ]);
  });

  it('drops malformed entries', async () => {
    await storage.write(
      MCP_PATH,
      JSON.stringify([
        { name: 'good', transport: 'stdio', command: 'ok' },
        { name: 42, transport: 'stdio' }, // bad name
        { name: 'bad-transport', transport: 'http' },
      ]),
    );
    const { mcpServers } = await service.list();
    expect(mcpServers.map((s) => s.name)).toEqual(['good']);
  });
});
