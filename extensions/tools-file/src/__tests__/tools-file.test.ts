import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFileTools,
  patchFileTool,
  readFileTool,
  searchFilesTool,
  writeFileTool,
} from '../index';

const makeCtx = (workingDir: string) => ({
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir,
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
});

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-file-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('createFileTools', () => {
  it('returns 4 tools', () => {
    expect(createFileTools()).toHaveLength(4);
  });
});

describe('read_file', () => {
  it('reads a file', async () => {
    const path = join(testDir, 'hello.ts');
    await writeFile(path, 'const x = 1;\nconst y = 2;\n');
    const result = await readFileTool.execute({ path }, makeCtx(testDir));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('const x = 1;');
  });

  it('returns a range of lines', async () => {
    const path = join(testDir, 'lines.txt');
    await writeFile(path, 'line1\nline2\nline3\nline4\nline5\n');
    const result = await readFileTool.execute(
      { path, start_line: 2, end_line: 4 },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('line2');
      expect(result.value).not.toContain('line1');
      expect(result.value).not.toContain('line5');
    }
  });

  it('returns error for missing file', async () => {
    const result = await readFileTool.execute({ path: join(testDir, 'nope.ts') }, makeCtx(testDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('returns error if path is missing', async () => {
    const result = await readFileTool.execute({}, makeCtx(testDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

describe('write_file', () => {
  it('writes a new file', async () => {
    const path = join(testDir, 'new.ts');
    const result = await writeFileTool.execute(
      { path, content: 'export const x = 1;' },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(true);
    const readBack = await readFileTool.execute({ path }, makeCtx(testDir));
    expect(readBack.ok).toBe(true);
    if (readBack.ok) expect(readBack.value).toContain('export const x = 1;');
  });

  it('creates parent directories', async () => {
    const path = join(testDir, 'nested', 'deep', 'file.ts');
    const result = await writeFileTool.execute({ path, content: 'hello' }, makeCtx(testDir));
    expect(result.ok).toBe(true);
  });

  it('returns input_invalid for missing path', async () => {
    const result = await writeFileTool.execute({ content: 'x' }, makeCtx(testDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});

describe('patch_file', () => {
  it('replaces old_text with new_text', async () => {
    const path = join(testDir, 'patch.ts');
    await writeFile(path, 'const x = 1;\nconst y = 2;\n');
    const result = await patchFileTool.execute(
      { path, old_text: 'const y = 2;', new_text: 'const y = 42;' },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(true);
    const readBack = await readFileTool.execute({ path }, makeCtx(testDir));
    if (readBack.ok) expect(readBack.value).toContain('const y = 42;');
  });

  it('returns error if old_text not found', async () => {
    const path = join(testDir, 'patch.ts');
    await writeFile(path, 'hello world\n');
    const result = await patchFileTool.execute(
      { path, old_text: 'not there', new_text: 'replacement' },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
  });

  it('returns error when old_text matches more than once', async () => {
    const path = join(testDir, 'ambiguous.ts');
    await writeFile(path, 'const x = 1;\nconst x = 1;\n');
    const result = await patchFileTool.execute(
      { path, old_text: 'const x = 1;', new_text: 'const x = 2;' },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/2 locations/);
    }

    // File must be left untouched when patch is ambiguous
    const after = await readFileTool.execute({ path }, makeCtx(testDir));
    if (after.ok) {
      expect(after.value).toContain('const x = 1;\nconst x = 1;');
      expect(after.value).not.toContain('const x = 2;');
    }
  });
});

describe('search_files', () => {
  it('finds matching lines across files', async () => {
    await writeFile(join(testDir, 'a.ts'), 'const ethos = true;\nconst other = false;\n');
    await writeFile(join(testDir, 'b.ts'), 'import { ethos } from "./a";\n');
    const result = await searchFilesTool.execute(
      { pattern: 'ethos', path: testDir },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('a.ts');
      expect(result.value).toContain('b.ts');
    }
  });

  it('filters by glob', async () => {
    await writeFile(join(testDir, 'match.ts'), 'found here\n');
    await writeFile(join(testDir, 'skip.md'), 'found here too\n');
    const result = await searchFilesTool.execute(
      { pattern: 'found', path: testDir, glob: '*.ts' },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('match.ts');
      expect(result.value).not.toContain('skip.md');
    }
  });

  it('returns no-matches message when nothing found', async () => {
    const result = await searchFilesTool.execute(
      { pattern: 'zzznomatch', path: testDir },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('No matches');
  });

  it('returns input_invalid if pattern is missing', async () => {
    const result = await searchFilesTool.execute({}, makeCtx(testDir));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });
});
