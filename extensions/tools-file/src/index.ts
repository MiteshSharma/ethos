import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { sensitiveDenyPaths } from '@ethosagent/storage-fs';
import type { ScopedFs, Tool, ToolContext, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Ethos operational-state files the write tools must never clobber. Distinct
// from the credential/system floor below: these are app state, not secrets —
// write-blocked here but still readable.
const BLOCKED_WRITE_PATHS = [
  join(homedir(), '.ethos', 'config.yaml'),
  join(homedir(), '.ethos', 'web-token'),
  join(homedir(), '.ethos', 'pairing.db'),
];
const BLOCKED_WRITE_PREFIXES = [
  join(homedir(), '.ethos', 'sessions'),
  // Credential/system deny floor — single source of truth shared with
  // ScopedStorage (defaultAlwaysDeny) and the terminal/process argv floors.
  // Covers ~/.ethos/keys.json and ~/.ethos/secrets among others.
  ...sensitiveDenyPaths(),
];

function expandPath(p: string, cwd: string): string {
  // Expand ~/ first, then resolve unconditionally so `..` and `.`
  // segments are normalized. Without `resolve()`, an absolute path like
  // `/tmp/foo/./../etc/passwd` would skip past the working-dir
  // allowlist via lexical-but-unnormalized prefix matching.
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * Normalize a read-target path. ScopedFsImpl.checkReach() applies
 * normalize(resolve(path)) internally before boundary checks, so we
 * no longer need the old realpath()-based symlink canonicalization here.
 * expandPath already resolves `~` and relative segments; this wrapper
 * exists so the call-site semantics stay explicit.
 */
function canonicalizeForRead(path: string): string {
  return resolve(path);
}

/**
 * Ground-truth evidence for a verified write (plan `ground-truth-verification`
 * R6). Computed over the bytes the tool itself read back — never a second read
 * of the file, which would be a fresh claim rather than evidence about the
 * write that just happened.
 *
 * `bytes` is the UTF-8 byte length, not `String.length`: the latter counts
 * UTF-16 code units, so "\u{1F600}" reported 2 where the file holds 4.
 */
function writeEvidence(
  abs: string,
  verified: string,
): { path: string; bytes: number; sha256: string } {
  const buf = Buffer.from(verified, 'utf8');
  return {
    path: abs,
    bytes: buf.byteLength,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

export function isWriteBlocked(abs: string): boolean {
  const normalized = resolve(abs);
  if (BLOCKED_WRITE_PATHS.some((p) => resolve(p) === normalized)) return true;
  return BLOCKED_WRITE_PREFIXES.some((prefix) => {
    const np = resolve(prefix);
    return normalized === np || normalized.startsWith(`${np}/`);
  });
}

/**
 * FW-28 — check whether the file at `abs` has been modified externally since
 * the agent last read it. Returns a STALE_WRITE ToolResult when stale, or
 * null when the write is safe to proceed.
 *
 * Skipped (returns null) when:
 * - `readMtimes` is absent (backward-compat: old callers without the map)
 * - the path was never read in this session (new-file creation, no false positive)
 *
 * Uses ScopedFs.mtime() so the check is reach-validated by the same
 * capability surface as the surrounding read/write, rather than bypassing
 * it with raw stat(). A file that was previously read but has since been
 * deleted is treated as stale to prevent silent clobber of a disappearance.
 */
async function checkStaleWrite(
  abs: string,
  readMtimes: Map<string, { mtimeMs: number; readAtTurn: number }> | undefined,
  fs: ScopedFs,
): Promise<ToolResult | null> {
  if (!readMtimes) return null;
  const record = readMtimes.get(abs);
  if (!record) return null;

  const currentMtimeMs = await fs.mtime(abs);

  if (currentMtimeMs === null) {
    const readAt = new Date(record.mtimeMs).toISOString();
    return {
      ok: false,
      error: `STALE_WRITE: ${abs} was read at ${readAt} but no longer exists on disk. Re-read the file before writing.`,
      code: 'STALE_WRITE',
      conflictKey: abs,
    };
  }

  if (currentMtimeMs !== record.mtimeMs) {
    const readAt = new Date(record.mtimeMs).toISOString();
    const modAt = new Date(currentMtimeMs).toISOString();
    return {
      ok: false,
      error: `STALE_WRITE: ${abs} was read at ${readAt} but modified externally at ${modAt}. Re-read the file before writing.`,
      code: 'STALE_WRITE',
      conflictKey: abs,
    };
  }

  return null;
}

/**
 * Resolve the ScopedFs to use for this call, or return a `not_available`
 * tool result when the capability backend isn't configured. AgentLoop
 * wires `ctx.scopedFs` from the tool's declared `fs_reach` capability
 * intersected with the personality's `fs_reach`; tests that construct a
 * ToolContext directly must wire it explicitly.
 */
function fsOf(ctx: ToolContext): ScopedFs | ToolResult {
  if (!ctx.scopedFs) {
    return {
      ok: false,
      error: 'Filesystem capability not configured for this personality.',
      code: 'not_available',
    };
  }
  return ctx.scopedFs;
}

/** Detect the structured PATH_NOT_REACHABLE shape thrown by ScopedFsImpl
 *  so tools can return a deterministic failure instead of an unhandled
 *  exception. Match the prefix; ScopedFs is the only caller throwing it. */
function isReachError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith('PATH_NOT_REACHABLE:');
}

function reachFailure(kind: 'read' | 'write', path: string): ToolResult {
  return {
    ok: false,
    error: `Filesystem boundary: ${kind} of "${path}" is outside this personality's fs_reach allowlist.`,
    code: 'execution_failed',
  };
}

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.env',
  '.md',
  '.txt',
  '.csv',
  '.log',
  '.html',
  '.css',
  '.scss',
  '.svg',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.sql',
  '.graphql',
  '.proto',
  '.gitignore',
  '.prettierrc',
  '.eslintrc',
]);

function isTextFile(p: string): boolean {
  const ext = extname(p).toLowerCase();
  return ext === '' || TEXT_EXTENSIONS.has(ext);
}

function matchGlob(name: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  );
  return regex.test(name);
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a file from the filesystem. Supports line ranges for large files. Paths starting with ~/ are expanded to the home directory.',
  toolset: 'file',
  maxResultChars: 40_000,
  outputIsUntrusted: true,
  capabilities: {
    fs_reach: { read: 'from-personality' },
    attachments: { kinds: ['file', 'image'] },
  },
  schema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description: 'Opaque attachment reference (e.g. att-0) to read an attached file.',
      },
      path: { type: 'string', description: 'File path to read (absolute or relative to cwd)' },
      start_line: { type: 'number', description: 'First line to return (1-indexed, inclusive)' },
      end_line: { type: 'number', description: 'Last line to return (1-indexed, inclusive)' },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { ref, path, start_line, end_line } = args as {
      ref?: string;
      path?: string;
      start_line?: number;
      end_line?: number;
    };

    // Resolve attachment ref → path when present.
    let resolvedPath = path;
    if (ref) {
      if (!ctx.attachments) {
        return {
          ok: false,
          error: 'No attachments available for this turn.',
          code: 'not_available',
        };
      }
      const att = await ctx.attachments.openByRef(ref);
      resolvedPath = att.path;
    }

    if (!resolvedPath) return { ok: false, error: 'path is required', code: 'input_invalid' };

    const expanded = expandPath(resolvedPath, ctx.workingDir);
    const abs = canonicalizeForRead(expanded);
    const fs = fsOf(ctx);
    if (!('mtime' in fs)) return fs;

    // FW-28 — snapshot mtime before reading. Stat again after; if the file
    // changed while we read it the content is ambiguous, so we surface an error
    // rather than silently recording the wrong baseline for the stale-write guard.
    let mtimeBefore: number | null = null;
    if (ctx.readMtimes) {
      try {
        mtimeBefore = await fs.mtime(abs);
      } catch (err) {
        if (isReachError(err)) return reachFailure('read', abs);
        throw err;
      }
    }

    let content: string;
    try {
      content = await fs.read(abs);
    } catch (err) {
      if (isReachError(err)) return reachFailure('read', abs);
      if (err instanceof Error && err.message.startsWith('File not found:')) {
        return { ok: false, error: `Cannot read ${abs}: file not found`, code: 'execution_failed' };
      }
      return {
        ok: false,
        error: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        code: 'execution_failed',
      };
    }

    if (ctx.readMtimes && mtimeBefore !== null) {
      const mtimeAfter = await fs.mtime(abs);
      if (mtimeAfter === null || mtimeAfter !== mtimeBefore) {
        return {
          ok: false,
          error: `${abs} changed during read — re-read the file before writing`,
          code: 'execution_failed',
        };
      }
      ctx.readMtimes.set(abs, { mtimeMs: mtimeBefore, readAtTurn: ctx.currentTurn });
    }

    const lines = content.split('\n');
    const total = lines.length;

    if (start_line !== undefined || end_line !== undefined) {
      const from = Math.max(1, start_line ?? 1) - 1;
      const to = Math.min(total, end_line ?? total);
      const slice = lines.slice(from, to);
      const header = `[${abs}] lines ${from + 1}–${to} of ${total}\n\n`;
      return { ok: true, value: header + slice.join('\n') };
    }

    return {
      ok: true,
      value: `[${abs}] ${total} lines\n\n${content}`,
    };
  },
};

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write content to a file. Creates parent directories if needed. Blocked for ~/.ethos/config.yaml and session storage.',
  toolset: 'file',
  capabilities: {
    fs_reach: { read: 'from-personality', write: 'from-personality' },
  },
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { path, content } = args as { path: string; content: string };

    if (!path) return { ok: false, error: 'path is required', code: 'input_invalid' };
    if (content === undefined)
      return { ok: false, error: 'content is required', code: 'input_invalid' };

    const abs = expandPath(path, ctx.workingDir);
    const fs = fsOf(ctx);
    if (!('mtime' in fs)) return fs;

    if (isWriteBlocked(abs)) {
      return {
        ok: false,
        error: `Writing to ${abs} is blocked. Use the appropriate ethos command instead.`,
        code: 'execution_failed',
      };
    }

    try {
      const stale = await checkStaleWrite(abs, ctx.readMtimes, fs);
      if (stale) return stale;

      await fs.mkdir(dirname(abs));
      await fs.write(abs, content);

      // Self-recovery — read the bytes back and compare. Catches the silent
      // failure classes (partial write, boundary rewrite, encoding) that
      // otherwise surface much later as a confusing "my edit vanished".
      let readBack: string | null;
      try {
        readBack = await fs.read(abs);
      } catch {
        readBack = null;
      }
      if (readBack !== content) {
        const got =
          readBack === null
            ? 'nothing (file missing)'
            : `${Buffer.byteLength(readBack, 'utf8')} bytes`;
        return {
          ok: false,
          error: `Write verification failed for ${abs}: wrote ${Buffer.byteLength(content, 'utf8')} bytes, read back ${got}. The file on disk does not match what was written.`,
          code: 'execution_failed',
        };
      }
      const evidence = writeEvidence(abs, readBack);

      // FW-28 — update the recorded mtime after a successful write so subsequent
      // writes in the same session don't false-positive against the pre-write record.
      if (ctx.readMtimes) {
        const writtenMtime = await fs.mtime(abs);
        if (writtenMtime !== null) {
          ctx.readMtimes.set(abs, { mtimeMs: writtenMtime, readAtTurn: ctx.currentTurn });
        } else {
          ctx.readMtimes.delete(abs);
        }
      }
      return {
        ok: true,
        value: `Written ${evidence.bytes} bytes to ${abs}`,
        structured: evidence,
      };
    } catch (err) {
      if (isReachError(err)) return reachFailure('write', abs);
      return {
        ok: false,
        error: `Cannot write ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        code: 'execution_failed',
      };
    }
  },
};

// ---------------------------------------------------------------------------
// patch_file — find old_text in file, replace with new_text
// ---------------------------------------------------------------------------

export const patchFileTool: Tool = {
  name: 'patch_file',
  description:
    'Replace an exact block of text in a file with new content. old_text must match the file content exactly (including whitespace and indentation). Use read_file first to confirm the exact text.',
  toolset: 'file',
  capabilities: {
    fs_reach: { read: 'from-personality', write: 'from-personality' },
  },
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to modify' },
      old_text: { type: 'string', description: 'Exact text to find and replace' },
      new_text: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { path, old_text, new_text } = args as {
      path: string;
      old_text: string;
      new_text: string;
    };

    if (!path) return { ok: false, error: 'path is required', code: 'input_invalid' };
    if (!old_text) return { ok: false, error: 'old_text is required', code: 'input_invalid' };

    const abs = expandPath(path, ctx.workingDir);
    const fs = fsOf(ctx);
    if (!('mtime' in fs)) return fs;

    if (isWriteBlocked(abs)) {
      return { ok: false, error: `Writing to ${abs} is blocked.`, code: 'execution_failed' };
    }

    try {
      const stale = await checkStaleWrite(abs, ctx.readMtimes, fs);
      if (stale) return stale;

      let content: string;
      try {
        content = await fs.read(abs);
      } catch (err) {
        if (isReachError(err)) return reachFailure('read', abs);
        if (err instanceof Error && err.message.startsWith('File not found:')) {
          return {
            ok: false,
            error: `Cannot read ${abs}: file not found`,
            code: 'execution_failed',
          };
        }
        return {
          ok: false,
          error: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
          code: 'execution_failed',
        };
      }

      const occurrences = countOccurrences(content, old_text);
      if (occurrences === 0) {
        // Already-applied no-op. BOTH conditions are required: old_text absent
        // (implied by occurrences === 0) AND new_text present. Checking only
        // for new_text would silently succeed when the agent patched the wrong
        // file and that file happens to contain the replacement text.
        if (new_text && content.includes(new_text)) {
          return {
            ok: true,
            value: `No change: the patch is already applied at ${abs}.`,
            structured: { ...writeEvidence(abs, content), changed: false },
          };
        }

        const whitespace = diagnoseWhitespaceMismatch(content, old_text, abs);
        if (whitespace) return { ok: false, error: whitespace, code: 'execution_failed' };

        return {
          ok: false,
          error: `old_text not found in ${abs}. Use read_file to verify the exact content.`,
          code: 'execution_failed',
        };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          error: describeAmbiguousMatches(content, old_text, abs, occurrences),
          code: 'execution_failed',
        };
      }

      const patched = content.replace(old_text, new_text);
      await fs.write(abs, patched);

      // Self-recovery — same read-back-and-compare write_file does, for the
      // same silent failure classes (partial write, boundary rewrite,
      // encoding). Without it `Patched <path>` is a claim, not a fact.
      let readBack: string | null;
      try {
        readBack = await fs.read(abs);
      } catch {
        readBack = null;
      }
      if (readBack !== patched) {
        const got =
          readBack === null
            ? 'nothing (file missing)'
            : `${Buffer.byteLength(readBack, 'utf8')} bytes`;
        return {
          ok: false,
          error: `Patch verification failed for ${abs}: wrote ${Buffer.byteLength(patched, 'utf8')} bytes, read back ${got}. The file on disk does not match what was written.`,
          code: 'execution_failed',
        };
      }

      // FW-28 — update the recorded mtime after a successful patch.
      if (ctx.readMtimes) {
        const patchedMtime = await fs.mtime(abs);
        if (patchedMtime !== null) {
          ctx.readMtimes.set(abs, { mtimeMs: patchedMtime, readAtTurn: ctx.currentTurn });
        } else {
          ctx.readMtimes.delete(abs);
        }
      }
      return {
        ok: true,
        value: `Patched ${abs}`,
        structured: { ...writeEvidence(abs, readBack), changed: patched !== content },
      };
    } catch (err) {
      if (isReachError(err)) return reachFailure('write', abs);
      throw err;
    }
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// patch_file self-recovery diagnostics
// ---------------------------------------------------------------------------

const WHITESPACE_LEGEND = '· = space, → = tab, ¶ = line end';

/** Lines around the mismatch that get rendered. Keep the error short enough
 *  that the model actually reads it — an unread diagnosis is not a recovery. */
const DIAGNOSIS_CONTEXT_LINES = 2;

/** Collapse runs of spaces/tabs and drop trailing whitespace, so `\t` and
 *  four spaces compare equal. */
function normalizeWhitespace(line: string): string {
  return line.replace(/[ \t]+$/, '').replace(/[ \t]+/g, ' ');
}

function visualizeWhitespace(line: string): string {
  return `${line.replace(/ /g, '·').replace(/\t/g, '→')}¶`;
}

/**
 * On a genuine zero match, retry the comparison whitespace-normalized. When
 * that matches, the failure is a whitespace difference — invisible in the
 * default message — so render expected vs. actual with whitespace visualized.
 * Returns null when the miss is not whitespace-related.
 */
function diagnoseWhitespaceMismatch(content: string, oldText: string, abs: string): string | null {
  const contentLines = content.split('\n');
  const oldLines = oldText.split('\n');
  const normContent = contentLines.map(normalizeWhitespace);
  const normOld = oldLines.map(normalizeWhitespace);

  let start = -1;
  for (let i = 0; i + normOld.length <= normContent.length; i++) {
    let allMatch = true;
    for (let j = 0; j < normOld.length; j++) {
      if (normContent[i + j] !== normOld[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    // Not line-aligned (old_text starts mid-line). Fall back to a whole-text
    // normalized probe so a mid-line whitespace difference is still named.
    if (!normContent.join('\n').includes(normOld.join('\n'))) return null;
    const expected = oldLines
      .slice(0, DIAGNOSIS_CONTEXT_LINES * 2 + 1)
      .map((l) => `  ${visualizeWhitespace(l)}`)
      .join('\n');
    return [
      `old_text not found in ${abs}, but it matches once whitespace is normalized —`,
      `the difference is whitespace only (${WHITESPACE_LEGEND}).`,
      '',
      'expected (old_text):',
      expected,
      '',
      'Re-read the file and copy the exact spacing and indentation.',
    ].join('\n');
  }

  let mismatch = 0;
  for (let j = 0; j < oldLines.length; j++) {
    if (contentLines[start + j] !== oldLines[j]) {
      mismatch = j;
      break;
    }
  }
  const from = Math.max(0, mismatch - DIAGNOSIS_CONTEXT_LINES);
  const to = Math.min(oldLines.length - 1, mismatch + DIAGNOSIS_CONTEXT_LINES);

  const expected: string[] = [];
  const actual: string[] = [];
  for (let j = from; j <= to; j++) {
    expected.push(`  ${visualizeWhitespace(oldLines[j] ?? '')}`);
    actual.push(`  ${visualizeWhitespace(contentLines[start + j] ?? '')}`);
  }

  return [
    `old_text not found in ${abs}, but line ${start + mismatch + 1} matches once whitespace is`,
    `normalized — the difference is whitespace only (${WHITESPACE_LEGEND}).`,
    '',
    'expected (old_text):',
    expected.join('\n'),
    '',
    `actual (${abs} lines ${start + from + 1}–${start + to + 1}):`,
    actual.join('\n'),
    '',
    'Re-read the file and copy the exact spacing and indentation.',
  ].join('\n');
}

/** Max occurrences enumerated in an ambiguous-match error. */
const MAX_LISTED_OCCURRENCES = 10;

/** Line number + one-line preview for every non-overlapping occurrence. */
function occurrenceSites(
  content: string,
  needle: string,
): Array<{ line: number; preview: string }> {
  const sites: Array<{ line: number; preview: string }> = [];
  let idx = content.indexOf(needle);
  while (idx !== -1) {
    const line = content.slice(0, idx).split('\n').length;
    const lineStart = content.lastIndexOf('\n', idx - 1) + 1;
    const nl = content.indexOf('\n', idx);
    const lineEnd = nl === -1 ? content.length : nl;
    sites.push({ line, preview: content.slice(lineStart, lineEnd).trim().slice(0, 120) });
    idx = content.indexOf(needle, idx + needle.length);
  }
  return sites;
}

/**
 * Ambiguous match: report *where* each occurrence is, not just how many there
 * are, so the agent can pick disambiguating context without re-reading the file.
 */
function describeAmbiguousMatches(
  content: string,
  oldText: string,
  abs: string,
  occurrences: number,
): string {
  const sites = occurrenceSites(content, oldText);
  const shown = sites.slice(0, MAX_LISTED_OCCURRENCES);
  const lineList = shown.map((s) => s.line).join(', ');
  const previews = shown.map((s) => `  line ${s.line}: ${s.preview}`).join('\n');
  const more = sites.length > shown.length ? `\n  … and ${sites.length - shown.length} more` : '';
  return [
    `old_text matches ${occurrences} locations in ${abs} (lines ${lineList}). Add surrounding`,
    'context to make the match unique, or call patch_file once per location.',
    '',
    `${previews}${more}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

async function walkAndSearch(
  fs: ScopedFs,
  dir: string,
  match: (line: string) => boolean,
  glob: string | undefined,
  matches: SearchMatch[],
  maxMatches: number,
  depth: number,
): Promise<void> {
  if (depth > 6 || matches.length >= maxMatches) return;

  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = await fs.listEntries(dir);
  } catch {
    // Any error in listing (reach failure, missing dir) skips the branch
    // silently — search is best-effort and continues at the next branch.
    return;
  }

  for (const entry of entries) {
    if (matches.length >= maxMatches) break;
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    if (['node_modules', 'dist', '.git', '.turbo', 'coverage'].includes(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDir) {
      await walkAndSearch(fs, fullPath, match, glob, matches, maxMatches, depth + 1);
      continue;
    }

    if (glob && !matchGlob(entry.name, glob)) continue;
    if (!isTextFile(fullPath)) continue;

    let text: string;
    try {
      text = await fs.read(fullPath);
    } catch {
      continue;
    }
    if (text.length > 2 * 1024 * 1024) continue; // skip files > 2MB

    const lines = text.split('\n');
    for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
      const line = lines[i];
      if (line !== undefined && match(line)) {
        matches.push({ file: fullPath, line: i + 1, content: line.trim() });
      }
    }
  }
}

/** Collapse runs of spaces/tabs so an indentation-only difference still hits. */
function collapseWhitespace(s: string): string {
  return s.replace(/[ \t]+/g, ' ').trim();
}

function renderMatches(matches: SearchMatch[], pattern: string, probeNote?: string): string {
  const lines = matches.map((m) => `${m.file}:${m.line}: ${m.content}`);
  const header = `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${pattern}":\n\n`;
  const note = probeNote
    ? `Note: the exact pattern did not match — these are ${probeNote} matches.\n\n`
    : '';
  return header + note + lines.join('\n');
}

export const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Search for a text pattern across files in a directory. Returns file paths, line numbers, and matching lines.',
  toolset: 'file',
  maxResultChars: 20_000,
  outputIsUntrusted: true,
  capabilities: {
    fs_reach: { read: 'from-personality' },
  },
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text pattern to search for' },
      path: {
        type: 'string',
        description: 'Directory to search (defaults to working directory)',
      },
      glob: {
        type: 'string',
        description: 'File name glob filter, e.g. "*.ts" or "*.md"',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of matches to return (default 50)',
      },
    },
    required: ['pattern'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { pattern, path, glob, max_results } = args as {
      pattern: string;
      path?: string;
      glob?: string;
      max_results?: number;
    };

    if (!pattern) return { ok: false, error: 'pattern is required', code: 'input_invalid' };

    const searchDir = path ? expandPath(path, ctx.workingDir) : ctx.workingDir;
    const maxMatches = Math.min(max_results ?? 50, 200);
    const matches: SearchMatch[] = [];
    const fs = fsOf(ctx);
    if (!('mtime' in fs)) return fs;

    try {
      await walkAndSearch(
        fs,
        searchDir,
        (line) => line.includes(pattern),
        glob,
        matches,
        maxMatches,
        0,
      );
    } catch (err) {
      if (isReachError(err)) return reachFailure('read', searchDir);
      throw err;
    }

    if (matches.length === 0) {
      // Self-recovery — a zero result is ambiguous between "not there" and
      // "wrong casing / spacing". Probe both before reporting absence. The
      // probe is unconditional and its result is labelled honestly.
      const lowered = pattern.toLowerCase();
      const collapsed = collapseWhitespace(pattern);
      const probes: Array<{ note: string; match: (line: string) => boolean }> = [
        { note: 'case-insensitive', match: (line) => line.toLowerCase().includes(lowered) },
        {
          note: 'whitespace-collapsed',
          match: (line) => collapseWhitespace(line).includes(collapsed),
        },
      ];

      for (const probe of probes) {
        const near: SearchMatch[] = [];
        try {
          await walkAndSearch(fs, searchDir, probe.match, glob, near, maxMatches, 0);
        } catch {
          continue;
        }
        if (near.length > 0) return { ok: true, value: renderMatches(near, pattern, probe.note) };
      }

      return { ok: true, value: `No matches found for "${pattern}"` };
    }

    return { ok: true, value: renderMatches(matches, pattern) };
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFileTools(): Tool[] {
  return [readFileTool, writeFileTool, patchFileTool, searchFilesTool];
}
