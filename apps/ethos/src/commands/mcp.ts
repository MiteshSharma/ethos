// ethos mcp — MCP server lifecycle and client configuration
//
// Subcommands:
//   ethos mcp serve            Start the MCP stdio server
//   ethos mcp install <client> Write Ethos into a client's MCP config
//   ethos mcp init             Show quick-start snippet for a client
//   ethos mcp doctor           Verify MCP server is reachable and functional
//   ethos mcp inspect          List tools, resources, and prompts
//   ethos mcp add <name>       Add an MCP server to ~/.ethos/mcp.json
//   ethos mcp presets           List available MCP server presets

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ethosDir, readConfig, readRawConfig } from '@ethosagent/config';
import type { ClientAdapter } from '@ethosagent/mcp-server';
import {
  claudeDesktop,
  continueClient,
  cursor,
  EthosMcpServer,
  logger as mcpLogger,
  opencode,
  zed,
} from '@ethosagent/mcp-server';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { PersonalityScopedSecrets } from '@ethosagent/storage-fs';
import type { McpServerConfig, OAuthConfig, TokenSet } from '@ethosagent/tools-mcp';
import {
  getPreset,
  MCP_PRESETS,
  McpJsonStore,
  mcpEnvSecretRef,
  revokeToken,
  runDcrAuthorization,
  runPkceLogin,
  storeEnvSecrets,
} from '@ethosagent/tools-mcp';
import type { SecretsResolver } from '@ethosagent/types';
import { writeJson } from '../json-output';
import { createAgentLoop, getSecretsResolver, getStorage } from '../wiring';

const mcpStore = new McpJsonStore(getStorage());

const CLIENTS: ClientAdapter[] = [claudeDesktop, cursor, opencode, continueClient, zed];

const USAGE = `Usage: ethos mcp <subcommand> [options]

Subcommands:
  serve [options]  Start the Ethos MCP server
    --http           Use Streamable HTTP transport instead of stdio
    --port <n>       HTTP port (default: 3300, implies --http)
  install <client> Install Ethos into a supported MCP client's config
  init [client]    Print quick-start config snippet
  doctor           Verify server configuration
  inspect          List available tools, resources, and prompts
  add <name>       Add an MCP server to ~/.ethos/mcp.json
    --preset <name>  Use a built-in preset (see 'ethos mcp presets')
    --url <mcpUrl>   Remote MCP server URL (runs OAuth discovery + DCR)
    --env KEY=val    Set environment variable (repeatable)
  presets          List available MCP server presets
  login <name>     Authenticate with an OAuth-configured MCP server
  logout <name>    Revoke and delete tokens for an MCP server
  registry list    Browse MCP server packages from npm
    --search <q>     Filter by keyword
  registry install <package>  Install a package as an MCP server

Supported clients: ${CLIENTS.map((c) => c.name).join(', ')}`;

export async function runMcp(argv: string[]): Promise<void> {
  const sub = argv[0] ?? '';

  switch (sub) {
    case 'serve':
      return runServe(argv.slice(1));
    case 'install':
      return runInstall(argv.slice(1));
    case 'init':
      return runInit(argv[1]);
    case 'doctor':
      return runDoctor(argv.slice(1));
    case 'inspect':
      return runInspect(argv.slice(1));
    case 'add':
      return runAdd(argv.slice(1));
    case 'presets':
      return runPresets(argv.slice(1));
    case 'login':
      return runLogin(argv.slice(1));
    case 'logout':
      return runLogout(argv.slice(1));
    case 'registry':
      return runRegistry(argv.slice(1));
    default: {
      if (sub && sub !== '--help' && sub !== '-h') {
        console.error(`Unknown subcommand: ${sub}\n`);
      }
      console.log(USAGE);
    }
  }
}

async function runServe(argv: string[]): Promise<void> {
  let useHttp = false;
  let port = 3300;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--http') {
      useHttp = true;
    } else if (arg === '--port') {
      useHttp = true;
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        console.error('--port requires a number');
        process.exitCode = 1;
        return;
      }
      port = Number(next);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${next}`);
        process.exitCode = 1;
        return;
      }
      i++;
    }
  }

  const storage = getStorage();
  const config = await readConfig(storage, await getSecretsResolver());
  if (!config) {
    // Must go to stderr — stdout must remain pure JSON-RPC
    process.stderr.write(
      JSON.stringify({ level: 'error', msg: 'No ~/.ethos/config.yaml found. Run: ethos setup' }) +
        '\n',
    );
    process.exit(1);
  }
  const { loop } = await createAgentLoop(config);
  const sessionStore = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
  const server = new EthosMcpServer({
    loop,
    dataDir: ethosDir(),
    logger: mcpLogger,
    sessionStore,
  });

  if (useHttp) {
    await server.serveHttp({ port });
    // Keep process alive — the HTTP server handles shutdown
  } else {
    await server.start();
    // Keep process alive — the stdio transport handles shutdown
  }
}

async function runInstall(argv: string[]): Promise<void> {
  const clientName = argv[0];
  if (!clientName) {
    console.log(`Specify a client to install into:\n\n  ethos mcp install <client>\n`);
    console.log(`Supported: ${CLIENTS.map((c) => c.name).join(', ')}`);
    return;
  }

  const adapter = CLIENTS.find((c) => c.name === clientName);
  if (!adapter) {
    console.error(`Unknown client: ${clientName}`);
    console.error(`Supported: ${CLIENTS.map((c) => c.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const configPath = adapter.configPath();
  const existing = adapter.readConfig(configPath);
  const entry = { command: process.execPath, args: [process.argv[1] ?? 'ethos', 'mcp', 'serve'] };
  const updated = adapter.injectEntry(existing, entry);
  const serialised = adapter.serialise(updated);

  if (!existsSync(dirname(configPath))) {
    mkdirSync(dirname(configPath), { recursive: true });
  }
  writeFileSync(configPath, serialised, 'utf8');
  console.log(`✓ Installed Ethos MCP server into ${adapter.displayName}`);
  console.log(`  Config: ${configPath}`);
}

function runInit(clientName?: string): void {
  const adapter = clientName ? CLIENTS.find((c) => c.name === clientName) : null;

  if (clientName && !adapter) {
    console.error(`Unknown client: ${clientName}`);
    console.error(`Supported: ${CLIENTS.map((c) => c.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const execPath = process.execPath;
  const scriptPath = process.argv[1] ?? 'ethos';

  if (!adapter || adapter.name === 'claude-desktop' || adapter.name === 'cursor') {
    console.log(`Add to claude_desktop_config.json / mcp.json:\n`);
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            ethos: { command: execPath, args: [scriptPath, 'mcp', 'serve'] },
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (adapter.name === 'opencode') {
    console.log(`Add to ~/.config/opencode/config.json:\n`);
    console.log(
      JSON.stringify(
        {
          mcp: {
            servers: {
              ethos: { type: 'local', command: [execPath, scriptPath, 'mcp', 'serve'] },
            },
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (adapter.name === 'zed') {
    console.log(`Add to Zed settings.json:\n`);
    console.log(
      JSON.stringify(
        {
          context_servers: {
            ethos: { command: { path: execPath, args: [scriptPath, 'mcp', 'serve'] } },
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (adapter.name === 'continue') {
    console.log(`Add to ~/.continue/config.json:\n`);
    console.log(
      JSON.stringify(
        {
          mcpServers: [{ name: 'ethos', command: execPath, args: [scriptPath, 'mcp', 'serve'] }],
        },
        null,
        2,
      ),
    );
    return;
  }
}

// ---------------------------------------------------------------------------
// mcp add — add an MCP server entry to ~/.ethos/mcp.json
// ---------------------------------------------------------------------------

const ADD_USAGE = `Usage: ethos mcp add <name> [options]

Options:
  --preset <name>  Use a built-in preset (see 'ethos mcp presets')
  --url <mcpUrl>   Remote MCP server URL (runs OAuth discovery + DCR)
  --env KEY=val    Set environment variable (repeatable)

Without --preset or --url, you must provide --command and optionally --args:
  --command <cmd>  Server command (e.g. 'npx')
  --args <a> ...   Command arguments (consumes remaining positional args)

Examples:
  ethos mcp add fs --preset filesystem --env ALLOWED_PATHS=/data
  ethos mcp add my-git --preset git --env GIT_REPO_PATH=/repos/myapp
  ethos mcp add custom --command npx --args -y @myorg/mcp-server
  ethos mcp add linear --url https://mcp.linear.app/mcp`;

function parseAddArgs(argv: string[]): {
  name?: string;
  preset?: string;
  url?: string;
  env: Record<string, string>;
  command?: string;
  args: string[];
} {
  const env: Record<string, string> = {};
  const extraArgs: string[] = [];
  let name: string | undefined;
  let preset: string | undefined;
  let url: string | undefined;
  let command: string | undefined;
  let collectingArgs = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';

    if (collectingArgs) {
      extraArgs.push(arg);
      continue;
    }

    if (arg === '--preset') {
      preset = argv[i + 1];
      i++;
    } else if (arg === '--url') {
      url = argv[i + 1];
      i++;
    } else if (arg === '--env') {
      const val = argv[i + 1];
      if (val) {
        const eqIdx = val.indexOf('=');
        if (eqIdx > 0) {
          env[val.slice(0, eqIdx)] = val.slice(eqIdx + 1);
        }
      }
      i++;
    } else if (arg === '--command') {
      command = argv[i + 1];
      i++;
    } else if (arg === '--args') {
      collectingArgs = true;
    } else if (!arg.startsWith('-') && !name) {
      name = arg;
    }
  }

  return { name, preset, url, env, command, args: extraArgs };
}

async function readMcpJson(): Promise<McpServerConfig[]> {
  return mcpStore.read();
}

/**
 * `--env KEY=value` values are credential material more often than not
 * (API tokens for the server subprocess). G-SEC forbids writing a secret
 * value into an MCP server config, so the value goes to the SecretsResolver
 * and `mcp.json` gets the `${secrets:ref}` — resolved at spawn time by
 * McpClient. Returns the map to persist in place of the raw values.
 */
async function persistEnvSecrets(
  serverName: string,
  env: Record<string, string>,
): Promise<Record<string, string>> {
  if (Object.keys(env).length === 0) return {};
  return storeEnvSecrets(serverName, env, await getSecretsResolver());
}

async function runAdd(argv: string[]): Promise<void> {
  const parsed = parseAddArgs(argv);

  if (!parsed.name) {
    console.log(ADD_USAGE);
    return;
  }

  // Check for duplicate name
  const existing = await readMcpJson();
  if (existing.some((s) => s.name === parsed.name)) {
    console.error(`MCP server '${parsed.name}' already exists in ~/.ethos/mcp.json`);
    console.error('Remove it first or choose a different name.');
    process.exitCode = 1;
    return;
  }

  let entry: McpServerConfig;

  if (parsed.preset) {
    const preset = getPreset(parsed.preset);
    if (!preset) {
      console.error(`Unknown preset: ${parsed.preset}`);
      console.error(`Available presets: ${Object.keys(MCP_PRESETS).join(', ')}`);
      process.exitCode = 1;
      return;
    }

    const envKeys = Object.keys(parsed.env);
    const envPassthrough = envKeys.length > 0 ? envKeys : undefined;
    const envRefs = await persistEnvSecrets(parsed.name, parsed.env);

    entry = {
      name: parsed.name,
      transport: 'stdio',
      command: preset.command,
      args: preset.args,
      ...(envKeys.length > 0 ? { env: envRefs } : {}),
      ...(envPassthrough ? { mcpEnvPassthrough: envPassthrough } : {}),
    };
  } else if (parsed.command) {
    const envKeys = Object.keys(parsed.env);
    const envPassthrough = envKeys.length > 0 ? envKeys : undefined;
    const envRefs = await persistEnvSecrets(parsed.name, parsed.env);

    entry = {
      name: parsed.name,
      transport: 'stdio',
      command: parsed.command,
      ...(parsed.args.length > 0 ? { args: parsed.args } : {}),
      ...(envKeys.length > 0 ? { env: envRefs } : {}),
      ...(envPassthrough ? { mcpEnvPassthrough: envPassthrough } : {}),
    };
  } else if (parsed.url) {
    const urlResult = await runAddUrl(parsed.name, parsed.url);
    if (!urlResult) return;
    entry = urlResult.entry;

    await mcpStore.upsert(entry.name, entry);

    console.log(`Added MCP server '${parsed.name}' to ~/.ethos/mcp.json`);
    console.log(`Run 'ethos mcp login ${parsed.name} --personality <id>' to authenticate.`);
    return;
  } else {
    console.error('Either --preset, --url, or --command is required.\n');
    console.log(ADD_USAGE);
    process.exitCode = 1;
    return;
  }

  await mcpStore.upsert(entry.name, entry);
  console.log(`Added MCP server '${parsed.name}' to ~/.ethos/mcp.json`);
  for (const key of Object.keys(parsed.env)) {
    console.log(
      `  ${key} stored as secret '${mcpEnvSecretRef(parsed.name, key)}' — mcp.json holds only the reference.`,
    );
  }
}

interface UrlAddResult {
  entry: McpServerConfig;
  tokens: TokenSet;
  registrationAccessToken?: string;
}

async function runAddUrl(name: string, mcpUrl: string): Promise<UrlAddResult | null> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(mcpUrl);
  } catch {
    console.error(`Invalid URL: ${mcpUrl}`);
    process.exitCode = 1;
    return null;
  }
  if (parsedUrl.protocol !== 'https:') {
    console.error('Remote MCP server URL must use https://');
    process.exitCode = 1;
    return null;
  }

  process.stderr.write('Discovering OAuth metadata...\n');

  let result: Awaited<ReturnType<typeof runDcrAuthorization>>;
  try {
    result = await runDcrAuthorization(mcpUrl, 'Ethos', (url) => {
      process.stderr.write(`\nOpen this URL to authorize:\n${url}\n\n`);
    });
  } catch (err) {
    console.error(`OAuth setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return null;
  }

  const { tokens, dcrResult, meta } = result;
  const registrationEndpoint = meta.registration_endpoint ?? '';

  const entry: McpServerConfig = {
    name,
    transport: 'streamable-http',
    url: mcpUrl,
    auth: {
      type: 'oauth2',
      authorization_endpoint: meta.authorization_endpoint,
      token_endpoint: meta.token_endpoint,
      client_id: dcrResult.client_id,
      ...(meta.revocation_endpoint ? { revocation_endpoint: meta.revocation_endpoint } : {}),
      ...(meta.introspection_endpoint
        ? { introspection_endpoint: meta.introspection_endpoint }
        : {}),
      dcr: {
        registration_endpoint: registrationEndpoint,
        ...(dcrResult.client_id_issued_at != null
          ? { client_id_issued_at: dcrResult.client_id_issued_at }
          : {}),
        ...(dcrResult.registration_client_uri
          ? { registration_client_uri: dcrResult.registration_client_uri }
          : {}),
      },
    },
    created_via: 'cli',
  };

  return {
    entry,
    tokens,
    ...(dcrResult.registration_access_token
      ? { registrationAccessToken: dcrResult.registration_access_token }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// mcp presets — list available presets
// ---------------------------------------------------------------------------

function runPresets(argv: string[]): void {
  if (argv.includes('--json')) {
    const presets = Object.values(MCP_PRESETS).map((preset) => ({
      name: preset.name,
      description: preset.description,
      envVars: preset.envVars,
    }));
    writeJson(presets);
    return;
  }

  console.log('Available MCP server presets:\n');
  for (const preset of Object.values(MCP_PRESETS)) {
    const envHint = preset.envVars.length > 0 ? ` (env: ${preset.envVars.join(', ')})` : '';
    console.log(`  ${preset.name.padEnd(14)} ${preset.description}${envHint}`);
  }
  console.log('\nUsage: ethos mcp add <name> --preset <preset> [--env KEY=val ...]');
}

function runDoctor(argv: string[]): void {
  const execPath = process.execPath;
  const scriptPath = process.argv[1] ?? 'ethos';

  if (argv.includes('--json')) {
    const clients = CLIENTS.map((adapter) => {
      const path = adapter.configPath();
      return {
        name: adapter.name,
        displayName: adapter.displayName,
        configPath: path,
        installed: existsSync(path),
      };
    });
    writeJson({
      node: execPath,
      script: scriptPath,
      command: `${execPath} ${scriptPath} mcp serve`,
      clients,
    });
    return;
  }

  console.log('Ethos MCP doctor\n');
  console.log(`  Node:   ${execPath}`);
  console.log(`  Script: ${scriptPath}`);
  console.log(`  Command: ${execPath} ${scriptPath} mcp serve`);
  console.log();

  for (const adapter of CLIENTS) {
    const path = adapter.configPath();
    const installed = existsSync(path);
    const mark = installed ? '✓' : ' ';
    console.log(`  [${mark}] ${adapter.displayName.padEnd(20)} ${path}`);
  }

  console.log();
  console.log('Run "ethos mcp install <client>" to configure a client.');
}

function runInspect(argv: string[]): void {
  if (argv.includes('--json')) {
    writeJson({
      tools: [
        { name: 'ask_personality', description: 'Run a prompt through a specific personality' },
        { name: 'list_personalities', description: 'List all available personalities' },
        { name: 'search_memory', description: 'Search MEMORY.md and USER.md' },
        { name: 'list_sessions', description: 'List recent sessions with metadata' },
        { name: 'get_session', description: 'Get session metadata and first page of messages' },
        { name: 'get_messages', description: 'Get messages from a session' },
        { name: 'search_sessions', description: 'Full-text search across session messages' },
      ],
      resources: [
        { uri: 'ethos://memory/MEMORY.md', description: 'Agent memory' },
        { uri: 'ethos://memory/USER.md', description: 'User context' },
        { uri: 'ethos://sessions/recent', description: 'Recent sessions' },
        { uri: 'ethos://personalities/<id>/SOUL.md', description: 'Personality identity' },
      ],
      prompts: [
        { name: 'code_review', description: 'Structured code review' },
        { name: 'research_topic', description: 'Deep research with citations' },
        { name: 'reflect_on_decision', description: 'Coaching reflection' },
        { name: 'debug_failure', description: 'Evidence-first failure investigation' },
      ],
    });
    return;
  }

  console.log('Tools:\n');
  console.log('  ask_personality     Run a prompt through a specific personality');
  console.log('  list_personalities  List all available personalities');
  console.log('  search_memory       Search MEMORY.md and USER.md');
  console.log('  list_sessions       List recent sessions with metadata');
  console.log('  get_session         Get session metadata and first page of messages');
  console.log('  get_messages        Get messages from a session');
  console.log('  search_sessions     Full-text search across session messages');

  console.log('\nResources:\n');
  console.log('  ethos://memory/MEMORY.md          Agent memory');
  console.log('  ethos://memory/USER.md             User context');
  console.log('  ethos://sessions/recent            Recent sessions');
  console.log('  ethos://personalities/<id>/SOUL.md  Personality identity');

  console.log('\nPrompts:\n');
  console.log('  code_review          Structured code review');
  console.log('  research_topic       Deep research with citations');
  console.log('  reflect_on_decision  Coaching reflection');
  console.log('  debug_failure        Evidence-first failure investigation');
}

// ---------------------------------------------------------------------------
// mcp registry — browse and install MCP servers from npm
// ---------------------------------------------------------------------------

async function runRegistry(argv: string[]): Promise<void> {
  const sub = argv[0] ?? '';
  switch (sub) {
    case 'list':
      return runRegistryList(argv.slice(1));
    case 'install':
      return runRegistryInstall(argv.slice(1));
    default:
      console.log(`Usage: ethos mcp registry <list|install> [options]

  list [--search <q>]     Browse MCP server packages from npm
  install <package>       Install a package as an MCP server`);
  }
}

async function runRegistryList(argv: string[]): Promise<void> {
  let search = '';
  const json = argv.includes('--json');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--search' && argv[i + 1]) {
      search = argv[i + 1] ?? '';
      i++;
    }
  }

  const url = `https://registry.npmjs.org/-/v1/search?text=keywords:mcp-server${search ? `+${search}` : ''}&size=20`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Registry query failed: ${res.status}`);
    process.exitCode = 1;
    return;
  }
  const data = (await res.json()) as {
    objects: Array<{ package: { name: string; description?: string; version: string } }>;
  };

  if (json) {
    const packages = data.objects.map((obj) => ({
      name: obj.package.name,
      version: obj.package.version,
      description: obj.package.description ?? null,
    }));
    writeJson(packages);
    return;
  }

  if (data.objects.length === 0) {
    console.log('No packages found.');
    return;
  }

  console.log('MCP server packages:\n');
  for (const obj of data.objects) {
    const pkg = obj.package;
    console.log(`  ${pkg.name}@${pkg.version}`);
    if (pkg.description) console.log(`    ${pkg.description}`);
  }
  console.log(`\nInstall: ethos mcp registry install <package>`);
}

async function runRegistryInstall(argv: string[]): Promise<void> {
  const packageName = argv[0];
  if (!packageName) {
    console.error('Usage: ethos mcp registry install <package>');
    process.exitCode = 1;
    return;
  }

  const name = packageName.replace(/^@[^/]+\//, '').replace(/^server-/, '');

  const existing = await readMcpJson();
  if (existing.some((s) => s.name === name)) {
    console.error(`Server '${name}' already exists.`);
    process.exitCode = 1;
    return;
  }

  const entry: McpServerConfig = {
    name,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', packageName],
  };

  await mcpStore.upsert(entry.name, entry);
  console.log(`Installed '${name}' (${packageName}) to ~/.ethos/mcp.json`);
}

// ---------------------------------------------------------------------------
// mcp login / logout — OAuth 2.1 PKCE flows
// ---------------------------------------------------------------------------

function parsePersonalityFlag(argv: string[]): {
  serverName?: string;
  personalityId?: string;
  error?: string;
} {
  let serverName: string | undefined;
  let personalityId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--personality') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        return { error: '--personality requires a value' };
      }
      personalityId = next;
      i++;
    } else if (!arg?.startsWith('--') && !serverName) {
      serverName = arg;
    }
  }
  return { serverName, personalityId };
}

async function resolvePersonalitySecrets(
  explicitId: string | undefined,
): Promise<{ secrets: SecretsResolver; personalityId: string | undefined }> {
  const secrets = await getSecretsResolver();
  let personalityId = explicitId;

  if (!personalityId) {
    const raw = await readRawConfig(getStorage());
    if (raw) {
      personalityId = raw.activeContext?.name ?? raw.personality;
    }
  }

  if (personalityId) {
    return { secrets: new PersonalityScopedSecrets(secrets, personalityId), personalityId };
  }
  return { secrets, personalityId: undefined };
}

async function runLogin(argv: string[]): Promise<void> {
  const { serverName, personalityId, error } = parsePersonalityFlag(argv);
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }
  if (!serverName) {
    console.error('Usage: ethos mcp login <serverName> [--personality <id>]');
    process.exitCode = 1;
    return;
  }

  const configs = await readMcpJson();

  const config = configs.find((c) => c.name === serverName);
  if (!config) {
    console.error(`MCP server '${serverName}' not found in ~/.ethos/mcp.json`);
    process.exitCode = 1;
    return;
  }

  if (config.auth?.type !== 'oauth2') {
    console.error(`MCP server '${serverName}' does not have OAuth 2.1 auth configured`);
    process.exitCode = 1;
    return;
  }

  const resolved = await resolvePersonalitySecrets(personalityId);
  const oauthConfig: OAuthConfig = config.auth;

  try {
    await runPkceLogin(serverName, oauthConfig, resolved.secrets);
    const scope = resolved.personalityId ? ` (personality: ${resolved.personalityId})` : '';
    console.log(`Successfully authenticated with '${serverName}'${scope}`);
  } catch (err) {
    console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function runLogout(argv: string[]): Promise<void> {
  const { serverName, personalityId, error } = parsePersonalityFlag(argv);
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }
  if (!serverName) {
    console.error('Usage: ethos mcp logout <serverName> [--personality <id>]');
    process.exitCode = 1;
    return;
  }

  const configs = await readMcpJson();

  const config = configs.find((c) => c.name === serverName);
  if (!config) {
    console.error(`MCP server '${serverName}' not found in ~/.ethos/mcp.json`);
    process.exitCode = 1;
    return;
  }

  const oauthConfig: OAuthConfig | undefined =
    config.auth?.type === 'oauth2' ? config.auth : undefined;

  if (!oauthConfig) {
    console.error(`MCP server '${serverName}' does not have OAuth 2.1 auth configured`);
    process.exitCode = 1;
    return;
  }

  const resolved = await resolvePersonalitySecrets(personalityId);

  try {
    await revokeToken(serverName, oauthConfig, resolved.secrets);
    const scope = resolved.personalityId ? ` (personality: ${resolved.personalityId})` : '';
    console.log(`Logged out of '${serverName}' — tokens revoked and deleted${scope}`);
  } catch (err) {
    console.error(`Logout failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
