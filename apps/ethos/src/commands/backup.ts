// ethos backup / ethos import — snapshot and restore ~/.ethos/
//
// backup: tar.gz of config.yaml, MEMORY.md, USER.md, cron/jobs.json, personalities/
// import: extract and merge into ~/.ethos/

import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { ethosDir } from '@ethosagent/config';
import { isExactVersion, isValidNpmPackageName, isValidPluginId } from '@ethosagent/plugin-loader';
import { type BundleManifest, EthosError } from '@ethosagent/types';
import { writeJson } from '../json-output';
import { getSecretsResolver } from '../wiring';

const BACKUP_FILES = ['config.yaml', 'MEMORY.md', 'USER.md'];
const BACKUP_EXTRAS = ['cron/jobs.json'];
const MCP_TOKEN_FILENAMES = new Set(['access_token', 'refresh_token', 'expires_at']);

const _USAGE_BACKUP = 'Usage: ethos backup [output-path]';
const USAGE_IMPORT = 'Usage: ethos import <backup-path> [--secrets <manifest-file | ->]';

export async function runBackup(argv: string[]): Promise<void> {
  const jsonMode = argv.includes('--json');
  const filtered = argv.filter((a) => a !== '--json');
  const outPath =
    filtered[0] ?? `ethos-backup-${timestamp()}-${randomBytes(4).toString('hex')}.tar.gz`;
  const dataDir = ethosDir();

  const { entries, strippedTokens } = collectEntries(dataDir);
  if (entries.length === 0) {
    if (jsonMode) {
      writeJson({ ok: true, path: outPath, fileCount: 0 });
      return;
    }
    console.log('Nothing to backup — ~/.ethos/ is empty.');
    return;
  }

  const manifestYaml = buildSecretsManifest(dataDir, strippedTokens);
  entries.push({ relPath: 'secrets.manifest.yaml', content: Buffer.from(manifestYaml) });

  await writeTarGz(entries, outPath);
  if (jsonMode) {
    writeJson({ ok: true, path: outPath, fileCount: entries.length });
    return;
  }
  console.log(`✓ Backup written to: ${outPath} (${entries.length} files)`);
  console.log('');
  console.log('  Note: API keys and MCP tokens were NOT backed up. Re-enter credentials');
  console.log('  via `ethos keys set` or environment variables after restore.');
}

export async function runImport(argv: string[]): Promise<void> {
  const jsonMode = argv.includes('--json');
  const secretsIdx = argv.indexOf('--secrets');
  const secretsPath = secretsIdx >= 0 ? argv[secretsIdx + 1] : undefined;
  if (secretsIdx >= 0 && (!secretsPath || secretsPath.startsWith('--'))) {
    console.error('--secrets requires a manifest file path or "-" for stdin.');
    console.error(USAGE_IMPORT);
    process.exitCode = 1;
    return;
  }
  const filtered = argv.filter(
    (a, i) => a !== '--json' && a !== '--secrets' && !(i > 0 && argv[i - 1] === '--secrets'),
  );
  const srcPath = filtered[0];
  if (!srcPath) {
    console.error(USAGE_IMPORT);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(srcPath)) {
    console.error(`File not found: ${srcPath}`);
    process.exitCode = 1;
    return;
  }

  const dataDir = ethosDir();
  mkdirSync(dataDir, { recursive: true });

  const resolvedBase = resolve(dataDir) + sep;
  const entries = await readTarGz(srcPath);
  for (const [relPath, content] of entries) {
    const dest = join(dataDir, relPath);
    const resolvedDest = resolve(dest);
    if (!resolvedDest.startsWith(resolvedBase)) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Path traversal blocked: "${relPath}" escapes ${dataDir}`,
        action: 'Check the archive contents — it may be corrupted or malicious.',
      });
    }
    mkdirSync(join(dataDir, relPath, '..'), { recursive: true });
    writeFileSync(dest, content);
  }

  if (secretsPath) {
    const count = await injectSecrets(secretsPath);
    if (!jsonMode) console.log(`✓ Injected ${count} secret(s)`);
  }

  if (jsonMode) {
    writeJson({ ok: true, importedFiles: entries.length });
    return;
  }

  // Check for secrets manifest among extracted entries
  const manifestEntry = entries.find(([name]) => name === 'secrets.manifest.yaml');
  if (manifestEntry) {
    const manifestContent = manifestEntry[1].toString('utf8');
    const hints = parseManifestHints(manifestContent);
    console.log(`✓ Imported ${entries.length} files into ~/.ethos/`);
    if (hints.length > 0) {
      console.log('');
      console.log('  Secrets to re-enter:');
      let globalHeaderPrinted = false;
      let lastPersonality = '';
      for (let i = 0; i < hints.length; i++) {
        const hint = hints[i];
        if (!hint) continue;
        const num = i + 1;
        if (hint.type === 'global') {
          if (!globalHeaderPrinted) {
            console.log('     Global:');
            globalHeaderPrinted = true;
          }
          console.log(`       ${num}. ${hint.label.padEnd(24)}→  ${hint.fillWith}`);
        } else {
          if (hint.personality !== lastPersonality) {
            console.log(`     Personality: ${hint.personality}`);
            lastPersonality = hint.personality;
          }
          console.log(`       ${num}. MCP: ${hint.label.padEnd(20)}→  ${hint.fillWith}`);
        }
      }
      console.log('');
      console.log('  Run: ethos doctor  to verify when ready.');
    } else {
      console.log('');
      console.log('  Secrets were not restored. Fill credentials with `ethos keys set`');
      console.log('  or set environment variables, then run `ethos doctor` to verify.');
    }
  } else {
    console.log(`✓ Imported ${entries.length} files into ~/.ethos/`);
    console.log('');
    console.log('  Secrets were not restored. Fill credentials with `ethos keys set`');
    console.log('  or set environment variables, then run `ethos doctor` to verify.');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export interface Entry {
  relPath: string;
  content: Buffer;
}

interface CollectResult {
  entries: Entry[];
  /** Map of personality id → Set of server dirs whose tokens were stripped */
  strippedTokens: Map<string, Set<string>>;
}

function walkDir(
  dir: string,
  relBase: string,
  entries: Entry[],
  personalityId: string,
  strippedTokens: Map<string, Set<string>>,
): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = join(relBase, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walkDir(full, rel, entries, personalityId, strippedTokens);
    } else if (st.isFile()) {
      if (MCP_TOKEN_FILENAMES.has(basename(full))) {
        // Determine the server directory: the parent of this token file
        // relBase is like "personalities/alice/mcp/github" — extract server name
        const relFromPersonality = relBase.slice(`personalities/${personalityId}/`.length);
        const parts = relFromPersonality.split('/');
        // The server name is typically the last segment of the parent path
        const serverName = parts[parts.length - 1] ?? basename(dir);
        let servers = strippedTokens.get(personalityId);
        if (!servers) {
          servers = new Set();
          strippedTokens.set(personalityId, servers);
        }
        servers.add(serverName);
        continue;
      }
      entries.push({ relPath: rel, content: readFileSync(full) });
    }
  }
}

function collectEntries(dataDir: string): CollectResult {
  const entries: Entry[] = [];
  const strippedTokens = new Map<string, Set<string>>();

  for (const file of BACKUP_FILES) {
    const p = join(dataDir, file);
    if (existsSync(p)) entries.push({ relPath: file, content: readFileSync(p) });
  }

  for (const file of BACKUP_EXTRAS) {
    const p = join(dataDir, file);
    if (existsSync(p)) entries.push({ relPath: file, content: readFileSync(p) });
  }

  const personalitiesDir = join(dataDir, 'personalities');
  if (existsSync(personalitiesDir)) {
    for (const id of readdirSync(personalitiesDir)) {
      const pDir = join(personalitiesDir, id);
      const pSt = lstatSync(pDir);
      if (pSt.isSymbolicLink() || !pSt.isDirectory()) continue;
      walkDir(pDir, join('personalities', id), entries, id, strippedTokens);
    }
  }

  return { entries, strippedTokens };
}

function buildSecretsManifest(dataDir: string, strippedTokens: Map<string, Set<string>>): string {
  const lines: string[] = [
    '# Generated by ethos backup — re-enter these secrets after restoring',
    `backed_up_at: ${new Date().toISOString()}`,
  ];

  // Read keys.json to capture key names (not values)
  const keysPath = join(dataDir, 'keys.json');
  let keyNames: string[] = [];
  if (existsSync(keysPath)) {
    try {
      const raw = readFileSync(keysPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        keyNames = Object.keys(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed keys.json
    }
  }

  if (keyNames.length > 0) {
    lines.push('');
    lines.push('global:');
    for (const key of keyNames) {
      lines.push(`  - key: ${key}`);
      lines.push(`    fill_with: ethos keys set ${key} <value>`);
    }
  }

  if (strippedTokens.size > 0) {
    lines.push('');
    lines.push('personalities:');
    const sortedIds = [...strippedTokens.keys()].sort();
    for (const pid of sortedIds) {
      const servers = strippedTokens.get(pid);
      if (!servers || servers.size === 0) continue;
      lines.push(`  ${pid}:`);
      lines.push('    mcp_auth:');
      const sortedServers = [...servers].sort();
      for (const server of sortedServers) {
        lines.push(`      - server: ${server}`);
        lines.push(`        fill_with: ethos mcp auth ${server}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

// Minimal tar format (POSIX ustar) — no external deps
export function buildTar(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.relPath.slice(0, 100).padEnd(100, '\0'));
    const header = Buffer.alloc(512, 0);
    nameBytes.copy(header, 0);
    Buffer.from('0000644\0').copy(header, 100); // mode
    Buffer.from('0000000\0').copy(header, 108); // uid
    Buffer.from('0000000\0').copy(header, 116); // gid
    const sizeOctal = entry.content.length.toString(8).padStart(11, '0');
    Buffer.from(`${sizeOctal}\0`).copy(header, 124); // size
    Buffer.from(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, '0')}\0`,
    ).copy(header, 136); // mtime
    header[156] = 0x30; // type '0' = regular file
    Buffer.from('ustar\0').copy(header, 257);
    Buffer.from('00').copy(header, 263);

    // POSIX: checksum field (148–155) is treated as 8 ASCII spaces during calculation
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i] ?? 0;
    Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);

    blocks.push(header);

    const dataBlocks = Math.ceil(entry.content.length / 512);
    const padded = Buffer.alloc(dataBlocks * 512, 0);
    entry.content.copy(padded);
    blocks.push(padded);
  }

  // Two 512-byte zero blocks to mark end of archive
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export async function writeTarGz(entries: Entry[], outPath: string): Promise<void> {
  const tar = buildTar(entries);
  const gzip = createGzip();
  const out = createWriteStream(outPath);
  const { Readable } = await import('node:stream');
  const src = Readable.from([tar]);
  gzip.pipe(out);
  src.pipe(gzip);
  await new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.on('error', reject);
  });
}

async function readTarGz(srcPath: string): Promise<Array<[string, Buffer]>> {
  const { Writable } = await import('node:stream');
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  const src = createReadStream(srcPath);
  const gunzip = createGunzip();
  await pipeline(src, gunzip, sink);
  const raw = Buffer.concat(chunks);
  return parseTar(raw);
}

export function parseTar(buf: Buffer): Array<[string, Buffer]> {
  const results: Array<[string, Buffer]> = [];
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.slice(offset, offset + 512);
    const name = header.slice(0, 100).toString('utf8').replace(/\0.*/, '');
    if (!name) break;

    // Reject path traversal and absolute paths at parse time
    if (name.includes('..') || name.startsWith('/')) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Malicious tar entry rejected: "${name}"`,
        action: 'Check the archive contents — it may be corrupted or malicious.',
      });
    }

    // Only allow regular files (type '0' or null byte)
    const typeFlag = header[156];
    if (typeFlag !== 0x30 && typeFlag !== 0x00) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Unsupported tar entry type ${typeFlag} for "${name}"`,
        action: 'Check the archive contents — it may be corrupted or malicious.',
      });
    }

    const sizeStr = header.slice(124, 135).toString('utf8').trim().replace(/\0.*/, '');
    const size = Number.parseInt(sizeStr, 8);
    offset += 512;

    const content = buf.slice(offset, offset + size);
    results.push([name, content]);

    offset += Math.ceil(size / 512) * 512;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Secrets manifest hint parser (backup manifest → import display)
// ---------------------------------------------------------------------------

interface ManifestHintGlobal {
  type: 'global';
  label: string;
  fillWith: string;
}

interface ManifestHintMcp {
  type: 'mcp';
  personality: string;
  label: string;
  fillWith: string;
}

type ManifestHint = ManifestHintGlobal | ManifestHintMcp;

function parseManifestHints(raw: string): ManifestHint[] {
  const hints: ManifestHint[] = [];
  let section: 'none' | 'global' | 'personalities' = 'none';
  let currentPersonality = '';
  let inMcpAuth = false;
  let pendingServer = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('backed_up_at:')) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0 && trimmed === 'global:') {
      section = 'global';
      inMcpAuth = false;
      continue;
    }
    if (indent === 0 && trimmed === 'personalities:') {
      section = 'personalities';
      inMcpAuth = false;
      continue;
    }

    if (section === 'global') {
      const keyMatch = trimmed.match(/^-\s*key:\s*(.+)$/);
      if (keyMatch) {
        pendingServer = keyMatch[1] ?? '';
        continue;
      }
      const fillMatch = trimmed.match(/^fill_with:\s*(.+)$/);
      if (fillMatch && pendingServer) {
        hints.push({ type: 'global', label: pendingServer, fillWith: fillMatch[1] ?? '' });
        pendingServer = '';
        continue;
      }
    }

    if (section === 'personalities') {
      // Personality id line: "  alice:" (indent 2)
      if (indent === 2 && trimmed.endsWith(':')) {
        currentPersonality = trimmed.slice(0, -1);
        inMcpAuth = false;
        continue;
      }
      // mcp_auth: line
      if (indent === 4 && trimmed === 'mcp_auth:') {
        inMcpAuth = true;
        continue;
      }
      if (inMcpAuth && currentPersonality) {
        const serverMatch = trimmed.match(/^-\s*server:\s*(.+)$/);
        if (serverMatch) {
          pendingServer = serverMatch[1] ?? '';
          continue;
        }
        const fillMatch = trimmed.match(/^fill_with:\s*(.+)$/);
        if (fillMatch && pendingServer) {
          hints.push({
            type: 'mcp',
            personality: currentPersonality,
            label: pendingServer,
            fillWith: fillMatch[1] ?? '',
          });
          pendingServer = '';
        }
      }
    }
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Secrets manifest — simple line-based format (not YAML)
//
// Format:
//   global:
//     KEY: value
//   personalities:
//     <id>:
//       KEY: value
//
// Values are trimmed. Matching quotes (single or double) are stripped.
// Lines starting with # are comments. Blank lines are ignored.
// ---------------------------------------------------------------------------

const VALID_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

interface ParsedSecrets {
  global: Map<string, string>;
  personalities: Map<string, Map<string, string>>;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseSecretsManifest(raw: string): ParsedSecrets {
  const global = new Map<string, string>();
  const personalities = new Map<string, Map<string, string>>();

  let section: 'none' | 'global' | 'personalities' = 'none';
  let currentPersonality: string | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0 && trimmed.endsWith(':')) {
      const header = trimmed.slice(0, -1);
      if (header === 'global') {
        section = 'global';
        currentPersonality = undefined;
      } else if (header === 'personalities') {
        section = 'personalities';
        currentPersonality = undefined;
      }
      continue;
    }

    if (section === 'personalities' && indent === 2 && trimmed.endsWith(':')) {
      currentPersonality = trimmed.slice(0, -1);
      if (!personalities.has(currentPersonality)) {
        personalities.set(currentPersonality, new Map());
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = stripQuotes(trimmed.slice(colonIdx + 1).trim());

    if (section === 'global' && indent >= 2) {
      global.set(key, value);
    } else if (section === 'personalities' && indent >= 4 && currentPersonality) {
      const pMap = personalities.get(currentPersonality);
      if (pMap) pMap.set(key, value);
    }
  }

  return { global, personalities };
}

async function injectSecrets(secretsPath: string): Promise<number> {
  let raw: string;
  if (secretsPath === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    if (!existsSync(secretsPath)) {
      throw new EthosError({
        code: 'FILE_NOT_FOUND',
        cause: `Secrets manifest not found: ${secretsPath}`,
        action: 'Provide a valid path to a secrets manifest file.',
      });
    }
    raw = readFileSync(secretsPath, 'utf8');
  }

  const parsed = parseSecretsManifest(raw);
  const secrets = await getSecretsResolver();
  let count = 0;

  for (const [key, value] of parsed.global) {
    await secrets.set(key, value);
    count++;
  }

  if (parsed.personalities.size > 0) {
    const { PersonalityScopedSecrets } = await import('@ethosagent/storage-fs');
    for (const [pid, kvs] of parsed.personalities) {
      const scoped = new PersonalityScopedSecrets(secrets, pid);
      for (const [key, value] of kvs) {
        await scoped.set(key, value);
        count++;
      }
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Helpers for manifest-aware personality import
// ---------------------------------------------------------------------------

function semverGte(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return true;
}

function updateConfigLine(configPath: string, key: string, newValues: string[]): void {
  if (newValues.length === 0) return;
  let lines: string[] = [];
  if (existsSync(configPath)) {
    lines = readFileSync(configPath, 'utf8').split('\n');
  }
  const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (idx >= 0) {
    const existing = lines[idx]?.split(':').slice(1).join(':').trim() ?? '';
    const existingNames = existing ? existing.split(/\s+/) : [];
    const toAdd = newValues.filter((n) => !existingNames.includes(n));
    if (toAdd.length > 0) {
      lines[idx] = `${key}: ${[...existingNames, ...toAdd].join(' ')}`;
    }
  } else {
    lines.push(`${key}: ${newValues.join(' ')}`);
  }
  writeFileSync(configPath, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Personality import (G5+G6) — ethos personality import <file> [--force] [--secrets <manifest>]
// ---------------------------------------------------------------------------

const USAGE_PERSONALITY_IMPORT =
  'Usage: ethos personality import <file-or-dir> [--force] [--secrets <manifest>] [--no-memory]';

function isValidManifest(m: unknown): m is BundleManifest {
  if (!m || typeof m !== 'object') return false;
  const obj = m as Record<string, unknown>;
  if (obj.schema !== 'ethos.personality-bundle/v1') return false;
  if (typeof obj.personalityId !== 'string') return false;
  if (typeof obj.version !== 'string') return false;
  if (typeof obj.bundleSha256 !== 'string') return false;
  if (!obj.declared || typeof obj.declared !== 'object') return false;
  const declared = obj.declared as Record<string, unknown>;
  if (!declared.fsReach || typeof declared.fsReach !== 'object') return false;
  if (!Array.isArray(declared.toolset)) return false;
  if (!Array.isArray(obj.mcpServers)) return false;
  if (!Array.isArray(obj.plugins)) return false;
  if (!Array.isArray(obj.files)) return false;
  return true;
}

export async function runPersonalityImport(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const noMemory = argv.includes('--no-memory');
  const secretsIdx = argv.indexOf('--secrets');
  const secretsPath = secretsIdx >= 0 ? argv[secretsIdx + 1] : undefined;

  if (secretsIdx >= 0 && (!secretsPath || secretsPath.startsWith('--'))) {
    console.error('--secrets requires a manifest file path or "-" for stdin.');
    console.error(USAGE_PERSONALITY_IMPORT);
    process.exitCode = 1;
    return;
  }

  const positional = argv.filter(
    (a, i) =>
      a !== '--force' &&
      a !== '--no-memory' &&
      a !== '--secrets' &&
      !(i > 0 && argv[i - 1] === '--secrets'),
  );

  const srcPath = positional[0];
  if (!srcPath) {
    console.error(USAGE_PERSONALITY_IMPORT);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(srcPath)) {
    console.error(`File not found: ${srcPath}`);
    process.exitCode = 1;
    return;
  }

  let entries: Array<[string, Buffer]>;
  const srcStat = statSync(srcPath);
  if (srcStat.isDirectory()) {
    const dirName = basename(srcPath);
    entries = [];
    for (const f of readdirSync(srcPath)) {
      const fp = join(srcPath, f);
      if (statSync(fp).isFile()) {
        entries.push([`personalities/${dirName}/${f}`, readFileSync(fp)]);
      }
    }
  } else {
    entries = await readTarGz(srcPath);
  }

  if (entries.length === 0) {
    console.error('Archive is empty — nothing to import.');
    process.exitCode = 1;
    return;
  }

  // Check for ETHOS.md manifest (manifest-aware vs legacy)
  const ethosEntry = entries.find(([name]) => name === 'ETHOS.md');

  if (ethosEntry) {
    // -----------------------------------------------------------------------
    // Manifest-aware import path
    // -----------------------------------------------------------------------
    let manifest: BundleManifest;
    try {
      manifest = JSON.parse(ethosEntry[1].toString('utf8')) as BundleManifest;
    } catch {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: 'ETHOS.md is not valid JSON — cannot parse bundle manifest.',
        action: 'Ensure the archive contains a valid ETHOS.md bundle manifest.',
      });
    }

    if (!isValidManifest(manifest)) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: 'ETHOS.md does not match expected BundleManifest shape.',
        action: 'Ensure the archive contains a valid ETHOS.md bundle manifest.',
      });
    }

    const personalityId = manifest.personalityId;

    // Validate personality ID
    if (!VALID_ID_RE.test(personalityId)) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Invalid personality ID "${personalityId}" — must be alphanumeric with hyphens/underscores.`,
        action: 'Ensure the bundle manifest uses a valid personality ID.',
      });
    }

    // Verify bundle integrity
    const computedHash = createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
    if (computedHash !== manifest.bundleSha256) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: 'Bundle integrity check failed — file hashes do not match bundleSha256.',
        action: 'The archive may have been tampered with. Re-export from the source.',
      });
    }

    // Verify individual file contents against manifest hashes
    for (const fileEntry of manifest.files) {
      const archiveEntry = entries.find(([p]) => p === fileEntry.relPath);
      if (!archiveEntry) {
        throw new EthosError({
          code: 'IMPORT_BLOCKED',
          cause: `Manifest declares file "${fileEntry.relPath}" but it is missing from the archive.`,
          action: 'The archive may be corrupted. Re-export the personality.',
        });
      }
      const actualHash = createHash('sha256').update(archiveEntry[1]).digest('hex');
      if (actualHash !== fileEntry.sha256) {
        throw new EthosError({
          code: 'IMPORT_BLOCKED',
          cause: `File "${fileEntry.relPath}" content does not match manifest hash.`,
          action: 'The archive may be corrupted or tampered with. Re-export the personality.',
        });
      }
    }

    // Verify export stamp (flag only, do not block)
    const expectedStamp = createHmac('sha256', 'ethos-personality-export-v1')
      .update(manifest.bundleSha256)
      .digest('hex');
    const unstamped = !manifest.export.stamp || manifest.export.stamp !== expectedStamp;

    // Check for existing personality
    const dataDir = ethosDir();
    const existingDir = join(dataDir, 'personalities', personalityId);
    if (existsSync(existingDir) && !force && process.env.ETHOS_MANAGED !== '1') {
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const overwrite = await new Promise<boolean>((res) => {
        rl.question(
          `Personality "${personalityId}" already exists. Overwrite? [y/N] `,
          (answer) => {
            rl.close();
            res(answer.toLowerCase() === 'y');
          },
        );
      });
      if (!overwrite) {
        console.log('Cancelled.');
        return;
      }
    }

    // Trust prompt (unless --force or ETHOS_MANAGED=1)
    if (!force && process.env.ETHOS_MANAGED !== '1') {
      console.log('');
      console.log('  Personality import summary:');
      console.log(`    ID:          ${personalityId}`);
      console.log(`    Version:     ${manifest.version}`);
      console.log(
        `    fs_reach:    read ${manifest.declared.fsReach.read.length} path(s), write ${manifest.declared.fsReach.write.length} path(s)`,
      );
      // A declared workdir is read AND write reachable, so it belongs in the
      // reach the operator is being asked to trust — the counts above do not
      // include it.
      if (manifest.declared.fsReach.workdir) {
        console.log(`    Workdir:     ${manifest.declared.fsReach.workdir} (read + write)`);
      }
      console.log(`    Toolset:     ${manifest.declared.toolset.length} tool(s)`);
      if (manifest.mcpServers.length > 0) {
        const mcpNames = manifest.mcpServers.map((s) => s.name).join(', ');
        console.log(`    MCP servers: ${mcpNames}`);
      }
      if (manifest.plugins.length > 0) {
        const pluginNames = manifest.plugins.map((p) => p.id).join(', ');
        console.log(`    Plugins:     ${pluginNames}`);
      }
      if (manifest.memory) {
        console.log(`    Memory:      ${manifest.memory.included.join(', ')}`);
      } else {
        console.log('    Memory:      none');
      }
      if (unstamped) {
        console.log('    WARNING:     Bundle is NOT stamped by an official ethos export.');
      }
      console.log('');

      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const proceed = await new Promise<boolean>((res) => {
        rl.question('  Continue? [y/N] ', (answer) => {
          rl.close();
          res(answer.toLowerCase() === 'y');
        });
      });
      if (!proceed) {
        console.log('Cancelled.');
        return;
      }
    }

    // Write personality files
    const personalityBase = resolve(join(dataDir, 'personalities', personalityId)) + sep;
    // Build verified file allowlist from manifest
    const verifiedFiles = new Map<string, string>();
    for (const f of manifest.files) {
      verifiedFiles.set(f.relPath, f.sha256);
    }

    // Check for duplicate archive entries
    const seenPaths = new Set<string>();
    for (const [relPath] of entries) {
      if (seenPaths.has(relPath)) {
        throw new EthosError({
          code: 'IMPORT_BLOCKED',
          cause: `Duplicate archive entry "${relPath}" — possible tampering.`,
          action: 'Re-export the personality from the source.',
        });
      }
      seenPaths.add(relPath);
    }

    const skipFiles = new Set(['ETHOS.md', 'secrets.manifest.yaml', 'plugins.manifest.yaml']);
    let writtenCount = 0;
    let skippedCount = 0;

    for (const [relPath, content] of entries) {
      const fileName = relPath.split('/').pop() ?? '';

      // Skip special files
      if (skipFiles.has(relPath) || skipFiles.has(fileName)) continue;
      // Never write USER.md
      if (fileName === 'USER.md') continue;
      // Skip MEMORY.md if --no-memory
      if (fileName === 'MEMORY.md' && noMemory) continue;

      // Only write files that are in the manifest and verified
      if (!verifiedFiles.has(relPath)) {
        skippedCount++;
        continue;
      }

      const dest = join(dataDir, relPath);
      const resolvedDest = resolve(dest);
      if (!resolvedDest.startsWith(personalityBase)) {
        skippedCount++;
        continue;
      }
      mkdirSync(join(resolvedDest, '..'), { recursive: true });
      writeFileSync(dest, content);
      writtenCount++;
    }

    if (skippedCount > 0) {
      console.warn(
        `  Warning: ${skippedCount} archive entry/entries outside personalities/${personalityId}/ were skipped.`,
      );
    }

    // MCP server handling
    const mcpJsonPath = join(homedir(), '.ethos', 'mcp.json');
    const configYamlPath = join(dataDir, 'personalities', personalityId, 'config.yaml');
    const mcpToEnable: string[] = [];
    const credentialWarnings: string[] = [];

    if (manifest.mcpServers.length > 0) {
      let mcpArr: Array<Record<string, unknown>> = [];
      if (existsSync(mcpJsonPath)) {
        try {
          const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
          if (!Array.isArray(parsed)) {
            throw new EthosError({
              code: 'IMPORT_BLOCKED',
              cause:
                'Global MCP config (~/.ethos/mcp.json) is malformed — cannot safely modify it.',
              action: 'Fix or remove ~/.ethos/mcp.json before importing.',
            });
          }
          mcpArr = parsed as Array<Record<string, unknown>>;
        } catch (err) {
          if (err instanceof EthosError) throw err;
          throw new EthosError({
            code: 'IMPORT_BLOCKED',
            cause: 'Global MCP config (~/.ethos/mcp.json) is malformed — cannot safely modify it.',
            action: 'Fix or remove ~/.ethos/mcp.json before importing.',
          });
        }
      }

      for (const server of manifest.mcpServers) {
        const existingServer = mcpArr.find(
          (s) =>
            typeof s === 'object' &&
            s !== null &&
            (s as Record<string, unknown>).name === server.name,
        );
        if (existingServer) {
          // Clash — reuse existing, skip global install
          console.log(`  MCP "${server.name}": already installed, using existing.`);
        } else {
          // New server — append to mcp.json
          mcpArr.push({
            name: server.name,
            url: server.url,
            transport: server.transport,
          });
          console.log(`  MCP "${server.name}": added to mcp.json.`);
        }
        mcpToEnable.push(server.name);

        // Flag credential-requiring servers
        if (server.authType === 'bearer' || server.authType === 'oauth2') {
          credentialWarnings.push(`MCP "${server.name}" requires ${server.authType} credentials.`);
        }
      }

      mkdirSync(join(homedir(), '.ethos'), { recursive: true });
      writeFileSync(mcpJsonPath, JSON.stringify(mcpArr, null, 2));

      // Enable MCP servers at personality level
      updateConfigLine(configYamlPath, 'mcp_servers', mcpToEnable);
    }

    // Plugin handling.
    //
    // `manifest.plugins` comes out of the bundle, which is a shared artefact —
    // the same attacker-controlled input as `plugins.lock`. The three fields
    // used below are validated with the SAME predicates the lockfile path uses
    // (`@ethosagent/plugin-loader`), so the two install surfaces cannot drift
    // apart. The rule they replace, `/^[@a-zA-Z0-9._/-]+$/`, did reject
    // `--registry=http://evil` (no `=` or `:` in the class) but admitted every
    // local path spec and every bare option-shaped token: `../../evil`, `./x`,
    // `..`, `-g`, `--registry`, `--foo` all passed it and would have been
    // handed to npm as the package to install.
    const pluginsToAttach: string[] = [];

    if (manifest.plugins.length > 0) {
      const pluginsDir = join(homedir(), '.ethos', 'plugins');
      mkdirSync(pluginsDir, { recursive: true });
      const nodeModulesDir = join(pluginsDir, 'node_modules');

      for (const plugin of manifest.plugins) {
        // The id becomes a path segment (`node_modules/<id>`) and a token in
        // config.yaml's space-separated `plugins:` list. Check it before either.
        if (!isValidPluginId(plugin.id)) {
          console.warn(`  ⚠ Plugin id "${plugin.id}" is not a plain identifier — skipping.`);
          continue;
        }
        pluginsToAttach.push(plugin.id);

        // Validate plugin source/version before any install attempt. `version`
        // is held to exact semver for the same reason the lockfile is: the
        // bundle records what the exporter HAD, so a range, a dist-tag, or a
        // `file:`/`git+ssh:` spec here is not a weaker pin, it is a different
        // package from a different place. A bundle exported on a machine where
        // the plugin was not installed carries `version: "unknown"`; that now
        // warns here instead of failing inside npm.
        if (!isValidNpmPackageName(plugin.source) || !isExactVersion(plugin.version)) {
          console.warn(
            `  ⚠ Plugin "${plugin.id}" has an unusable source/version (${plugin.source}@${plugin.version}) — skipping install.`,
          );
          continue;
        }

        const pluginDir = join(nodeModulesDir, plugin.id);
        const isInstalled = existsSync(pluginDir);

        if (!isInstalled) {
          // Always prompt before installing plugins (even with --force)
          if (process.env.ETHOS_MANAGED !== '1') {
            const readline = await import('node:readline');
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise<string>((res) => {
              rl.question(
                `Install plugin "${plugin.id}" (${plugin.source}@${plugin.version})? [Y/n] `,
                (a) => {
                  rl.close();
                  res(a);
                },
              );
            });
            if (answer.toLowerCase() === 'n') {
              console.log(`  Skipped plugin "${plugin.id}".`);
              continue;
            }
          }
          // Not installed — install it
          try {
            execFileSync(
              'npm',
              [
                'install',
                '--prefix',
                pluginsDir,
                '--ignore-scripts',
                '--no-audit',
                `${plugin.source}@${plugin.version}`,
              ],
              { stdio: 'pipe', timeout: 60000 },
            );
            console.log(`  Plugin "${plugin.id}": installed ${plugin.version}.`);
          } catch {
            console.warn(`  Plugin "${plugin.id}": install failed — install manually.`);
          }
        } else {
          // Installed — check version
          let installedVersion = '0.0.0';
          const pkgJsonPath = join(pluginDir, 'package.json');
          if (existsSync(pkgJsonPath)) {
            try {
              const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<
                string,
                unknown
              >;
              if (typeof pkgJson.version === 'string') {
                installedVersion = pkgJson.version;
              }
            } catch {
              // ignore parse errors
            }
          }

          if (semverGte(installedVersion, plugin.version)) {
            console.log(
              `  Plugin "${plugin.id}": installed ${installedVersion} >= bundle ${plugin.version}, reusing.`,
            );
          } else {
            // Installed but older — prompt unless force
            if (force) {
              try {
                execFileSync(
                  'npm',
                  [
                    'install',
                    '--prefix',
                    pluginsDir,
                    '--ignore-scripts',
                    '--no-audit',
                    `${plugin.source}@${plugin.version}`,
                  ],
                  { stdio: 'pipe', timeout: 60000 },
                );
                console.log(
                  `  Plugin "${plugin.id}": updated ${installedVersion} → ${plugin.version}.`,
                );
              } catch {
                console.warn(`  Plugin "${plugin.id}": update failed — update manually.`);
              }
            } else {
              console.log(
                `  Plugin "${plugin.id}": installed ${installedVersion} < bundle ${plugin.version}. Keeping existing.`,
              );
            }
          }
        }

        // Flag credential-declaring plugins
        const creds = plugin.credentials;
        if (creds && creds.length > 0) {
          credentialWarnings.push(
            `Plugin "${plugin.id}" declares credentials: ${creds.join(', ')}.`,
          );
        }
      }

      // Attach plugins at personality level
      updateConfigLine(configYamlPath, 'plugins', pluginsToAttach);
    }

    // Handle --secrets
    if (secretsPath) {
      const count = await injectSecrets(secretsPath);
      console.log(`  Injected ${count} secret(s).`);
    }

    // Final summary
    console.log(`✓ Personality "${personalityId}" imported (${writtenCount} file(s) written).`);
    if (credentialWarnings.length > 0) {
      console.log('');
      console.log('  Credentials needed:');
      for (const warn of credentialWarnings) {
        console.log(`    - ${warn}`);
      }
    }
    console.log(`  Run: ethos personality doctor ${personalityId}  to verify.`);
  } else {
    // -----------------------------------------------------------------------
    // Legacy fallback — no ETHOS.md manifest
    // -----------------------------------------------------------------------
    const first = entries[0];
    if (!first) {
      console.error('Archive is empty — nothing to import.');
      process.exitCode = 1;
      return;
    }
    const segments = first[0].split('/');
    const personalitiesIdx = segments.indexOf('personalities');
    if (personalitiesIdx < 0 || !segments[personalitiesIdx + 1]) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: 'Cannot determine personality ID — expected paths under personalities/<id>/',
        action: 'Ensure the archive contains files under a personalities/<id>/ directory.',
      });
    }
    const personalityId = segments[personalitiesIdx + 1];

    // Validate personality ID — reject traversal characters
    if (!VALID_ID_RE.test(personalityId)) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Invalid personality ID "${personalityId}" — must be alphanumeric with hyphens/underscores.`,
        action: 'Ensure the archive paths use a valid personality ID.',
      });
    }

    const { createPersonalityRegistry } = await import('@ethosagent/personalities');
    const dataDir = ethosDir();
    const storage = new (await import('@ethosagent/storage-fs')).FsStorage();
    const reg = await createPersonalityRegistry(storage);
    await reg.loadFromDirectory(join(dataDir, 'personalities'));
    const existing = reg.get(personalityId);

    if (existing && !force && process.env.ETHOS_MANAGED !== '1') {
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const overwrite = await new Promise<boolean>((res) => {
        rl.question(
          `Personality "${personalityId}" already exists. Overwrite? [y/N] `,
          (answer) => {
            rl.close();
            res(answer.toLowerCase() === 'y');
          },
        );
      });
      if (!overwrite) {
        console.log('Cancelled.');
        return;
      }
    }

    // Write files — restrict to personalities/<id>/ only
    const personalityBase = resolve(join(dataDir, 'personalities', personalityId)) + sep;
    let skippedCount = 0;
    for (const [relPath, content] of entries) {
      // Skip top-level manifest files and USER.md
      if (relPath === 'secrets.manifest.yaml') continue;
      if (relPath.endsWith('/USER.md') || relPath === 'USER.md') continue;
      // Skip MEMORY.md when --no-memory
      if (noMemory && (relPath.endsWith('/MEMORY.md') || relPath === 'MEMORY.md')) continue;

      const dest = join(dataDir, relPath);
      const resolvedDest = resolve(dest);
      if (!resolvedDest.startsWith(personalityBase)) {
        skippedCount++;
        continue;
      }
      mkdirSync(join(dataDir, relPath, '..'), { recursive: true });
      writeFileSync(dest, content);
    }

    if (skippedCount > 0) {
      console.warn(
        `  Warning: ${skippedCount} archive entry/entries outside personalities/${personalityId}/ were skipped.`,
      );
    }

    if (secretsPath) {
      const count = await injectSecrets(secretsPath);
      console.log(`✓ Injected ${count} secret(s)`);
    }

    // Display secrets manifest from the archive (if present)
    const manifestEntry = entries.find(([name]) => name === 'secrets.manifest.yaml');
    if (manifestEntry) {
      const manifestContent = manifestEntry[1].toString('utf8');
      const hints = parseManifestHints(manifestContent);
      console.log(`✓ Personality "${personalityId}" imported.`);
      if (hints.length > 0) {
        console.log('');
        console.log(`  ${hints.length} secret(s) required before use:`);
        for (let i = 0; i < hints.length; i++) {
          const hint = hints[i];
          if (!hint) continue;
          const num = i + 1;
          if (hint.type === 'global') {
            console.log(`     ${num}. ${hint.label.padEnd(24)}→  ${hint.fillWith}`);
          } else {
            console.log(`     ${num}. MCP: ${hint.label.padEnd(20)}→  ${hint.fillWith}`);
          }
        }
        console.log('');
        console.log(`  Run: ethos personality doctor ${personalityId}  to verify when ready.`);
      }
    } else {
      console.log(`✓ Personality "${personalityId}" imported.`);
      console.log(`  Run: ethos personality doctor ${personalityId}  to verify.`);
    }
  }
}
