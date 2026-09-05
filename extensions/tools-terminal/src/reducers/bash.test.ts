import type { ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { bashReducer } from './bash';

const ctx = { args: {}, turnCount: 0 };

function makeCtxWithCmd(command: string) {
  return { args: { command }, turnCount: 0 };
}

describe('bashReducer', () => {
  it('git status output with 3 modified files → summary line with counts', () => {
    const output = [
      ' M packages/core/src/foo.ts',
      ' M packages/types/src/bar.ts',
      'M  extensions/tools-terminal/src/index.ts',
      '?? new-file.ts',
    ].join('\n');
    const result: ToolResult = { ok: true, value: output };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('git status'));
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('git status:');
      expect(reduced.value).toContain('modified');
      expect(reduced.value).toContain('untracked');
    }
  });

  it('vitest output with Test Files/Tests/Duration lines → keeps summary block', () => {
    const output = [
      'some long noise line 1',
      'some long noise line 2',
      'some long noise line 3',
      ' Test Files  5 passed (5)',
      ' Tests  42 passed (42)',
      ' Duration  1.23s',
    ].join('\n');
    const result: ToolResult = { ok: true, value: output };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('pnpm test'));
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('Test Files');
      expect(reduced.value).toContain('Tests');
      expect(reduced.value).toContain('Duration');
      // Noise lines should not be present
      expect(reduced.value).not.toContain('some long noise line 1');
    }
  });

  it('pnpm install output with "added 10 packages" line → keeps summary line', () => {
    const output = [
      'Resolving dependencies...',
      'Fetching packages...',
      'added 10 packages in 2.1s',
      'Done.',
    ].join('\n');
    const result: ToolResult = { ok: true, value: output };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('pnpm install'));
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('added 10 packages');
    }
  });

  it('large output (>8KB) → reduces to head+tail with marker', () => {
    // Each line is ~60 chars; 500 lines = ~30KB
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}-${'x'.repeat(50)}`);
    const bigOutput = lines.join('\n');
    expect(bigOutput.length).toBeGreaterThan(8 * 1024);

    const result: ToolResult = { ok: true, value: bigOutput };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('some-long-command'));
    expect(reduced.ok).toBe(true);
    if (reduced.ok) {
      expect(reduced.value).toContain('[reduced from');
      expect(reduced.value).toContain('head+tail');
      expect(reduced.value).toContain('line-0-');
      expect(reduced.value).toContain('line-499-');
    }
  });

  it('error result → passes through unchanged', () => {
    const result: ToolResult = { ok: false, error: 'command failed', code: 'execution_failed' };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('git status'));
    expect(reduced).toEqual(result);
  });

  it('small output (≤8KB) with no special command → passes through unchanged', () => {
    const result: ToolResult = { ok: true, value: 'hello world' };
    const reduced = bashReducer.reduce(result, ctx);
    expect(reduced).toEqual(result);
  });
});

// The reducer runs after the tool returns and before the budget trim, so it
// sees terminal output that `spill.ts` has already truncated — head + notice +
// tail, with the notice carrying the path to the full output on disk. Every
// variant rewrites that value, so without the guard the pointer is destroyed
// on exactly the oversized results it exists for.
describe('bashReducer — spill pointer', () => {
  const SPILL_PATH = '/work/.ethos/terminal-spill/cli_ethos-1700000000000-a1b2c3.log';
  // Byte-identical in shape to what `spillOversizedOutput` emits.
  const NOTICE =
    `\n\n[truncated — 312004 chars total; full output written to ${SPILL_PATH} ` +
    `— use read_file to see the rest]\n\n`;

  /** head + notice + tail, with the notice ~60% in, as spill.ts lays it out. */
  function spilled(lines: string[], headCount: number): string {
    return lines.slice(0, headCount).join('\n') + NOTICE + lines.slice(headCount).join('\n');
  }

  function pointerCount(value: string): number {
    return value.split('full output written to').length - 1;
  }

  const bigLines = Array.from({ length: 500 }, (_, i) => `line-${i}-${'x'.repeat(50)}`);

  it('generic reduction keeps the spill path when the notice falls in the dropped middle', () => {
    const value = spilled(bigLines, 300);
    expect(value.length).toBeGreaterThan(8 * 1024);
    const reduced = bashReducer.reduce({ ok: true, value }, makeCtxWithCmd('some-long-command'));
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;
    // Head+tail keep drops the middle, so the original notice is gone…
    expect(reduced.value).toContain('[reduced from');
    // …and the pointer is re-attached exactly once.
    expect(reduced.value).toContain(SPILL_PATH);
    expect(pointerCount(reduced.value)).toBe(1);
  });

  it('test-run reduction keeps the spill path', () => {
    const value = spilled(
      [
        'noise line that the summarizer drops',
        'more noise',
        ' Test Files  5 passed (5)',
        ' Tests  42 passed (42)',
        ' Duration  1.23s',
      ],
      2,
    );
    const reduced = bashReducer.reduce({ ok: true, value }, makeCtxWithCmd('pnpm test'));
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;
    expect(reduced.value).toContain('Test Files');
    expect(reduced.value).toContain(SPILL_PATH);
    expect(pointerCount(reduced.value)).toBe(1);
  });

  it('git-status reduction keeps the spill path', () => {
    // Six entries before the notice so the 5-slot preview is already full when
    // the reducer reaches it. With fewer, the notice line is itself picked up
    // as a preview entry and the path survives by accident — which is not the
    // property under test.
    const value = spilled(
      [' M a.ts', ' M b.ts', ' M c.ts', ' M d.ts', ' M e.ts', ' M f.ts', '?? g.ts'],
      6,
    );
    const reduced = bashReducer.reduce({ ok: true, value }, makeCtxWithCmd('git status'));
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;
    expect(reduced.value).toContain('git status:');
    expect(reduced.value).toContain(SPILL_PATH);
    expect(pointerCount(reduced.value)).toBe(1);
  });

  it('install reduction keeps the spill path', () => {
    const value = spilled(
      ['Resolving dependencies...', 'Fetching packages...', 'added 10 packages in 2.1s', 'Done.'],
      2,
    );
    const reduced = bashReducer.reduce({ ok: true, value }, makeCtxWithCmd('pnpm install'));
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;
    expect(reduced.value).toContain('added 10 packages');
    expect(reduced.value).toContain(SPILL_PATH);
    expect(pointerCount(reduced.value)).toBe(1);
  });

  it('does not append a second pointer when the notice survives the reduction', () => {
    // Notice inside the first HEAD_LINES, so head+tail keeps it.
    const value = spilled(bigLines, 5);
    const reduced = bashReducer.reduce({ ok: true, value }, makeCtxWithCmd('some-long-command'));
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;
    expect(pointerCount(reduced.value)).toBe(1);
  });

  it('a result with no spill notice is byte-identical to the unguarded reduction', () => {
    const cases: Array<[string, string]> = [
      ['some-long-command', bigLines.join('\n')],
      ['pnpm test', ' Test Files  5 passed (5)\n Tests  42 passed (42)'],
      ['git status', ' M a.ts\n?? c.ts'],
      ['pnpm install', 'added 10 packages in 2.1s'],
    ];
    for (const [cmd, value] of cases) {
      const reduced = bashReducer.reduce({ ok: true, value }, makeCtxWithCmd(cmd));
      expect(reduced.ok, cmd).toBe(true);
      if (!reduced.ok) continue;
      expect(reduced.value, cmd).not.toContain('full output written to');
    }
  });

  it('a pass-through result is returned as the same object, not a rewritten copy', () => {
    const result: ToolResult = { ok: true, value: 'short output, no notice' };
    expect(bashReducer.reduce(result, makeCtxWithCmd('some-long-command'))).toBe(result);
  });
});

// ---------------------------------------------------------------------------
// Ground-truth evidence (plan `ground-truth-verification`, R6)
// ---------------------------------------------------------------------------

describe('bashReducer — exit-code evidence', () => {
  it('keeps the suffix and structured across a summarizing rewrite', () => {
    const result: ToolResult = {
      ok: true,
      value: ' M src/foo.ts\n?? new.ts\n(exit 0)',
      structured: { exitCode: 0, command: 'git status --short' },
    };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('git status --short'));
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;
    // git status is summarized: the value is replaced outright, which is
    // exactly where both halves of the evidence used to die.
    expect(reduced.value).toContain('git status:');
    expect(reduced.value.endsWith('\n(exit 0)')).toBe(true);
    expect(reduced.structured).toEqual({ exitCode: 0, command: 'git status --short' });
  });

  it('does not double the suffix when the rewrite kept it', () => {
    const result: ToolResult = {
      ok: true,
      value: 'Test Files 1 passed\n(exit 0)',
      structured: { exitCode: 0, command: 'pnpm test' },
    };
    const reduced = bashReducer.reduce(result, makeCtxWithCmd('pnpm test'));
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;
    expect(reduced.value.match(/\(exit 0\)/g)).toHaveLength(1);
  });

  it('leaves a failed result untouched', () => {
    const result: ToolResult = { ok: false, error: 'boom', code: 'execution_failed' };
    expect(bashReducer.reduce(result, makeCtxWithCmd('git status'))).toBe(result);
  });
});
