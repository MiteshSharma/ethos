// Remote MCP server presets — curated catalog entries with everything a
// catalog card needs: how to reach the server, how it authenticates, and
// enough prose to pick one without leaving the page.
//
// Every url and authType below was verified by a live `initialize` handshake,
// and each OAuth entry by walking WWW-Authenticate -> protected-resource
// metadata -> authorization-server metadata and confirming an RFC 7591 Dynamic
// Client Registration POST returns a public client_id with
// token_endpoint_auth_method "none". Do not "correct" a url from memory: several
// of these are deliberately not the shape you would guess (see the per-entry
// notes). The pinning tests in __tests__/remote-presets.test.ts exist for
// exactly that reason.

export interface McpRemotePreset {
  name: string;
  label: string;
  url: string;
  transport: 'streamable-http';
  authType: 'oauth' | 'none' | 'bearer';
  description: string;
  /** Grouping label for the catalog UI, e.g. "Developer tools". */
  category: string;
  docsUrl?: string;
}

// Catalog categories. These three strings are the whole scheme — a new entry
// joins one of them rather than inventing a fourth.
const DOCS = 'Docs & knowledge';
const DEV_TOOLS = 'Developer tools';
const PRODUCTIVITY = 'Productivity';

// Deliberately absent: `github`. https://api.githubcopilot.com/mcp/ is a real
// OAuth MCP server, but its authorization server (https://github.com/login/oauth)
// publishes no `registration_endpoint` in either its RFC 8414 metadata or its
// OpenID configuration. Ethos's install flow registers a client via DCR
// (`registerOAuthClient` in ./oauth.ts, which throws `DcrUnsupported`), so a
// one-click catalog install could only ever fail. GitHub needs a pre-registered
// GitHub App, which is the `ethos mcp add --url` CLI path, not a catalog path.
//
// Also evaluated and excluded: `supabase`. Its authorization server advertises
// only `client_secret_basic` / `client_secret_post` and not `"none"` — i.e.
// confidential clients only, which Ethos rejects with
// `ConfidentialClientUnsupported`.

export const MCP_REMOTE_PRESETS: Record<string, McpRemotePreset> = {
  // --- Docs & knowledge (no auth) ---
  deepwiki: {
    name: 'deepwiki',
    label: 'DeepWiki',
    url: 'https://mcp.deepwiki.com/mcp',
    transport: 'streamable-http',
    authType: 'none',
    description:
      'Ask questions about any public GitHub repo and get answers grounded in its source',
    category: DOCS,
    docsUrl: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
  },
  context7: {
    name: 'context7',
    label: 'Context7',
    url: 'https://mcp.context7.com/mcp',
    transport: 'streamable-http',
    // Context7 returns a `WWW-Authenticate: Bearer ...` header on a 200 response.
    // That is advisory, not a challenge — the server is genuinely no-auth today,
    // confirmed by an anonymous `tools/call` returning live data. Do not "fix"
    // this to `bearer` on seeing that header. An API key only raises rate limits.
    authType: 'none',
    description: 'Look up current documentation for a library or framework by name and version',
    category: DOCS,
    docsUrl: 'https://github.com/upstash/context7',
  },
  'aws-knowledge': {
    name: 'aws-knowledge',
    label: 'AWS Knowledge',
    // Bare origin — there is NO `/mcp` path on this host. Appending one is the
    // obvious-looking mistake and does not resolve to the server.
    url: 'https://knowledge-mcp.global.api.aws',
    transport: 'streamable-http',
    authType: 'none',
    // Responds with plain `application/json` and negotiates MCP protocol
    // `2025-03-26` rather than SSE / `2025-06-18`. Both are fine: our client uses
    // the official SDK's StreamableHTTPClientTransport, which branches on the
    // response content-type and accepts `application/json`, and `2025-03-26` is
    // in the SDK's SUPPORTED_PROTOCOL_VERSIONS.
    description: 'Search and retrieve official AWS documentation and API references',
    category: DOCS,
    docsUrl: 'https://github.com/awslabs/mcp/tree/main/src/aws-knowledge-mcp-server',
  },
  'microsoft-learn': {
    name: 'microsoft-learn',
    label: 'Microsoft Learn',
    url: 'https://learn.microsoft.com/api/mcp',
    transport: 'streamable-http',
    authType: 'none',
    description: 'Search official Microsoft and Azure documentation and code samples',
    category: DOCS,
    docsUrl: 'https://github.com/MicrosoftDocs/mcp',
  },
  wolfram: {
    name: 'wolfram',
    label: 'Wolfram',
    // Host is `agenttools.wolfram.com`, NOT `services.wolfram.com/api/mcp`. The
    // latter is what most write-ups show; it 401s and requires a Wolfram account
    // bearer token. This one answers anonymously.
    url: 'https://agenttools.wolfram.com/mcp',
    transport: 'streamable-http',
    authType: 'none',
    // Same plain-`application/json` + protocol `2025-03-26` shape as
    // aws-knowledge above; the SDK transport handles both.
    description: 'Compute answers and query curated data with Wolfram Alpha',
    category: DOCS,
  },

  // --- Developer tools (OAuth, DCR-installable) ---
  sentry: {
    name: 'sentry',
    label: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    transport: 'streamable-http',
    authType: 'oauth',
    description: 'Search Sentry issues and inspect events, traces, and releases',
    category: DEV_TOOLS,
  },
  vercel: {
    name: 'vercel',
    label: 'Vercel',
    // Bare origin — no `/mcp` path on this host.
    url: 'https://mcp.vercel.com',
    transport: 'streamable-http',
    authType: 'oauth',
    description: 'Inspect Vercel projects, deployments, and build logs',
    category: DEV_TOOLS,
    docsUrl: 'https://vercel.com/docs/mcp/vercel-mcp',
  },

  // --- Productivity (OAuth, DCR-installable) ---
  linear: {
    name: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'streamable-http',
    authType: 'oauth',
    description: 'Read and update Linear issues, projects, and cycles',
    category: PRODUCTIVITY,
    docsUrl: 'https://linear.app/docs/mcp',
  },
  notion: {
    name: 'notion',
    label: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    transport: 'streamable-http',
    authType: 'oauth',
    description: 'Search and edit Notion pages and databases',
    category: PRODUCTIVITY,
    docsUrl: 'https://developers.notion.com/docs/mcp',
  },
  asana: {
    name: 'asana',
    label: 'Asana',
    // Use the `/mcp` path, not the `/sse` one most Asana docs show. `/mcp` is a
    // real route (a control probe of a bogus path 404s) and speaks
    // streamable-http, which is the transport this preset type models.
    url: 'https://mcp.asana.com/mcp',
    transport: 'streamable-http',
    authType: 'oauth',
    description: 'Read and update Asana tasks, projects, and workspaces',
    category: PRODUCTIVITY,
    docsUrl: 'https://developers.asana.com/docs/using-asanas-mcp-server',
  },
};

export function getRemotePreset(name: string): McpRemotePreset | undefined {
  return MCP_REMOTE_PRESETS[name];
}
