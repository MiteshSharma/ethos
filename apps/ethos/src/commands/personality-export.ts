// ethos personality export <id> — produce a shareable tar.gz of one personality
//
// Exports SOUL.md, config.yaml, toolset.yaml, skills/**, and non-secret MCP
// config. Strips secrets (tokens, keys) and personal state (USER.md,
// kanban.db, dream-state.json). Generates a secrets.manifest.yaml so the
// recipient knows which credentials to fill in.
//
// Phase 5: adds BundleManifest (ETHOS.md), ExportStamp, --with-memory flag.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { declaredWorkdirs } from '@ethosagent/core';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import type { BundleManifest, ExportStamp, PersonalityConfig } from '@ethosagent/types';
import { getStorage } from '../wiring';
import { type Entry, writeTarGz } from './backup';

const MCP_TOKEN_FILENAMES = new Set(['access_token', 'refresh_token', 'expires_at']);
const MCP_EXPORT_ALLOWLIST = new Set(['config.yaml']);

const KNOWN_SECRET_FIELDS = new Set([
  'anthropicapikey',
  'openaiapikey',
  'telegramtoken',
  'telegrambottoken',
  'discordtoken',
  'discordbottoken',
  'slackbottoken',
  'slackapptoken',
  'slacksigningsecret',
  'emailpassword',
]);

const SECRET_FIELD_DISPLAY: Record<string, { key: string; description: string; fillWith: string }> =
  {
    anthropicapikey: {
      key: 'ANTHROPIC_API_KEY',
      description: 'Anthropic API key for LLM inference',
      fillWith: 'ethos keys set anthropic-api-key <value>',
    },
    openaiapikey: {
      key: 'OPENAI_API_KEY',
      description: 'OpenAI API key for LLM inference',
      fillWith: 'ethos keys set openai-api-key <value>',
    },
    telegramtoken: {
      key: 'TELEGRAM_TOKEN',
      description: 'Telegram bot token',
      fillWith: 'ethos secrets set telegram-token <value>',
    },
    telegrambottoken: {
      key: 'TELEGRAM_BOT_TOKEN',
      description: 'Telegram bot token',
      fillWith: 'ethos secrets set telegram-bot-token <value>',
    },
    discordtoken: {
      key: 'DISCORD_TOKEN',
      description: 'Discord bot token',
      fillWith: 'ethos secrets set discord-token <value>',
    },
    discordbottoken: {
      key: 'DISCORD_BOT_TOKEN',
      description: 'Discord bot token',
      fillWith: 'ethos secrets set discord-bot-token <value>',
    },
    slackbottoken: {
      key: 'SLACK_BOT_TOKEN',
      description: 'Slack bot OAuth token',
      fillWith: 'ethos secrets set slack-bot-token <value>',
    },
    slackapptoken: {
      key: 'SLACK_APP_TOKEN',
      description: 'Slack app-level token',
      fillWith: 'ethos secrets set slack-app-token <value>',
    },
    slacksigningsecret: {
      key: 'SLACK_SIGNING_SECRET',
      description: 'Slack signing secret for request verification',
      fillWith: 'ethos secrets set slack-signing-secret <value>',
    },
    emailpassword: {
      key: 'EMAIL_PASSWORD',
      description: 'Email account password for IMAP/SMTP',
      fillWith: 'ethos secrets set email-password <value>',
    },
  };

// Case-insensitive substrings that flag a config field as a secret reference
const SECRET_FIELD_PATTERNS = ['token', 'key', 'secret'];

const USAGE = 'Usage: ethos personality export <id> [--output <path>] [--with-memory]';

const ETHOS_EXPORT_KEY = 'ethos-personality-export-v1';

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/** Top-level files to include from the personality directory. */
const INCLUDE_FILES = new Set([
  'SOUL.md',
  'config.yaml',
  'toolset.yaml',
  'plugins.lock',
  'mcp.yaml',
]);

function collectPersonalityEntries(personalityDir: string, id: string): Entry[] {
  const entries: Entry[] = [];
  const prefix = join('personalities', id);

  // Top-level included files
  for (const file of INCLUDE_FILES) {
    const p = join(personalityDir, file);
    if (existsSync(p)) {
      entries.push({ relPath: join(prefix, file), content: readFileSync(p) });
    }
  }

  // skills/ directory (recursive)
  const skillsDir = join(personalityDir, 'skills');
  if (existsSync(skillsDir)) {
    const skillsSt = lstatSync(skillsDir);
    if (!skillsSt.isSymbolicLink() && skillsSt.isDirectory()) {
      collectDirRecursive(skillsDir, join(prefix, 'skills'), entries);
    }
  }

  // mcp/ directory — config.yaml only, skip token files
  const mcpDir = join(personalityDir, 'mcp');
  if (existsSync(mcpDir)) {
    const mcpSt = lstatSync(mcpDir);
    if (!mcpSt.isSymbolicLink() && mcpSt.isDirectory()) {
      collectMcpEntries(mcpDir, prefix, entries);
    }
  }

  return entries;
}

function collectDirRecursive(dir: string, relPrefix: string, entries: Entry[]): void {
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const st = lstatSync(fullPath);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      collectDirRecursive(fullPath, join(relPrefix, name), entries);
    } else if (st.isFile()) {
      entries.push({ relPath: join(relPrefix, name), content: readFileSync(fullPath) });
    }
  }
}

function collectMcpEntries(mcpDir: string, prefix: string, entries: Entry[]): void {
  for (const serverName of readdirSync(mcpDir)) {
    const serverDir = join(mcpDir, serverName);
    const serverSt = lstatSync(serverDir);
    if (serverSt.isSymbolicLink() || !serverSt.isDirectory()) continue;

    for (const file of readdirSync(serverDir)) {
      const filePath = join(serverDir, file);
      const fileSt = lstatSync(filePath);
      if (fileSt.isSymbolicLink() || !fileSt.isFile()) continue;

      // Only include known safe config files
      if (!MCP_EXPORT_ALLOWLIST.has(file)) continue;

      entries.push({
        relPath: join(prefix, 'mcp', serverName, file),
        content: readFileSync(filePath),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Secrets manifest generation
// ---------------------------------------------------------------------------

function scanConfigForSecrets(personalityDir: string): string[] {
  const configPath = join(personalityDir, 'config.yaml');
  if (!existsSync(configPath)) return [];

  const content = readFileSync(configPath, 'utf8');
  const found: string[] = [];

  for (const line of content.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const fieldName = line.slice(0, colonIdx).trim();
    const lower = fieldName.toLowerCase();

    if (KNOWN_SECRET_FIELDS.has(lower)) {
      if (!found.includes(lower)) found.push(lower);
      continue;
    }

    // Check partial matches (field contains Token, Key, or Secret)
    for (const pattern of SECRET_FIELD_PATTERNS) {
      if (lower.includes(pattern)) {
        if (!found.includes(lower)) found.push(lower);
        break;
      }
    }
  }

  return found;
}

function scanMcpForStrippedServers(personalityDir: string): string[] {
  const mcpDir = join(personalityDir, 'mcp');
  if (!existsSync(mcpDir)) return [];
  const mcpSt = lstatSync(mcpDir);
  if (mcpSt.isSymbolicLink() || !mcpSt.isDirectory()) return [];

  const stripped: string[] = [];
  for (const serverName of readdirSync(mcpDir)) {
    const serverDir = join(mcpDir, serverName);
    const serverSt = lstatSync(serverDir);
    if (serverSt.isSymbolicLink() || !serverSt.isDirectory()) continue;

    for (const file of readdirSync(serverDir)) {
      if (MCP_TOKEN_FILENAMES.has(file)) {
        stripped.push(serverName);
        break;
      }
    }
  }
  return stripped;
}

function buildSecretsManifest(id: string, personalityDir: string): string | null {
  const secretFields = scanConfigForSecrets(personalityDir);
  const strippedServers = scanMcpForStrippedServers(personalityDir);

  if (secretFields.length === 0 && strippedServers.length === 0) return null;

  const lines: string[] = [
    '# Generated by ethos personality export',
    '# Fill these secrets before using this personality',
    `personality: ${id}`,
    `exported_at: ${new Date().toISOString()}`,
  ];

  if (secretFields.length > 0) {
    lines.push('');
    lines.push('secrets:');
    for (const field of secretFields) {
      const display = SECRET_FIELD_DISPLAY[field];
      if (display) {
        lines.push(`  - key: ${display.key}`);
        lines.push(`    description: ${display.description}`);
        lines.push(`    fill_with: "${display.fillWith}"`);
      } else {
        // Unknown secret field — emit a generic entry
        lines.push(`  - key: ${field}`);
        lines.push(`    description: Secret field "${field}" (stripped from export)`);
        lines.push(`    fill_with: "ethos secrets set ${field} <value>"`);
      }
    }
  }

  if (strippedServers.length > 0) {
    lines.push('');
    lines.push('mcp_auth:');
    for (const name of strippedServers) {
      lines.push(`  - server: ${name}`);
      lines.push(`    description: OAuth token for MCP server "${name}" (stripped from export)`);
      lines.push(`    fill_with: "ethos mcp auth ${name}"`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Plugin install manifest generation
// ---------------------------------------------------------------------------

function buildPluginsManifest(personalityDir: string, dataDir: string): string | null {
  const configPath = join(personalityDir, 'config.yaml');
  if (!existsSync(configPath)) return null;

  const configContent = readFileSync(configPath, 'utf8');
  const pluginsLine = configContent.split('\n').find((l) => l.startsWith('plugins:'));
  if (!pluginsLine) return null;

  const rawValue = pluginsLine.slice('plugins:'.length).trim();
  const pluginIds = rawValue.split(/\s+/).filter(Boolean);
  if (pluginIds.length === 0) return null;

  const pluginsNodeModules = join(dataDir, 'plugins', 'node_modules');
  if (!existsSync(pluginsNodeModules)) {
    // No plugins installed — emit manifest with IDs only
    const lines = [
      '# Generated by ethos personality export',
      '# Install these plugins on the target machine:',
      'plugins:',
      ...pluginIds.map((id) =>
        [`  - id: ${id}`, `    install: "ethos plugin install ${id}"`].join('\n'),
      ),
      '',
    ];
    return lines.join('\n');
  }

  // Scan node_modules to resolve full package name + version for each plugin ID
  const resolved: Array<{ id: string; packageName: string; version: string }> = [];

  function scanDir(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const entryPath = join(dir, entry);
      const st = lstatSync(entryPath);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory() && entry.startsWith('@')) {
        // scoped package — scan one level deeper
        scanDir(entryPath);
        continue;
      }
      if (!st.isDirectory()) continue;
      const pkgJsonPath = join(entryPath, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
          name?: string;
          version?: string;
          ethos?: { id?: string };
        };
        const ethosId = pkgJson.ethos?.id;
        if (!ethosId || !pluginIds.includes(ethosId)) continue;
        if (!resolved.find((r) => r.id === ethosId)) {
          resolved.push({
            id: ethosId,
            packageName: pkgJson.name ?? entry,
            version: pkgJson.version ?? 'unknown',
          });
        }
      } catch {
        // skip unreadable package.json
      }
    }
  }

  scanDir(pluginsNodeModules);

  const lines = [
    '# Generated by ethos personality export',
    '# Run these commands on the target machine to install required plugins:',
    'plugins:',
  ];

  for (const id of pluginIds) {
    const found = resolved.find((r) => r.id === id);
    if (found) {
      lines.push(`  - id: ${found.id}`);
      lines.push(`    package: "${found.packageName}"`);
      lines.push(`    version: "${found.version}"`);
      lines.push(`    install: "ethos plugin install ${found.packageName}"`);
    } else {
      // Not found in node_modules — emit with just the ID
      lines.push(`  - id: ${id}`);
      lines.push(`    install: "ethos plugin install ${id}"`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// MCP server config parsing (simple key: value YAML)
// ---------------------------------------------------------------------------

interface McpServerInfo {
  name: string;
  url: string;
  transport: string;
  authType: 'none' | 'oauth2' | 'bearer';
  tools: string[];
}

function parseMcpServerConfig(
  personalityDir: string,
  serverName: string,
  toolset: string[],
): McpServerInfo {
  const info: McpServerInfo = {
    name: serverName,
    url: '',
    transport: '',
    authType: 'none',
    tools: [],
  };

  // Extract tools prefixed with mcp__<serverName>__
  const prefix = `mcp__${serverName}__`;
  info.tools = toolset.filter((t) => t.startsWith(prefix));

  const configPath = join(personalityDir, 'mcp', serverName, 'config.yaml');
  if (!existsSync(configPath)) return info;

  const content = readFileSync(configPath, 'utf8');
  for (const line of content.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (key === 'url') {
      info.url = value;
    } else if (key === 'transport') {
      info.transport = value;
    } else if (key === 'auth' || key === 'auth_type' || key === 'authtype') {
      const lower = value.toLowerCase();
      if (lower.includes('oauth')) {
        info.authType = 'oauth2';
      } else if (lower.includes('bearer')) {
        info.authType = 'bearer';
      }
    }
  }

  // Detect auth type from token file presence if not already set
  if (info.authType === 'none') {
    const serverDir = join(personalityDir, 'mcp', serverName);
    if (existsSync(serverDir)) {
      try {
        const files = readdirSync(serverDir);
        if (files.some((f) => MCP_TOKEN_FILENAMES.has(f))) {
          info.authType = 'oauth2';
        }
      } catch {
        // ignore
      }
    }
  }

  return info;
}

// ---------------------------------------------------------------------------
// Plugin resolution for manifest
// ---------------------------------------------------------------------------

interface PluginInfo {
  id: string;
  version: string;
  source: string;
  tools: string[];
  skills: string[];
  credentials: string[];
}

/** Built-in tool names that are never attributed to plugins. */
const BUILTIN_TOOLS = new Set([
  'read_file',
  'write_file',
  'patch_file',
  'list_files',
  'run_bash',
  'run_code',
  'web_search',
  'web_extract',
  'browse_url',
  'memory_read',
  'memory_write',
  'session_search',
  'team_memory_read',
  'team_memory_write',
  'team_memory_search',
  'kanban_show',
  'kanban_plan',
  'kanban_begin',
  'kanban_complete',
  'kanban_blocked',
  'think',
]);

function resolvePlugins(pluginIds: string[], toolset: string[], dataDir: string): PluginInfo[] {
  const pluginsNodeModules = join(dataDir, 'plugins', 'node_modules');
  const result: PluginInfo[] = [];

  // Collect all mcp-prefixed tools so we can exclude them from plugin attribution
  const mcpTools = new Set(toolset.filter((t) => t.startsWith('mcp__')));

  for (const pluginId of pluginIds) {
    const info: PluginInfo = {
      id: pluginId,
      version: 'unknown',
      source: pluginId,
      tools: [],
      skills: [],
      credentials: [],
    };

    if (existsSync(pluginsNodeModules)) {
      const pkgJson = findPluginPackageJson(pluginsNodeModules, pluginId);
      if (pkgJson) {
        info.version = pkgJson.version ?? 'unknown';
        info.source = pkgJson.name ?? pluginId;
        if (pkgJson.ethos?.credentials) {
          // Key names only — never values
          info.credentials = pkgJson.ethos.credentials.map((c) => c.key);
        }
        if (pkgJson.ethos?.skills_dir) {
          info.skills = [pkgJson.ethos.skills_dir];
        }
      }
    }

    // Attribute non-builtin, non-mcp tools to this plugin
    // Convention: tools not prefixed with mcp__ and not in the builtin set
    // In practice we can't perfectly attribute without plugin metadata,
    // so we include tools that aren't builtin or mcp-prefixed
    result.push(info);
  }

  // Attribute remaining tools (not builtin, not mcp) across plugins
  // This is best-effort — without plugin tool manifests, we list them on the first plugin
  const unattributed = toolset.filter((t) => !BUILTIN_TOOLS.has(t) && !mcpTools.has(t));
  if (unattributed.length > 0 && result.length > 0) {
    const first = result[0];
    if (first) {
      first.tools = unattributed;
    }
  }

  return result;
}

interface PluginPackageJson {
  name?: string;
  version?: string;
  ethos?: {
    id?: string;
    credentials?: Array<{ key: string }>;
    skills_dir?: string;
  };
}

function findPluginPackageJson(nodeModulesDir: string, pluginId: string): PluginPackageJson | null {
  if (!existsSync(nodeModulesDir)) return null;

  function scanDir(dir: string): PluginPackageJson | null {
    for (const entry of readdirSync(dir)) {
      const entryPath = join(dir, entry);
      const st = lstatSync(entryPath);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory() && entry.startsWith('@')) {
        const found = scanDir(entryPath);
        if (found) return found;
        continue;
      }
      if (!st.isDirectory()) continue;
      const pkgJsonPath = join(entryPath, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PluginPackageJson;
        if (pkgJson.ethos?.id === pluginId) return pkgJson;
      } catch {
        // skip
      }
    }
    return null;
  }

  return scanDir(nodeModulesDir);
}

// ---------------------------------------------------------------------------
// SHA-256 helpers
// ---------------------------------------------------------------------------

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Bundle manifest builder
// ---------------------------------------------------------------------------

function readVersionFromConfig(personalityDir: string): string {
  const configPath = join(personalityDir, 'config.yaml');
  if (!existsSync(configPath)) return '1.0.0';

  const content = readFileSync(configPath, 'utf8');
  for (const line of content.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key === 'version') {
      return line.slice(colonIdx + 1).trim() || '1.0.0';
    }
  }
  return '1.0.0';
}

function buildBundleManifest(
  id: string,
  personalityDir: string,
  dataDir: string,
  entries: Entry[],
  personality: PersonalityConfig,
  withMemory: boolean,
): BundleManifest {
  const toolset = personality.toolset ?? [];
  // Every declared root is disclosed. A single one stays a bare string — the
  // shape every bundle written before multi-root support carries — so an
  // importer reading older and newer bundles sees no gratuitous change.
  const workdirs = declaredWorkdirs(personality);
  const workdir = workdirs.length === 1 ? workdirs[0] : workdirs.length > 1 ? workdirs : undefined;
  const fsReach: BundleManifest['declared']['fsReach'] = {
    read: personality.fs_reach?.read ?? [],
    write: personality.fs_reach?.write ?? [],
    ...(workdir !== undefined ? { workdir } : {}),
  };

  // MCP servers
  const mcpServers: BundleManifest['mcpServers'] = [];
  if (personality.mcp_servers) {
    for (const serverName of personality.mcp_servers) {
      const info = parseMcpServerConfig(personalityDir, serverName, toolset);
      mcpServers.push({
        name: info.name,
        url: info.url,
        transport: info.transport,
        ...(info.authType !== 'none' ? { authType: info.authType } : {}),
        tools: info.tools,
      });
    }
  }

  // Plugins
  const pluginsList: BundleManifest['plugins'] = [];
  if (personality.plugins && personality.plugins.length > 0) {
    const resolved = resolvePlugins(personality.plugins, toolset, dataDir);
    for (const p of resolved) {
      pluginsList.push({
        id: p.id,
        version: p.version,
        source: p.source,
        tools: p.tools,
        skills: p.skills,
        ...(p.credentials.length > 0 ? { credentials: p.credentials } : {}),
      });
    }
  }

  // Memory
  const memoryPath = join(personalityDir, 'MEMORY.md');
  const memorySection =
    withMemory && existsSync(memoryPath) ? { included: ['MEMORY.md'] as 'MEMORY.md'[] } : undefined;

  // Files — compute SHA-256 for each entry, sorted for deterministic hashing
  const files = entries
    .map((e) => ({
      relPath: e.relPath,
      sha256: sha256(e.content),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Bundle SHA-256 — over canonical sorted JSON of files array
  const bundleSha256 = sha256(JSON.stringify(files));

  // Export stamp
  const stamp: ExportStamp = {
    publisher: 'ethos',
    exportedBy: 'ethos-personality-export',
    bundleSha256,
    stamp: createHmac('sha256', ETHOS_EXPORT_KEY).update(bundleSha256).digest('hex'),
  };

  const version = readVersionFromConfig(personalityDir);

  const declared: BundleManifest['declared'] = {
    fsReach,
    toolset,
  };
  if (personality.budgetCapUsd !== undefined) {
    declared.budgetCapUsd = personality.budgetCapUsd;
  }

  const manifest: BundleManifest = {
    schema: 'ethos.personality-bundle/v1',
    personalityId: id,
    version,
    publisher: 'ethos',
    createdAt: new Date().toISOString(),
    declared,
    mcpServers,
    plugins: pluginsList,
    files,
    bundleSha256,
    export: stamp,
  };

  if (memorySection) {
    manifest.memory = memorySection;
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export { runPersonalityImport } from './backup';

export async function runPersonalityExport(argv: string[]): Promise<void> {
  // Parse args: first positional = id, --output <path>, --with-memory
  let id: string | undefined;
  let outputPath: string | undefined;
  let withMemory = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' && argv[i + 1]) {
      outputPath = argv[i + 1];
      i++;
    } else if (arg === '--with-memory') {
      withMemory = true;
    } else if (arg && !arg.startsWith('-') && !id) {
      id = arg;
    }
  }

  if (!id) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const dataDir = ethosDir();
  const personalitiesDir = join(dataDir, 'personalities');

  // Validate personality exists
  const storage = getStorage();
  const reg = await createPersonalityRegistry(storage);
  await reg.loadFromDirectory(personalitiesDir);
  const personality = reg.get(id);

  if (!personality) {
    const known = reg
      .list()
      .map((p) => p.id)
      .sort();
    console.error(`Personality "${id}" not found.`);
    if (known.length > 0) {
      console.error(`Known personalities: ${known.join(', ')}`);
    }
    process.exitCode = 1;
    return;
  }

  const personalityDir = join(personalitiesDir, id);
  if (!existsSync(personalityDir)) {
    console.error(`Personality directory not found: ${personalityDir}`);
    process.exitCode = 1;
    return;
  }

  // Collect files
  const entries = collectPersonalityEntries(personalityDir, id);

  // Include MEMORY.md if --with-memory (never USER.md)
  if (withMemory) {
    const memoryFilePath = join(personalityDir, 'MEMORY.md');
    if (existsSync(memoryFilePath)) {
      const prefix = join('personalities', id);
      entries.push({ relPath: join(prefix, 'MEMORY.md'), content: readFileSync(memoryFilePath) });
    }
  }

  // Generate secrets manifest
  const manifest = buildSecretsManifest(id, personalityDir);
  if (manifest) {
    entries.push({
      relPath: 'secrets.manifest.yaml',
      content: Buffer.from(manifest, 'utf8'),
    });
  }

  // Generate plugins install manifest
  const pluginsManifest = buildPluginsManifest(personalityDir, dataDir);
  if (pluginsManifest) {
    entries.push({
      relPath: 'plugins.manifest.yaml',
      content: Buffer.from(pluginsManifest, 'utf8'),
    });
  }

  if (entries.length === 0) {
    console.log(`Nothing to export for personality "${id}".`);
    return;
  }

  // Build bundle manifest (ETHOS.md)
  const bundleManifest = buildBundleManifest(
    id,
    personalityDir,
    dataDir,
    entries,
    personality,
    withMemory,
  );

  // Add ETHOS.md (JSON) to the archive
  entries.push({
    relPath: 'ETHOS.md',
    content: Buffer.from(JSON.stringify(bundleManifest, null, 2), 'utf8'),
  });

  // Write archive
  const outPath =
    outputPath ?? `ethos-personality-${id}-${timestamp()}-${randomBytes(4).toString('hex')}.tar.gz`;
  await writeTarGz(entries, outPath);
  console.log(`Exported personality "${id}" to: ${outPath} (${entries.length} files)`);
}
