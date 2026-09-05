import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import { KanbanStore } from '@ethosagent/kanban-store';
import { isCheckLine } from '@ethosagent/safety-groundtruth';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import type { LLMProvider, Message, Storage, Tool, ToolContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKanbanTools } from '../index';
import { type CheckProbe, createCheckProbe } from '../probe';
import { createCompletionVerifier } from '../verifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake provider whose judge verdict is a fixed text_delta ('1' pass, '0' fail). */
function fakeProvider(verdict: string): LLMProvider {
  return {
    name: 'fake',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete() {
      yield { type: 'text_delta' as const, text: verdict };
      yield { type: 'done' as const, finishReason: 'end_turn' as const };
    },
    async countTokens() {
      return 0;
    },
  };
}

function makeCtx(personalityId?: string): ToolContext {
  return {
    sessionId: 'sess',
    sessionKey: 'cli:test',
    platform: 'test',
    workingDir: '/tmp',
    ...(personalityId !== undefined ? { personalityId } : {}),
    currentTurn: 0,
    messageCount: 0,
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resultBudgetChars: 80_000,
  };
}

function toolsByName(tools: Tool[]): Record<string, Tool> {
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

async function call<T = unknown>(tool: Tool, args: unknown, ctx: ToolContext): Promise<T> {
  const result = await tool.execute(args, ctx);
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return JSON.parse(result.value) as T;
}

// ---------------------------------------------------------------------------
// createCompletionVerifier — unit tests
// ---------------------------------------------------------------------------

describe('createCompletionVerifier', () => {
  it('returns { handled: false } when the judge passes the summary', async () => {
    const verify = createCompletionVerifier({ getProvider: async () => fakeProvider('1') });
    const result = await verify({
      taskId: 't1',
      summary: 'shipped the feature with tests',
      acceptanceCriteria: 'feature is shipped with tests',
    });
    expect(result).toEqual({ handled: false });
  });

  it('rejects with the criteria in the reason when the judge fails the summary', async () => {
    const verify = createCompletionVerifier({ getProvider: async () => fakeProvider('0') });
    const result = await verify({
      taskId: 't1',
      summary: 'did some unrelated work',
      acceptanceCriteria: 'output must contain SHIPPED',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('acceptance criteria');
    expect(result.reason).toContain('output must contain SHIPPED');
  });

  it('skips verification entirely when the payload has no acceptanceCriteria', async () => {
    let providerRequested = false;
    const verify = createCompletionVerifier({
      getProvider: async () => {
        providerRequested = true;
        return fakeProvider('0');
      },
    });
    const result = await verify({ taskId: 't1', summary: 'anything goes' });
    expect(result).toEqual({ handled: false });
    // The provider is never constructed on the no-criteria path.
    expect(providerRequested).toBe(false);
  });

  it('fails closed when the provider throws', async () => {
    const verify = createCompletionVerifier({
      getProvider: async () => {
        throw new Error('provider unavailable');
      },
    });
    const result = await verify({
      taskId: 't1',
      summary: 'shipped',
      acceptanceCriteria: 'anything',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('fail-closed');
    expect(result.reason).toContain('provider unavailable');
  });

  it('fails closed when the completion stream throws mid-scoring', async () => {
    const broken: LLMProvider = {
      ...fakeProvider('1'),
      // biome-ignore lint/correctness/useYield: the throw before any yield is the point
      async *complete() {
        throw new Error('stream exploded');
      },
    };
    const verify = createCompletionVerifier({ getProvider: async () => broken });
    const result = await verify({
      taskId: 't1',
      summary: 'shipped',
      acceptanceCriteria: 'anything',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('fail-closed');
  });

  it('ignores autonomyTier — a trusted assignee still gets rejected on a fail verdict', async () => {
    const verify = createCompletionVerifier({ getProvider: async () => fakeProvider('0') });
    const result = await verify({
      taskId: 't1',
      summary: 'trust me, it works',
      acceptanceCriteria: 'output must contain SHIPPED',
      autonomyTier: 'trusted',
    });
    expect(result.handled).toBe(true);
  });

  it('truncates long acceptance criteria in the rejection reason', async () => {
    const verify = createCompletionVerifier({ getProvider: async () => fakeProvider('0') });
    const longCriteria = 'x'.repeat(1_000);
    const result = await verify({
      taskId: 't1',
      summary: 'nope',
      acceptanceCriteria: longCriteria,
    });
    expect(result.handled).toBe(true);
    expect(result.reason?.length ?? 0).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Integration — verifier registered as a real before_ticket_complete handler
// gating kanban_complete against a real store
// ---------------------------------------------------------------------------

describe('completion verifier gating kanban_complete', () => {
  let store: KanbanStore;

  beforeEach(() => {
    store = new KanbanStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('failing verdict sends the ticket to needs_revision; re-claim bumps retry_count', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerClaiming(
      'before_ticket_complete',
      createCompletionVerifier({ getProvider: async () => fakeProvider('0') }),
    );
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({
      title: 'verified task',
      acceptanceCriteria: 'output must contain SHIPPED',
      maxRetries: 3,
    });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'did some work' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('needs_revision');

    // The rejection reason landed in the audit trail.
    const reasons = store
      .listEvents(t.id)
      .filter((e) => e.kind === 'status_changed')
      .map((e) => e.data.reason);
    expect(reasons.some((r) => typeof r === 'string' && r.includes('acceptance criteria'))).toBe(
      true,
    );

    // Re-claim counts against the retry budget (store invariant, unchanged here).
    expect(store.getTask(t.id)?.retryCount).toBe(0);
    const reclaimed = store.updateStatus(t.id, 'running');
    expect(reclaimed.status).toBe('running');
    expect(reclaimed.retryCount).toBe(1);
  });

  it('a task without acceptanceCriteria completes straight to done', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerClaiming(
      'before_ticket_complete',
      createCompletionVerifier({ getProvider: async () => fakeProvider('0') }),
    );
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'plain task' });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'anything goes' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('done');
  });

  it('passing verdict completes the ticket to done', async () => {
    const hooks = new DefaultHookRegistry();
    hooks.registerClaiming(
      'before_ticket_complete',
      createCompletionVerifier({ getProvider: async () => fakeProvider('1') }),
    );
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({ title: 'verified task', acceptanceCriteria: 'SHIPPED' });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'work is SHIPPED' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — `check:` ground-truth verification
// ---------------------------------------------------------------------------

const WORKDIR = '/work';

interface ProbeFixture {
  probe: CheckProbe;
  /** Every argv the probe was actually asked to execute. */
  spawned: string[][];
}

async function makeProbe(
  files: Record<string, string> = {},
  exitCode = 0,
  opts: { createWorkdir?: boolean } = {},
): Promise<ProbeFixture> {
  const storage: Storage = new InMemoryStorage();
  if (opts.createWorkdir !== false) await storage.mkdir(WORKDIR);
  for (const [name, content] of Object.entries(files)) {
    await storage.write(`${WORKDIR}/${name}`, content);
  }
  const spawned: string[][] = [];
  const probe = createCheckProbe({
    storage,
    workdir: WORKDIR,
    exec: async (argv: readonly string[]) => {
      spawned.push([...argv]);
      return exitCode;
    },
  });
  return { probe, spawned };
}

describe('check: verification — file verbs', () => {
  it('file_exists accepts when the file is there', async () => {
    const { probe } = await makeProbe({ 'report.pdf': 'x' });
    const verify = createCompletionVerifier({ probe });
    const result = await verify({
      taskId: 't1',
      summary: 'wrote the report',
      acceptanceCriteria: 'check: file_exists report.pdf',
    });
    expect(result).toEqual({ handled: false });
  });

  it('file_exists rejects and names the check and the workdir when it is not', async () => {
    const { probe } = await makeProbe();
    const verify = createCompletionVerifier({ probe });
    const result = await verify({
      taskId: 't1',
      summary: 'wrote the report',
      acceptanceCriteria: '- check: file_exists dist/report.pdf',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('check failed');
    expect(result.reason).toContain('file_exists dist/report.pdf');
    expect(result.reason).toContain(WORKDIR);
  });

  it('file_min_bytes accepts at the threshold and rejects below it', async () => {
    const { probe } = await makeProbe({ 'out.txt': '0123456789' });
    const pass = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 's',
      acceptanceCriteria: 'check: file_min_bytes out.txt 10',
    });
    expect(pass).toEqual({ handled: false });

    const fail = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 's',
      acceptanceCriteria: 'check: file_min_bytes out.txt 11',
    });
    expect(fail.handled).toBe(true);
    expect(fail.reason).toContain('10 bytes, expected at least 11');
  });

  it('file_contains accepts on a hit and rejects on a miss', async () => {
    const { probe } = await makeProbe({ 'log.txt': 'build SHIPPED ok' });
    const pass = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 's',
      acceptanceCriteria: 'check: file_contains log.txt SHIPPED',
    });
    expect(pass).toEqual({ handled: false });

    const fail = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 's',
      acceptanceCriteria: 'check: file_contains log.txt REVERTED',
    });
    expect(fail.handled).toBe(true);
    expect(fail.reason).toContain('does not contain "REVERTED"');
  });

  it('rejects a path that escapes the verification workdir', async () => {
    const { probe } = await makeProbe();
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 's',
      acceptanceCriteria: 'check: file_contains ../../etc/passwd root',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('escapes the verification workdir');
  });

  it('asks only for metadata when the verb is a metadata question', async () => {
    // `check: file_exists dist/bundle.js` must not cost the bundle. A probe
    // that reads the whole file to answer "is it there" turns a
    // constant-time question into I/O and heap proportional to a build
    // artifact.
    const storage = new InMemoryStorage();
    await storage.mkdir(WORKDIR);
    await storage.write(`${WORKDIR}/big.bin`, 'x'.repeat(4096));
    const reads: string[] = [];
    const counting: Storage = Object.create(storage, {
      readBytes: {
        value: async (path: string) => {
          reads.push(path);
          return storage.readBytes(path);
        },
      },
    });
    const probe = createCheckProbe({ storage: counting, workdir: WORKDIR });

    expect(await probe.exists('big.bin')).toBe(true);
    expect(reads).toEqual([]);

    // `file_contains` genuinely needs the bytes; `Storage` cannot express a
    // bounded or streaming read, so this one read is expected.
    expect(await probe.contains('big.bin', 'xxx')).toBe(true);
    expect(reads).toEqual([`${WORKDIR}/big.bin`]);
  });
});

// ---------------------------------------------------------------------------
// A directory is not a file. `Storage.exists` is true for one, so a bare
// existence test let `check: file_exists dist/report.pdf` pass on a DIRECTORY
// carrying the artifact's name — and move the ticket to done on an artifact
// nobody produced.
// ---------------------------------------------------------------------------

describe('check: verification — a directory is not the artifact', () => {
  async function withDirectory(): Promise<CheckProbe> {
    const storage: Storage = new InMemoryStorage();
    await storage.mkdir(`${WORKDIR}/dist/report.pdf`);
    return createCheckProbe({ storage, workdir: WORKDIR });
  }

  it('rejects file_exists on a directory carrying the artifact name', async () => {
    const probe = await withDirectory();
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 'produced the report',
      acceptanceCriteria: 'check: file_exists dist/report.pdf',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('file_exists dist/report.pdf');
    expect(result.reason).toContain('is a directory, not a file');
  });

  it('rejects file_min_bytes on a directory — a directory has no byte length', async () => {
    const probe = await withDirectory();
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 'produced the report',
      acceptanceCriteria: 'check: file_min_bytes dist/report.pdf 100',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('is a directory, not a file');
  });

  it('rejects file_contains on a directory rather than reading one', async () => {
    const probe = await withDirectory();
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 'produced the report',
      acceptanceCriteria: 'check: file_contains dist/report.pdf SHIPPED',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('is a directory, not a file');
  });

  it('says "is a directory" and not the generic miss, so the author looks in the right place', async () => {
    const probe = await withDirectory();
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 'produced the report',
      acceptanceCriteria: 'check: file_exists dist/report.pdf',
    });
    expect(result.reason).not.toContain('no such file');
  });

  it('still answers for a real file beside it', async () => {
    const storage: Storage = new InMemoryStorage();
    await storage.mkdir(`${WORKDIR}/dist`);
    await storage.write(`${WORKDIR}/dist/report.pdf`, 'SHIPPED');
    const probe = createCheckProbe({ storage, workdir: WORKDIR });

    expect(await probe.exists('dist/report.pdf')).toBe(true);
    expect(await probe.size('dist/report.pdf')).toBe(7);
    expect(await probe.contains('dist/report.pdf', 'SHIPPED')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Symbolic containment — the `check:` DSL is agent-writable, so a check path
// that resolves outside the workdir through a symlink is an exfiltration
// oracle over any file this process can read. These need a REAL filesystem:
// a symlink is a filesystem fact and `InMemoryStorage` has no such concept.
// ---------------------------------------------------------------------------

describe('check: verification — symbolic containment', () => {
  let root: string;
  let workdir: string;
  let secretPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ethos-probe-'));
    workdir = join(root, 'work');
    await mkdir(workdir, { recursive: true });
    secretPath = join(root, 'secret.env');
    await writeFile(secretPath, 'TOKEN=sk-live-abc\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function verbs(probe: CheckProbe): Array<[string, () => Promise<unknown>]> {
    return [
      ['file_exists', () => probe.exists('leak/secret.env')],
      ['file_min_bytes', () => probe.size('leak/secret.env')],
      ['file_contains', () => probe.contains('leak/secret.env', 'sk-live')],
    ];
  }

  it('refuses every file verb on a symlinked LEAF inside the workdir', async () => {
    await symlink(secretPath, join(workdir, 'secret.env'));
    const probe = createCheckProbe({ storage: new FsStorage(), workdir });

    for (const [verb, call] of [
      ['file_exists', () => probe.exists('secret.env')],
      ['file_min_bytes', () => probe.size('secret.env')],
      ['file_contains', () => probe.contains('secret.env', 'sk-live')],
    ] as Array<[string, () => Promise<unknown>]>) {
      await expect(call(), verb).rejects.toThrow(/not permitted|symbolic link/);
    }
  });

  it('refuses every file verb on a symlinked PARENT directory', async () => {
    // The leaf is an ordinary file; the escape is one level up. A leaf-only
    // check passes this and reads the secret.
    await symlink(root, join(workdir, 'leak'));
    const probe = createCheckProbe({ storage: new FsStorage(), workdir });

    for (const [verb, call] of verbs(probe)) {
      await expect(call(), verb).rejects.toThrow(/not permitted|symbolic link/);
    }
  });

  it('still answers for an ordinary file inside the workdir', async () => {
    await writeFile(join(workdir, 'report.txt'), 'SHIPPED');
    const probe = createCheckProbe({ storage: new FsStorage(), workdir });

    expect(await probe.exists('report.txt')).toBe(true);
    expect(await probe.size('report.txt')).toBe(7);
    expect(await probe.contains('report.txt', 'SHIPPED')).toBe(true);
    expect(await probe.exists('absent.txt')).toBe(false);
    expect(await probe.size('absent.txt')).toBeNull();
    expect(await probe.contains('absent.txt', 'x')).toBeNull();
  });
});

describe('check: verification — fail-closed paths', () => {
  it('rejects a malformed check line rather than silently skipping it', async () => {
    const { probe } = await makeProbe();
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 'all good',
      acceptanceCriteria: 'check: file_exsits report.pdf',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('unrecognised check line');
    expect(result.reason).toContain('check: file_exsits report.pdf');
    // The message carries the fix, so the author does not have to find docs.
    expect(result.reason).toContain('file_min_bytes <path> <n>');
  });

  it('rejects when the verification workdir does not exist', async () => {
    const { probe } = await makeProbe({}, 0, { createWorkdir: false });
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 'all good',
      acceptanceCriteria: 'check: file_exists report.pdf',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('verification workdir does not exist');
    expect(result.reason).toContain(WORKDIR);
  });

  it('rejects checks when no probe is configured at all', async () => {
    const result = await createCompletionVerifier({})({
      taskId: 't1',
      summary: 'all good',
      acceptanceCriteria: 'check: file_exists report.pdf',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('no verification workdir');
    expect(result.reason).toContain('file_exists report.pdf');
  });
});

describe('check: run — the allowlist', () => {
  it('refuses a run check whose command is not allowlisted, and never spawns it', async () => {
    const { probe, spawned } = await makeProbe();
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 'cleaned up',
      acceptanceCriteria: 'check: run rm -rf / exit 0',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('allowedCheckCommands');
    expect(result.reason).toContain('rm -rf /');
    // The refusal happens BEFORE the probe — a non-allowlisted command is
    // never handed to anything that could run it.
    expect(spawned).toEqual([]);
  });

  it('still refuses rm -rf / when an unrelated command IS allowlisted', async () => {
    const { probe, spawned } = await makeProbe();
    const result = await createCompletionVerifier({
      probe,
      allowedCheckCommands: ['pnpm test'],
    })({
      taskId: 't1',
      summary: 'cleaned up',
      acceptanceCriteria: 'check: run rm -rf / exit 0',
    });
    expect(result.handled).toBe(true);
    expect(spawned).toEqual([]);
  });

  it('runs the allowlisted command when it matches an entry exactly', async () => {
    const { probe, spawned } = await makeProbe({}, 0);
    const result = await createCompletionVerifier({
      probe,
      allowedCheckCommands: ['pnpm test'],
    })({
      taskId: 't1',
      summary: 'tests pass',
      acceptanceCriteria: 'check: run pnpm test exit 0',
    });
    expect(result).toEqual({ handled: false });
    expect(spawned).toEqual([['pnpm', 'test']]);
  });

  // The allowlist is the WHOLE authorization. It used to admit a leading-token
  // prefix, which handed the agent — the author of `acceptanceCriteria` — the
  // rest of the argument vector. `shell: false` stops command INJECTION and
  // does nothing about ARGUMENT ABUSE, which is where the reach actually is:
  // `pnpm test --config <anything>.js` has a test runner load an
  // agent-chosen file, and `node -e '<any program>'` needs no file at all.
  it('refuses an allowlisted program carrying an agent-appended argument', async () => {
    const cases: Array<[string, string]> = [
      ['pnpm test', 'pnpm test --config attacker.js'],
      ['node', "node -e require('fs').writeFileSync('/tmp/pwned','x')"],
    ];
    for (const [entry, command] of cases) {
      const { probe, spawned } = await makeProbe({}, 0);
      const result = await createCompletionVerifier({
        probe,
        allowedCheckCommands: [entry],
      })({
        taskId: 't1',
        summary: 'ran it',
        acceptanceCriteria: `check: run ${command} exit 0`,
      });
      expect(result.handled).toBe(true);
      expect(result.reason).toContain('does not exactly match');
      // Refused BEFORE the probe: nothing that could execute it ever saw it.
      expect(spawned).toEqual([]);
    }
  });

  it('does not let a same-prefix-looking different command through', async () => {
    const { probe, spawned } = await makeProbe();
    const result = await createCompletionVerifier({
      probe,
      allowedCheckCommands: ['pnpm test'],
    })({
      taskId: 't1',
      summary: 'published',
      acceptanceCriteria: 'check: run pnpm publish exit 0',
    });
    expect(result.handled).toBe(true);
    expect(spawned).toEqual([]);
  });

  it('rejects when the allowlisted command exits with the wrong code', async () => {
    const { probe } = await makeProbe({}, 1);
    const result = await createCompletionVerifier({
      probe,
      allowedCheckCommands: ['pnpm test'],
    })({
      taskId: 't1',
      summary: 'tests pass',
      acceptanceCriteria: 'check: run pnpm test exit 0',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('run pnpm test exit 0');
    expect(result.reason).toContain('exited 1, expected 0');
  });

  it('takes the LAST exit token, so a command containing "exit" is unambiguous', async () => {
    const { probe, spawned } = await makeProbe({}, 3);
    const result = await createCompletionVerifier({
      probe,
      allowedCheckCommands: ['node -e process.exit(3)'],
    })({
      taskId: 't1',
      summary: 'ran it',
      acceptanceCriteria: 'check: run node -e process.exit(3) exit 3',
    });
    expect(result).toEqual({ handled: false });
    expect(spawned).toEqual([['node', '-e', 'process.exit(3)']]);
  });

  // The probe has NO execution route of its own any more. `run` used to spawn
  // through `node:child_process` right here, which made ticket completion a
  // second way to run a command on the host — outside the execution posture,
  // the mount confinement and the binary allowlist every other command obeys.
  // Wiring injects the governed route (`createCheckRunExec`); absent one, an
  // allowlisted command is still not executed.
  it('fails closed when no execution route is injected, even for an allowlisted command', async () => {
    const storage: Storage = new InMemoryStorage();
    await storage.mkdir(process.cwd());
    const probe = createCheckProbe({ storage, workdir: process.cwd() });
    const result = await createCompletionVerifier({
      probe,
      allowedCheckCommands: ['node -e process.exit(3)'],
    })({
      taskId: 't1',
      summary: 'ran it',
      acceptanceCriteria: 'check: run node -e process.exit(3) exit 3',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('no execution route is configured');
  });

  it('this package cannot spawn at all — nothing in it imports child_process', () => {
    const src = join(import.meta.dirname, '..');
    const sources = readdirSync(src, { recursive: true, encoding: 'utf-8' }).filter(
      (name) => name.endsWith('.ts') && !name.includes('__tests__'),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      expect(readFileSync(join(src, name), 'utf-8')).not.toMatch(
        /(?:from|require\()\s*['"](?:node:)?child_process['"]/,
      );
    }
  });
});

describe('checks and the LLM judge compose', () => {
  it('solo (no provider) accepts prose-only criteria exactly as before', async () => {
    const { probe } = await makeProbe();
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 'did some unrelated work',
      acceptanceCriteria: 'the report should read nicely',
    });
    expect(result).toEqual({ handled: false });
  });

  it('solo (no provider) still settles checks', async () => {
    const { probe } = await makeProbe();
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 'wrote it',
      acceptanceCriteria: 'the report should read nicely\ncheck: file_exists report.pdf',
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('file_exists report.pdf');
  });

  it('team prose still reaches the judge, with the check lines stripped out', async () => {
    const { probe } = await makeProbe({ 'report.pdf': 'x' });
    let judged: string | undefined;
    const verify = createCompletionVerifier({
      probe,
      getProvider: async () => ({
        ...fakeProvider('1'),
        async *complete(messages: Message[]) {
          judged = messages.map((m) => String(m.content)).join('\n');
          yield { type: 'text_delta' as const, text: '1' };
          yield { type: 'done' as const, finishReason: 'end_turn' as const };
        },
      }),
    });
    const result = await verify({
      taskId: 't1',
      summary: 'wrote the report',
      acceptanceCriteria: 'check: file_exists report.pdf\nthe report reads nicely',
    });
    expect(result).toEqual({ handled: false });
    expect(judged).toContain('the report reads nicely');
    expect(judged).not.toContain('file_exists');
  });

  // A bare `check:` used to match neither the grammar nor the invalid path: no
  // check ran, no line was reported, and solo — where nothing sits behind the
  // checks — the completion was accepted outright. The gate exists to fail
  // closed; it cannot have a spelling that opens it.
  it.each([
    ['a bare check line', 'check:'],
    ['a check line of nothing but spaces', 'check:   '],
    ['a check line whose body is junk', 'check: teleport there'],
  ])('rejects the completion on %s, solo and with no judge behind it', async (_label, line) => {
    const { probe } = await makeProbe();
    const result = await createCompletionVerifier({ probe })({
      taskId: 't1',
      summary: 'all done',
      acceptanceCriteria: line,
    });
    expect(result.handled).toBe(true);
    expect(result.reason).toContain('unrecognised check line');
  });

  // The stripper and the parser must recognise the same lines. If the stripper
  // took a bare `check:` for prose, a criterion the parser never settled would
  // be handed to the judge as if it were one; if the parser took it and the
  // stripper did not, the judge would be asked to re-litigate a settled fact.
  it('the prose handed to the judge is exactly the lines isCheckLine leaves', async () => {
    const { probe } = await makeProbe({ 'report.pdf': 'x' });
    let judged: string | undefined;
    const verify = createCompletionVerifier({
      probe,
      getProvider: async () => ({
        ...fakeProvider('1'),
        async *complete(messages: Message[]) {
          judged = messages.map((m) => String(m.content)).join('\n');
          yield { type: 'text_delta' as const, text: '1' };
          yield { type: 'done' as const, finishReason: 'end_turn' as const };
        },
      }),
    });
    const criteria = ['check: file_exists report.pdf', 'the report reads nicely'];
    const result = await verify({
      taskId: 't1',
      summary: 'wrote the report',
      acceptanceCriteria: criteria.join('\n'),
    });
    expect(result).toEqual({ handled: false });
    const prose = criteria.filter((line) => !isCheckLine(line)).join('\n');
    expect(judged).toContain(prose);
    expect(judged).not.toContain('check:');
  });

  it('a failing check rejects before the judge is ever constructed', async () => {
    const { probe } = await makeProbe();
    let providerRequested = false;
    const result = await createCompletionVerifier({
      probe,
      getProvider: async () => {
        providerRequested = true;
        return fakeProvider('1');
      },
    })({
      taskId: 't1',
      summary: 'wrote the report',
      acceptanceCriteria: 'check: file_exists report.pdf\nthe report reads nicely',
    });
    expect(result.handled).toBe(true);
    expect(providerRequested).toBe(false);
  });

  it('criteria that are nothing but passing checks never call the judge', async () => {
    const { probe } = await makeProbe({ 'report.pdf': 'x' });
    let providerRequested = false;
    const result = await createCompletionVerifier({
      probe,
      getProvider: async () => {
        providerRequested = true;
        return fakeProvider('0');
      },
    })({
      taskId: 't1',
      summary: 'wrote the report',
      acceptanceCriteria: 'check: file_exists report.pdf',
    });
    expect(result).toEqual({ handled: false });
    expect(providerRequested).toBe(false);
  });
});

describe('a failing check reaches the ticket audit trail', () => {
  let store: KanbanStore;

  beforeEach(() => {
    store = new KanbanStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('sends the ticket to needs_revision with the failing check named', async () => {
    const { probe } = await makeProbe();
    const hooks = new DefaultHookRegistry();
    hooks.registerClaiming('before_ticket_complete', createCompletionVerifier({ probe }));
    const tools = toolsByName(createKanbanTools({ store, hooks }));

    const t = store.createTask({
      title: 'produce the report',
      acceptanceCriteria: 'check: file_exists dist/report.pdf',
    });
    store.updateStatus(t.id, 'running');

    const out = await call<{ status: string }>(
      tools.kanban_complete as Tool,
      { task_id: t.id, summary: 'the report is written' },
      makeCtx('engineer'),
    );
    expect(out.status).toBe('needs_revision');

    const reasons = store
      .listEvents(t.id)
      .filter((e) => e.kind === 'status_changed')
      .map((e) => e.data.reason);
    expect(
      reasons.some((r) => typeof r === 'string' && r.includes('file_exists dist/report.pdf')),
    ).toBe(true);
  });
});

describe('grounding.kanban.checks — the master switch', () => {
  it('checks: false leaves criteria to the judge exactly as before the pass existed', async () => {
    const { probe, spawned } = await makeProbe();
    let judged: string | undefined;
    const result = await createCompletionVerifier({
      probe,
      checks: false,
      getProvider: async () => ({
        ...fakeProvider('1'),
        async *complete(messages: Message[]) {
          judged = messages.map((m) => String(m.content)).join('\n');
          yield { type: 'text_delta' as const, text: '1' };
          yield { type: 'done' as const, finishReason: 'end_turn' as const };
        },
      }),
    })({
      taskId: 't1',
      summary: 'wrote the report',
      acceptanceCriteria: 'check: file_exsits report.pdf\nthe report reads nicely',
    });
    // A malformed line does not reject and a real one does not run: off is off.
    expect(result).toEqual({ handled: false });
    expect(spawned).toEqual([]);
    expect(judged).toContain('file_exsits');
  });

  it('checks: false with no provider accepts, as a solo deployment did before', async () => {
    const { probe } = await makeProbe();
    const result = await createCompletionVerifier({ probe, checks: false })({
      taskId: 't1',
      summary: 'wrote the report',
      acceptanceCriteria: 'check: file_exists dist/report.pdf',
    });
    expect(result).toEqual({ handled: false });
  });
});
