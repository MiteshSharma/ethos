import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import type { Tool, ToolResult } from '@ethosagent/types';

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

    let content: string;
    try {
      content = await readFile(abs, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
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

    if (isWriteBlocked(abs)) {
      return {
        ok: false,
        error: `Writing to ${abs} is blocked. Use the appropriate ethos command instead.`,
        code: 'execution_failed',
      };
    }

    try {
      const { mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
      return { ok: true, value: `Written ${content.length} bytes to ${abs}` };
    } catch (err) {
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

    if (isWriteBlocked(abs)) {
      return { ok: false, error: `Writing to ${abs} is blocked.`, code: 'execution_failed' };
    }

    let content: string;
    try {
      content = await readFile(abs, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`,
        code: 'execution_failed',
      };
    }

    if (!content.includes(old_text)) {
      return {
        ok: false,
        error: `old_text not found in ${abs}. Use read_file to verify the exact content.`,
        code: 'execution_failed',
      };
    }

    const patched = content.replace(old_text, new_text);
    await writeFile(abs, patched, 'utf-8');
    return { ok: true, value: `Patched ${abs}` };
  },
};

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

async function walkAndSearch(
  dir: string,
  pattern: string,
  glob: string | undefined,
  matches: SearchMatch[],
  maxMatches: number,
  depth: number,
): Promise<void> {
  if (depth > 6 || matches.length >= maxMatches) return;

  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (matches.length >= maxMatches) break;
    if (entry.name.startsWith('.') && entry.name !== '.env') continue;
    if (['node_modules', 'dist', '.git', '.turbo', 'coverage'].includes(entry.name)) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await walkAndSearch(fullPath, pattern, glob, matches, maxMatches, depth + 1);
    } else if (entry.isFile()) {
      if (glob && !matchGlob(entry.name, glob)) continue;
      if (!isTextFile(fullPath)) continue;

      let text: string;
      try {
        const s = await stat(fullPath);
        if (s.size > 2 * 1024 * 1024) continue; // skip files > 2MB
        text = await readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        if (lines[i].includes(pattern)) {
          matches.push({ file: fullPath, line: i + 1, content: lines[i].trim() });
        }
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

    await walkAndSearch(searchDir, pattern, glob, matches, maxMatches, 0);

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
