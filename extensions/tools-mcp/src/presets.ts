// MCP server presets — well-known community servers with sensible defaults.
//
// Every invocation below was verified against the npm and PyPI registries and
// the upstream `modelcontextprotocol/servers` README: the four upstream
// presets on 2026-09-01 (the two npx-launched servers were actually run), and
// `google-calendar` on 2026-09-04. These are checked values, not guesses — if
// you change one, re-check it the same way.
//
// A `sqlite` preset used to live here. It is gone on purpose: upstream moved
// the server to `modelcontextprotocol/servers-archived` (last release April
// 2025), it is Python-only, and the npm package the preset named
// (`@modelcontextprotocol/server-sqlite`) has never existed. Do not re-add it.

export interface McpPreset {
  name: string;
  description: string;
  command: string;
  args: string[];
  envVars: string[]; // env vars this preset expects
  /**
   * Values the user supplies that are appended to `args`, in order.
   *
   * The final argv is `command` + `args` + one value per entry here, in
   * declaration order. Servers that take their configuration on the command
   * line (rather than from the environment) need this: `server-filesystem`
   * reads its allowed directories as positional arguments, and `mcp-server-git`
   * takes `--repository <path>` — the flag lives in `args`, the value here.
   */
  argVars: string[];
  /** Grouping label for the catalog UI, e.g. "Developer tools". */
  category: string;
}

export const MCP_PRESETS: Record<string, McpPreset> = {
  filesystem: {
    name: 'filesystem',
    description: 'Read/write local files under a required allowed path',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    // The server takes allowed directories as positional args, NOT from the
    // environment. Started with none it logs "Started without allowed
    // directories" and every tool call fails.
    envVars: [],
    argVars: ['ALLOWED_PATH'],
    category: 'Developer tools',
  },
  git: {
    name: 'git',
    description: 'Git repository operations (requires uvx)',
    command: 'uvx',
    args: ['mcp-server-git', '--repository'],
    envVars: [],
    argVars: ['GIT_REPO_PATH'],
    category: 'Developer tools',
  },
  fetch: {
    name: 'fetch',
    description: 'HTTP fetch operations (requires uvx)',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    envVars: [],
    argVars: [],
    category: 'Web',
  },
  'google-calendar': {
    name: 'google-calendar',
    // Not one-click, and the description has to say so: the user creates an
    // OAuth client in their own Google Cloud project and points
    // GOOGLE_OAUTH_CREDENTIALS at the downloaded client JSON. The server then
    // runs a one-time browser consent on first use.
    description:
      'Read and manage Google Calendar events (set GOOGLE_OAUTH_CREDENTIALS to your Google Cloud OAuth client JSON)',
    command: 'npx',
    // Community server, not Google-official. Verified 2026-09-04 against the
    // npm registry: `@cocal/google-calendar-mcp` 2.6.3, bin
    // `google-calendar-mcp` -> build/index.js, so `npx -y` resolves.
    args: ['-y', '@cocal/google-calendar-mcp'],
    envVars: ['GOOGLE_OAUTH_CREDENTIALS'],
    argVars: [],
    // 'Utilities', not the remote catalog's 'Productivity': the local presets
    // render in their own dropdown (AddMcpModal's stdio mode) with their own
    // three-label scheme, so borrowing a remote label would add a fourth stdio
    // category without ever putting the two lists side by side.
    category: 'Utilities',
  },
  memory: {
    name: 'memory',
    description: 'Key-value memory store',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    // Optional — defaults to a memory.json beside the installed package.
    envVars: ['MEMORY_FILE_PATH'],
    argVars: [],
    category: 'Utilities',
  },
};

/** Look up a preset by name. Returns undefined for unknown names. */
export function getPreset(name: string): McpPreset | undefined {
  return MCP_PRESETS[name];
}
