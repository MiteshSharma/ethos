import type { AfterToolCallPayload, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createEvidenceCollector, createLedgerReset, LedgerStore } from '../evidence';

function payload(
  over: Partial<AfterToolCallPayload> & { result: ToolResult },
): AfterToolCallPayload {
  return {
    sessionId: 's1',
    toolCallId: 'call-1',
    toolName: 'write_file',
    args: {},
    workingDir: '/repo',
    durationMs: 5,
    ...over,
  };
}

function collector(ledgers: LedgerStore, alive = true) {
  return createEvidenceCollector({ ledgers, pidAlive: () => alive, now: () => 1_700_000 });
}

describe('createEvidenceCollector', () => {
  it('records a file_write from a write_file success', async () => {
    const ledgers = new LedgerStore();
    await collector(ledgers)(
      payload({
        toolName: 'write_file',
        args: { path: 'src/a.ts', content: 'x' },
        result: {
          ok: true,
          value: 'Written 1 bytes to /repo/src/a.ts',
          structured: { path: '/repo/src/a.ts', bytes: 1, sha256: 'abc' },
        },
      }),
    );

    expect(ledgers.get('s1')).toEqual([
      {
        toolCallId: 'call-1',
        toolName: 'write_file',
        ok: true,
        kind: 'file_write',
        path: '/repo/src/a.ts',
        bytes: 1,
        sha256: 'abc',
        at: 1_700_000,
      },
    ]);
  });

  it('records a command with its exit code and command line', async () => {
    const ledgers = new LedgerStore();
    await collector(ledgers)(
      payload({
        toolName: 'terminal',
        toolCallId: 'call-2',
        args: { command: 'pnpm test' },
        result: {
          ok: true,
          value: 'ok\n(exit 0)',
          structured: { exitCode: 0, command: 'pnpm test' },
        },
      }),
    );

    const [record] = ledgers.get('s1');
    expect(record?.kind).toBe('command');
    expect(record?.exitCode).toBe(0);
    expect(record?.command).toBe('pnpm test');
  });

  it('records a process and probes whether its pid is alive', async () => {
    const ledgers = new LedgerStore();
    await collector(
      ledgers,
      false,
    )(
      payload({
        toolName: 'process_start',
        args: { command: 'node server.js' },
        result: { ok: true, value: 'started', structured: { id: 'p1', pid: 4242 } },
      }),
    );

    const [record] = ledgers.get('s1');
    expect(record?.kind).toBe('process');
    expect(record?.pid).toBe(4242);
    expect(record?.aliveAtCheck).toBe(false);
  });

  it('leaves aliveAtCheck unset when the injected probe throws', async () => {
    const ledgers = new LedgerStore();
    const collect = createEvidenceCollector({
      ledgers,
      pidAlive: () => {
        throw new Error('no /proc');
      },
    });
    await collect(
      payload({
        toolName: 'process_start',
        args: {},
        result: { ok: true, value: 'started', structured: { id: 'p1', pid: 7 } },
      }),
    );

    const [record] = ledgers.get('s1');
    expect(record?.pid).toBe(7);
    expect(record?.aliveAtCheck).toBeUndefined();
  });

  it('falls back to kind other for a tool it does not know', async () => {
    const ledgers = new LedgerStore();
    await collector(ledgers)(
      payload({ toolName: 'web_search', args: { q: 'x' }, result: { ok: true, value: 'hits' } }),
    );
    expect(ledgers.get('s1')[0]?.kind).toBe('other');
  });

  it('records a failure as ok:false with its identity but no outcome fields', async () => {
    // A failure keeps WHAT IT WAS ABOUT (`command`) and reports NO OUTCOME —
    // no exit code to read as "fine". Without the identity the auditor can
    // only match this record by kind, and a failed `pnpm test` would be
    // admitted as evidence against a claim about git.
    const ledgers = new LedgerStore();
    await collector(ledgers)(
      payload({
        toolName: 'run_tests',
        toolCallId: 'call-9',
        args: { command: 'pnpm test' },
        result: { ok: false, code: 'execution_failed', error: 'exit 1' },
      }),
    );

    expect(ledgers.get('s1')).toEqual([
      {
        toolCallId: 'call-9',
        toolName: 'run_tests',
        ok: false,
        kind: 'command',
        command: 'pnpm test',
        at: 1_700_000,
      },
    ]);
  });

  it('recovers the path of a FAILED file write from its args', async () => {
    const ledgers = new LedgerStore();
    await collector(ledgers)(
      payload({
        toolName: 'write_file',
        toolCallId: 'call-10',
        args: { path: '/repo/src/b.ts', content: 'secret payload' },
        result: { ok: false, code: 'execution_failed', error: 'not permitted' },
      }),
    );

    expect(ledgers.get('s1')).toEqual([
      {
        toolCallId: 'call-10',
        toolName: 'write_file',
        ok: false,
        kind: 'file_write',
        path: '/repo/src/b.ts',
        at: 1_700_000,
      },
    ]);
  });

  it('copies nothing from args but path and command, and caps their length', async () => {
    // `args` is model-authored. Only the two identity fields are taken; a
    // write's `content` must never reach a ledger record or the observability
    // event built from it.
    const ledgers = new LedgerStore();
    await collector(ledgers)(
      payload({
        toolName: 'terminal',
        toolCallId: 'call-11',
        args: {
          command: 'x'.repeat(2000),
          cwd: '/repo',
          env: { TOKEN: 'sk-live-abc' },
          content: 'BEGIN PRIVATE KEY',
        },
        result: { ok: false, code: 'execution_failed', error: 'boom' },
      }),
    );

    const [record] = ledgers.get('s1');
    expect(record?.command).toHaveLength(512);
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'at',
      'command',
      'kind',
      'ok',
      'toolCallId',
      'toolName',
    ]);
  });
});

describe('a write that changed nothing, and a call that never ran', () => {
  it("carries patch_file's `changed: false` — the tool saying it wrote nothing", async () => {
    const ledgers = new LedgerStore();
    await collector(ledgers)(
      payload({
        toolName: 'patch_file',
        toolCallId: 'call-noop',
        args: { path: 'src/a.ts', old_text: 'x', new_text: 'y' },
        result: {
          ok: true,
          value: 'No change: the patch is already applied at /repo/src/a.ts.',
          structured: { path: '/repo/src/a.ts', bytes: 1, sha256: 'abc', changed: false },
        },
      }),
    );

    expect(ledgers.get('s1')[0]?.changed).toBe(false);
  });

  it('carries `changed: true` from a patch that did write', async () => {
    const ledgers = new LedgerStore();
    await collector(ledgers)(
      payload({
        toolName: 'patch_file',
        toolCallId: 'call-real',
        result: {
          ok: true,
          value: 'Patched /repo/src/a.ts',
          structured: { path: '/repo/src/a.ts', bytes: 2, sha256: 'abc', changed: true },
        },
      }),
    );

    expect(ledgers.get('s1')[0]?.changed).toBe(true);
  });

  it('leaves `changed` absent when the tool does not report it — absent is not false', async () => {
    // `write_file` has no no-op branch: it calls `fs.write` unconditionally, so
    // it reports no `changed` at all and every success of its is a real write.
    const ledgers = new LedgerStore();
    await collector(ledgers)(
      payload({
        result: {
          ok: true,
          value: 'Written 1 bytes to /repo/src/a.ts',
          structured: { path: '/repo/src/a.ts', bytes: 1, sha256: 'abc' },
        },
      }),
    );

    expect(ledgers.get('s1')[0]).not.toHaveProperty('changed');
  });

  it('records a REFUSED call as failed evidence, marked rejected, with its identity', async () => {
    const ledgers = new LedgerStore();
    await collector(ledgers)(
      payload({
        toolName: 'write_file',
        toolCallId: 'call-blocked',
        args: { path: 'src/a.ts', content: 'x' },
        durationMs: 0,
        rejected: true,
        result: { ok: false, error: 'Tool write_file is not permitted', code: 'execution_failed' },
      }),
    );

    expect(ledgers.get('s1')).toEqual([
      {
        toolCallId: 'call-blocked',
        toolName: 'write_file',
        ok: false,
        kind: 'file_write',
        path: 'src/a.ts',
        rejected: true,
        at: 1_700_000,
      },
    ]);
  });
});

describe('LedgerStore', () => {
  const record = { toolCallId: 'c', toolName: 't', ok: true, kind: 'other' as const, at: 0 };

  it('evicts the oldest session in insertion order once the bound is passed', () => {
    const ledgers = new LedgerStore({ maxSessions: 3 });
    for (const id of ['a', 'b', 'c']) ledgers.append(id, record);

    // Touching `a` again must NOT move it: the bound is insertion-order FIFO,
    // not LRU (approval-seams.ts:109-122).
    ledgers.append('a', record);
    ledgers.append('d', record);

    expect(ledgers.sessionCount).toBe(3);
    expect(ledgers.get('a')).toEqual([]);
    expect(ledgers.get('b')).toHaveLength(1);
    expect(ledgers.get('d')).toHaveLength(1);
  });

  it('resets a session on session_start, so the ledger holds one turn', async () => {
    const ledgers = new LedgerStore();
    ledgers.append('s1', record);
    ledgers.append('s2', record);

    await createLedgerReset(ledgers)({ sessionId: 's1', sessionKey: 'cli:x', platform: 'cli' });

    expect(ledgers.get('s1')).toEqual([]);
    expect(ledgers.get('s2')).toHaveLength(1);
  });

  it('returns an empty list for a session it never saw', () => {
    expect(new LedgerStore().get('nobody')).toEqual([]);
  });
});
