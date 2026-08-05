import { isServerAllowed, McpManager, McpSessionView } from '@ethosagent/tools-mcp';
import type { PersonalityConfig, PersonalityRegistry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createAcpMcpWiring } from '../lib/acp-mcp-wiring';

function makeRegistry(configs: PersonalityConfig[]): PersonalityRegistry {
  const byId = new Map(configs.map((c) => [c.id, c]));
  return {
    define() {},
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    getDefault: () => {
      const first = configs[0];
      if (!first) throw new Error('no personalities');
      return first;
    },
    setDefault() {},
    async loadFromDirectory() {},
    remove() {},
  };
}

const RESEARCHER: PersonalityConfig = {
  id: 'researcher',
  name: 'Researcher',
  mcp_servers: ['github', 'docs-*'],
};

const ASCETIC: PersonalityConfig = { id: 'ascetic', name: 'Ascetic' };

function makeWiring() {
  return createAcpMcpWiring({
    mcpManager: new McpManager([]),
    personalities: makeRegistry([RESEARCHER, ASCETIC]),
    defaultPersonalityId: 'researcher',
  });
}

describe('createAcpMcpWiring — containment', () => {
  it('does not make a server outside the personality allowlist grantable', () => {
    const { resolveAllowlist } = makeWiring();
    const allowlist = resolveAllowlist('researcher');

    expect(isServerAllowed('slack', allowlist)).toBe(false);
    expect(isServerAllowed('github-enterprise', allowlist)).toBe(false);
  });

  it('grants only servers inside the personality allowlist', () => {
    const { resolveAllowlist } = makeWiring();
    const allowlist = resolveAllowlist('researcher');

    expect(allowlist).toEqual(['github', 'docs-*']);
    expect(isServerAllowed('github', allowlist)).toBe(true);
    expect(isServerAllowed('docs-internal', allowlist)).toBe(true);
  });

  it('denies everything for a personality with no mcp_servers', () => {
    const { resolveAllowlist } = makeWiring();
    const allowlist = resolveAllowlist('ascetic');

    expect(allowlist).toEqual([]);
    expect(isServerAllowed('github', allowlist)).toBe(false);
  });

  it('denies everything for an unknown personality id', () => {
    const { resolveAllowlist } = makeWiring();

    expect(isServerAllowed('github', resolveAllowlist('does-not-exist'))).toBe(false);
  });

  it('falls back to the personality the loop actually runs when none is named', () => {
    const { resolveAllowlist } = makeWiring();

    expect(resolveAllowlist(undefined)).toEqual(['github', 'docs-*']);
  });

  it('never resolves to open mode', () => {
    const { resolveAllowlist } = makeWiring();

    for (const id of ['researcher', 'ascetic', 'does-not-exist', undefined]) {
      expect(resolveAllowlist(id)).not.toBeUndefined();
    }
  });
});

describe('createAcpMcpWiring — session views', () => {
  it('mints a fresh view per session', () => {
    const { createSessionView } = makeWiring();

    const a = createSessionView();
    const b = createSessionView();

    expect(a).toBeInstanceOf(McpSessionView);
    expect(a).not.toBe(b);
  });

  it('produces a view that rejects a server outside the personality allowlist', async () => {
    const { resolveAllowlist, createSessionView } = makeWiring();
    const view = createSessionView();

    const result = await view.registerSessionServers(
      [{ name: 'slack', transport: 'stdio', command: 'echo' }],
      resolveAllowlist('researcher'),
    );

    expect(result.registered).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('not in personality MCP allowlist');
    expect(view.getSessionTools()).toHaveLength(0);
  });
});
