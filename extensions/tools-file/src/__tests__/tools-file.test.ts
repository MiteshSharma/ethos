import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopedFsImpl } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ScopedFs, ToolContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFileTools,
  patchFileTool,
  readFileTool,
  searchFilesTool,
  writeFileTool,
} from '../index';

const makeCtx = (workingDir: string): ToolContext => {
  const allowed = new Set([workingDir]);
  return {
    sessionId: 'test',
    sessionKey: 'cli:test',
    platform: 'cli',
    workingDir,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    scopedFs: new ScopedFsImpl(new FsStorage(), allowed, allowed),
  };
};

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

  it('fails when the write is silently dropped (read-back verification)', async () => {
    const allowed = new Set([testDir]);
    const real = new ScopedFsImpl(new FsStorage(), allowed, allowed);
    // A ScopedFs whose write is a no-op — the storage-layer failure class
    // (partial write, boundary rewrite, encoding) that is otherwise silent.
    const droppingFs: ScopedFs = {
      read: (p) => real.read(p),
      readBytes: (p) => real.readBytes(p),
      write: async () => {},
      exists: (p) => real.exists(p),
      list: (p) => real.list(p),
      listEntries: (p) => real.listEntries(p),
      mtime: (p) => real.mtime(p),
      mkdir: (p) => real.mkdir(p),
    };
    const ctx = { ...makeCtx(testDir), scopedFs: droppingFs };
    const path = join(testDir, 'dropped.ts');

    const result = await writeFileTool.execute({ path, content: 'export const x = 1;' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toMatch(/Write verification failed/);
    }
  });
});

// ---------------------------------------------------------------------------
// Ground-truth evidence (plan `ground-truth-verification`, R6)
// ---------------------------------------------------------------------------

/** A ScopedFs whose write is a no-op — the silent-drop failure class. */
function droppingFs(dir: string): ScopedFs {
  const allowed = new Set([dir]);
  const real = new ScopedFsImpl(new FsStorage(), allowed, allowed);
  return {
    read: (p) => real.read(p),
    readBytes: (p) => real.readBytes(p),
    write: async () => {},
    exists: (p) => real.exists(p),
    list: (p) => real.list(p),
    listEntries: (p) => real.listEntries(p),
    mtime: (p) => real.mtime(p),
    mkdir: (p) => real.mkdir(p),
  };
}

const sha256 = (text: string) =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

describe('write_file evidence', () => {
  it('carries structured { path, bytes, sha256 } on success', async () => {
    const path = join(testDir, 'evidence.ts');
    const content = 'export const x = 1;';
    const result = await writeFileTool.execute({ path, content }, makeCtx(testDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structured).toEqual({
      path,
      bytes: content.length,
      sha256: sha256(content),
    });
  });

  it('reports the UTF-8 byte length, not the UTF-16 code-unit count', async () => {
    const path = join(testDir, 'multibyte.txt');
    // 4 UTF-16 code units, 10 UTF-8 bytes: the emoji is a surrogate pair (4
    // bytes) and each CJK character is 3.
    const content = '\u{1F600}\u4F60\u597D';
    expect(content.length).toBe(4);
    const expectedBytes = Buffer.byteLength(content, 'utf8');
    expect(expectedBytes).toBe(10);

    const result = await writeFileTool.execute({ path, content }, makeCtx(testDir));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structured).toEqual({ path, bytes: expectedBytes, sha256: sha256(content) });
    // The model-visible text has to be honest too — it said 4 before.
    expect(result.value).toBe(`Written ${expectedBytes} bytes to ${path}`);
  });

  it('carries no structured on the read-back mismatch (ok:false IS the evidence)', async () => {
    const ctx = { ...makeCtx(testDir), scopedFs: droppingFs(testDir) };
    const result = await writeFileTool.execute(
      { path: join(testDir, 'dropped-evidence.ts'), content: 'x' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect('structured' in result).toBe(false);
  });
});

describe('patch_file evidence', () => {
  it('carries structured { path, bytes, sha256, changed: true } on a real patch', async () => {
    const path = join(testDir, 'evidence-patch.ts');
    await writeFile(path, 'const y = 2;\n');
    const result = await patchFileTool.execute(
      { path, old_text: 'const y = 2;', new_text: 'const y = 42;' },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const patched = 'const y = 42;\n';
    expect(result.structured).toEqual({
      path,
      bytes: Buffer.byteLength(patched, 'utf8'),
      sha256: sha256(patched),
      changed: true,
    });
  });

  it('reports changed: false for an already-applied patch', async () => {
    const path = join(testDir, 'evidence-noop.ts');
    const content = 'const y = 42;\n';
    await writeFile(path, content);
    const result = await patchFileTool.execute(
      { path, old_text: 'const y = 2;', new_text: 'const y = 42;' },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structured).toEqual({
      path,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256(content),
      changed: false,
    });
  });

  it('fails when the patch write is silently dropped (read-back verification)', async () => {
    const path = join(testDir, 'dropped-patch.ts');
    await writeFile(path, 'const y = 2;\n');
    const ctx = { ...makeCtx(testDir), scopedFs: droppingFs(testDir) };
    const result = await patchFileTool.execute(
      { path, old_text: 'const y = 2;', new_text: 'const y = 42;' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toMatch(/Patch verification failed/);
    expect('structured' in result).toBe(false);
  });

  it('carries no structured when old_text is not found', async () => {
    const path = join(testDir, 'evidence-miss.ts');
    await writeFile(path, 'hello world\n');
    const result = await patchFileTool.execute(
      { path, old_text: 'not there', new_text: 'replacement' },
      makeCtx(testDir),
    );
    expect(result.ok).toBe(false);
    expect('structured' in result).toBe(false);
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

  it('reports already-applied as ok and leaves the file untouched', async () => {
    const path = join(testDir, 'applied.ts');
    await writeFile(path, 'const y = 42;\n');
    const before = await stat(path);

    const result = await patchFileTool.execute(
      { path, old_text: 'const y = 2;', new_text: 'const y = 42;' },
      makeCtx(testDir),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/already applied/);
    const after = await stat(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('does NOT report already-applied when old_text is also present (wrong-file guard)', async () => {
    const path = join(testDir, 'wrongfile.ts');
    // Both old_text and new_text are present — this is a real, ambiguous edit,
    // not a no-op. Reporting "already applied" here would hide a wrong-file patch.
    await writeFile(path, 'const y = 2;\nconst y = 42;\n');

    const result = await patchFileTool.execute(
      { path, old_text: 'const y = 2;', new_text: 'const y = 42;' },
      makeCtx(testDir),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toMatch(/already applied/);
  });

  it('diagnoses a tab-vs-spaces miss as a whitespace difference', async () => {
    const path = join(testDir, 'ws.ts');
    await writeFile(path, 'function f() {\n\tconst x = 1;\n}\n');

    const result = await patchFileTool.execute(
      { path, old_text: '    const x = 1;', new_text: '    const x = 2;' },
      makeCtx(testDir),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('whitespace');
      // expected (old_text, four spaces) and actual (file, one tab), visualized
      expect(result.error).toContain('····const·x·=·1;¶');
      expect(result.error).toContain('→const·x·=·1;¶');
    }
  });

  it('lists the line number of every occurrence when the match is ambiguous', async () => {
    const path = join(testDir, 'three.ts');
    await writeFile(path, 'const x = 1;\nconst x = 1;\nconst x = 1;\n');

    const result = await patchFileTool.execute(
      { path, old_text: 'const x = 1;', new_text: 'const x = 2;' },
      makeCtx(testDir),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/3 locations/);
      expect(result.error).toMatch(/lines 1, 2, 3/);
      expect(result.error).toContain('line 1: const x = 1;');
      expect(result.error).toContain('line 2: const x = 1;');
      expect(result.error).toContain('line 3: const x = 1;');
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

  it('falls back to a case-insensitive probe and says so', async () => {
    await writeFile(join(testDir, 'case.ts'), 'const foobar = 1;\n');

    const result = await searchFilesTool.execute(
      { pattern: 'FooBar', path: testDir },
      makeCtx(testDir),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('case.ts');
      expect(result.value).toContain('const foobar = 1;');
      expect(result.value).toContain('the exact pattern did not match');
      expect(result.value).toContain('case-insensitive');
    }
  });

  it('falls back to a whitespace-collapsed probe', async () => {
    await writeFile(join(testDir, 'spacing.ts'), 'const    gap = 1;\n');

    const result = await searchFilesTool.execute(
      { pattern: 'const gap = 1;', path: testDir },
      makeCtx(testDir),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('spacing.ts');
      expect(result.value).toContain('whitespace-collapsed');
    }
  });
});
