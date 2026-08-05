import type { PersonalityAllowlistResolver, SessionViewFactory } from '@ethosagent/acp-server';
import { type McpManager, McpSessionView } from '@ethosagent/tools-mcp';
import type { PersonalityRegistry } from '@ethosagent/types';

/**
 * Wiring for the ACP session-scoped MCP grant (`session/registerMcpServers`).
 *
 * The grant is a lease over the personality's *own* allowlist: a session may
 * connect a client-supplied server only if that server name already appears in
 * the personality's `mcp_servers`. A personality with no `mcp_servers` — or an
 * id the registry does not know — resolves to `[]`, which `isServerAllowed`
 * treats as deny-all. A session view can therefore never widen reach beyond
 * what a normal turn already grants (ARCHITECTURE.md S1).
 *
 * The lease is session-scoped, not TTL-bounded: it ends on `session/end` or
 * when the transport connection that opened it closes.
 */
export function createAcpMcpWiring(opts: {
  mcpManager: McpManager;
  personalities: PersonalityRegistry;
  /** Personality the loop actually runs when the client names none. */
  defaultPersonalityId: string;
}): { resolveAllowlist: PersonalityAllowlistResolver; createSessionView: SessionViewFactory } {
  return {
    resolveAllowlist: (personalityId) =>
      opts.personalities.get(personalityId ?? opts.defaultPersonalityId)?.mcp_servers ?? [],
    createSessionView: () => new McpSessionView(opts.mcpManager),
  };
}
