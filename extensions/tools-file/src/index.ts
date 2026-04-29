import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import {
  BoundaryError,
  type Storage,
  type Tool,
  type ToolContext,
  type ToolResult,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BLOCKED_WRITE_PATHS = [join(homedir(), '.ethos', 'config.yaml')];
const BLOCKED_WRITE_PREFIXES = [join(homedir(), '.ethos', 'sessions')];

function expandPath(p: string, cwd: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(cwd, p);
}

function isWriteBlocked(abs: string): boolean {
  if (BLOCKED_WRITE_PATHS.includes(abs)) return true;
  return BLOCKED_WRITE_PREFIXES.some((prefix) => abs.startsWith(prefix));
}

/**
 * Resolve the Storage to use for this call. AgentLoop hands ScopedStorage
 * via ctx.storage when fs_reach is configured; legacy callers (CLI tests,
 * tools instantiated outside the loop) fall back to an unrestricted
 * FsStorage so existing behaviour is preserved.
 */
let fallbackStorage: FsStorage | undefined;
function storageOf(ctx: ToolContext): Storage {
  if (ctx.storage) return ctx.storage;
  if (!fallbackStorage) fallbackStorage = new FsStorage();
  return fallbackStorage;
}

/** Translate a BoundaryError into a tool-shaped failure so the LLM gets
 *  an actionable message instead of an unhandled rejection. */
function boundaryFailure(err: BoundaryError): ToolResult {
  return {
    ok: false,
    error: `Filesystem boundary: ${err.kind} of "${err.path}" is outside this personality's fs_reach allowlist.`,
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
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read (absolute or relative to cwd)' },
      start_line: { type: 'number', description: 'First line to return (1-indexed, inclusive)' },
      end_line: { type: 'number', description: 'Last line to return (1-indexed, inclusive)' },
    },
    required: ['path'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const { path, start_line, end_line } = args as {
      path: string;
      start_line?: number;
      end_line?: number;
    };

    if (!path) return { ok: false, error: 'path is required', code: 'input_invalid' };

    const abs = expandPath(path, ctx.workingDir);
    const storage = storageOf(ctx);

    let content: string | null;
    try {
      content = await storage.read(abs);
    } catch (err) {
      if (err instanceof BoundaryError) return boundaryFailure(err);
      return {
        ok: false,
        error: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        code: 'execution_failed',
      };
    }

    if (content === null) {
      return {
        ok: false,
        error: `Cannot read ${abs}: file not found`,
        code: 'execution_failed',
      };
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
    const storage = storageOf(ctx);

    if (isWriteBlocked(abs)) {
      return {
        ok: false,
        error: `Writing to ${abs} is blocked. Use the appropriate ethos command instead.`,
        code: 'execution_failed',
      };
    }

    try {
      await storage.mkdir(dirname(abs));
      await storage.write(abs, content);
      return { ok: true, value: `Written ${content.length} bytes to ${abs}` };
    } catch (err) {
      if (err instanceof BoundaryError) return boundaryFailure(err);
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
    const storage = storageOf(ctx);

    if (isWriteBlocked(abs)) {
      return { ok: false, error: `Writing to ${abs} is blocked.`, code: 'execution_failed' };
    }

    let content: string | null;
    try {
      content = await storage.read(abs);
    } catch (err) {
      if (err instanceof BoundaryError) return boundaryFailure(err);
      return {
        ok: false,
        error: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        code: 'execution_failed',
      };
    }

    if (content === null) {
      return {
        ok: false,
        error: `Cannot read ${abs}: file not found`,
        code: 'execution_failed',
      };
    }

    const occurrences = countOccurrences(content, old_text);
    if (occurrences === 0) {
      return {
        ok: false,
        error: `old_text not found in ${abs}. Use read_file to verify the exact content.`,
        code: 'execution_failed',
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        error: `old_text matches ${occurrences} locations in ${abs}. Add surrounding context to make the match unique, or call patch_file once per location.`,
        code: 'execution_failed',
      };
    }

    const patched = content.replace(old_text, new_text);
    try {
      await storage.write(abs, patched);
    } catch (err) {
      if (err instanceof BoundaryError) return boundaryFailure(err);
      throw err;
    }
    return { ok: true, value: `Patched ${abs}` };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
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
  storage: Storage,
  dir: string,
  pattern: string,
  glob: string | undefined,
  matches: SearchMatch[],
  maxMatches: number,
  depth: number,
): Promise<void> {
  if (depth > 6 || matches.length >= maxMatches) return;

  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    entries = await storage.listEntries(dir);
  } catch (err) {
    if (err instanceof BoundaryError) return; // out of allowlist — skip silently
    return;
  }

  for (const entry of entries) {
    if (matches.length >= maxMatches) break;
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    if (['node_modules', 'dist', '.git', '.turbo', 'coverage'].includes(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDir) {
      await walkAndSearch(storage, fullPath, pattern, glob, matches, maxMatches, depth + 1);
      continue;
    }

    if (glob && !matchGlob(entry.name, glob)) continue;
    if (!isTextFile(fullPath)) continue;

    let text: string | null;
    try {
      text = await storage.read(fullPath);
    } catch {
      continue;
    }
    if (text === null) continue;
    if (text.length > 2 * 1024 * 1024) continue; // skip files > 2MB

    const lines = text.split('\n');
    for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
      const line = lines[i];
      if (line && line.includes(pattern)) {
        matches.push({ file: fullPath, line: i + 1, content: line.trim() });
      }
    }
  }
}

export const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Search for a text pattern across files in a directory. Returns file paths, line numbers, and matching lines.',
  toolset: 'file',
  maxResultChars: 20_000,
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
    const storage = storageOf(ctx);

    try {
      await walkAndSearch(storage, searchDir, pattern, glob, matches, maxMatches, 0);
    } catch (err) {
      if (err instanceof BoundaryError) return boundaryFailure(err);
      throw err;
    }

    if (matches.length === 0) {
      return { ok: true, value: `No matches found for "${pattern}"` };
    }

    const lines = matches.map((m) => `${m.file}:${m.line}: ${m.content}`);
    const header = `${matches.length} match${matches.length === 1 ? '' : 'es'} for "${pattern}":\n\n`;
    return { ok: true, value: header + lines.join('\n') };
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFileTools(): Tool[] {
  return [readFileTool, writeFileTool, patchFileTool, searchFilesTool];
}
