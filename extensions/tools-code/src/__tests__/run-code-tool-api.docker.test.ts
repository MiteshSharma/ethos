// tools-as-code-api Lane B/D end-to-end: a REAL `--network none` container, a
// REAL ScriptToolBridge over a personality-toolset-restricted registry. A
// python script loops ethos.call('read_file', ...) over several files and
// prints only an aggregate — the intermediate file contents must never enter
// the run_code result. Docker-gated exactly like shim-rpc.docker.test.ts:
// runs only when the daemon is up AND ETHOS_TEST_DOCKER_PYTHON_IMAGE names a
// locally-present digest-pinned image.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkTurnBudgets,
  createTurnBudgetCounters,
  DefaultHookRegistry,
  DefaultToolRegistry,
  makeTestToolContext,
  ScriptToolBridge,
} from '@ethosagent/core';
import { DockerExecutionBackend } from '@ethosagent/execution-docker';
import type { Logger, SecretsResolver, Tool, ToolContext } from '@ethosagent/types';
import { afterAll, describe, expect, it } from 'vitest';
import { createCodeTools } from '../index';

const secretsStub: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const loggerStub: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => loggerStub,
};

async function dockerInfoOk(): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  return new Promise<boolean>((resolve) => {
    try {
      const c = spawn('docker', ['info'], { stdio: 'ignore' });
      c.on('close', (code) => resolve(code === 0));
      c.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

const dockerAvailable = await dockerInfoOk();
const pyImage = process.env.ETHOS_TEST_DOCKER_PYTHON_IMAGE;

// Sentinel file contents — long enough that leaking any single file into the
// run_code result would be unmistakable.
const SENTINEL = 'SENTINEL_FILE_CONTENT_';
const dir = mkdtempSync(join(tmpdir(), 'ethos-tool-api-'));
const files = ['f1.txt', 'f2.txt', 'f3.txt'];
for (const [i, f] of files.entries()) {
  writeFileSync(join(dir, f), `${SENTINEL}${i}_${'x'.repeat(500)}`);
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Host-side read_file fixture — stands in for the real file toolset. */
const readFileTool: Tool = {
  name: 'read_file',
  description: 'read a file',
  schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  capabilities: {},
  execute: async (args) => {
    const { path } = args as { path: string };
    try {
      return { ok: true, value: await readFile(path, 'utf-8') };
    } catch (err) {
      return { ok: false, error: String(err), code: 'execution_failed' };
    }
  },
};

/** Registered but OUTSIDE the personality toolset — the script must not reach it. */
const writeFileTool: Tool = {
  name: 'write_file',
  description: 'write a file',
  schema: { type: 'object' },
  capabilities: {},
  execute: async () => ({ ok: true, value: 'wrote' }),
};

function makeHarness(image: string) {
  const backend = new DockerExecutionBackend({
    config: { images: { default: image } },
    secrets: secretsStub,
    logger: loggerStub,
  });
  const tools = new DefaultToolRegistry({});
  for (const t of createCodeTools({ backend })) tools.register(t);
  tools.register(readFileTool);
  tools.register(writeFileTool);
  const allowedTools = ['run_code', 'read_file']; // the personality toolset
  const counters = createTurnBudgetCounters();
  const bridge = new ScriptToolBridge({
    tools,
    hooks: new DefaultHookRegistry(),
    sessionId: 'docker-e2e',
    traceId: undefined,
    allowedTools,
    allowedPlugins: [],
    filterOpts: {},
    watcherTap: { observe: () => {}, getHalt: () => null },
    counters,
    checkBudgets: () =>
      checkTurnBudgets(
        counters.totalToolCalls,
        1000,
        counters.toolNameCounts,
        1000,
        counters.identicalStreak,
        1000,
      ),
  });
  const base = makeTestToolContext();
  const ctx: ToolContext = { ...base, scriptTools: bridge.bind(() => ctx) };
  return { backend, tools, ctx, counters };
}

describe.skipIf(!dockerAvailable || !pyImage)('run_code tool API over docker — python', () => {
  it('loops ethos.call(read_file) over files in --network none and only the aggregate enters the result', {
    timeout: 180_000,
  }, async () => {
    const { backend, tools, ctx, counters } = makeHarness(pyImage as string);
    try {
      const paths = files.map((f) => join(dir, f));
      const script = [
        'import ethos',
        `paths = ${JSON.stringify(paths)}`,
        'total = 0',
        'for p in paths:',
        "    r = ethos.call('read_file', {'path': p})",
        "    assert r['ok'], r",
        "    total += len(r['value'])",
        // A call OUTSIDE the personality toolset fails as data, not a crash.
        "denied = ethos.call('write_file', {'path': 'x', 'content': 'y'})",
        "print('AGGREGATE files=%d chars=%d denied=%s' % (len(paths), total, denied['error']))",
      ].join('\n');
      const runCode = tools.get('run_code');
      const result = await runCode?.execute(
        { runtime: 'python', code: script, timeout_ms: 120_000 },
        ctx,
      );
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        const perFileChars = SENTINEL.length + 2 + 500; // sentinel + index + '_' + payload
        expect(result.value).toContain(`AGGREGATE files=3 chars=${3 * perFileChars}`);
        expect(result.value).toContain(
          'denied=Tool write_file is not permitted for this personality',
        );
        // The intermediate tool results never entered the run_code result.
        expect(result.value).not.toContain(SENTINEL);
      }
      // All script calls flowed through the SHARED turn counters.
      expect(counters.totalToolCalls).toBe(3);
      expect(counters.toolNameCounts.get('read_file')).toBe(3);
    } finally {
      await backend.dispose();
    }
  });

  it('a watcher terminate mid-script kills the container and run_code fails with the reason', {
    timeout: 180_000,
  }, async () => {
    const backend = new DockerExecutionBackend({
      config: { images: { default: pyImage as string } },
      secrets: secretsStub,
      logger: loggerStub,
    });
    try {
      const tools = new DefaultToolRegistry({});
      for (const t of createCodeTools({ backend })) tools.register(t);
      tools.register(readFileTool);
      const counters = createTurnBudgetCounters();
      let starts = 0;
      const bridge = new ScriptToolBridge({
        tools,
        hooks: new DefaultHookRegistry(),
        sessionId: 'docker-e2e-watcher',
        traceId: undefined,
        allowedTools: ['run_code', 'read_file'],
        allowedPlugins: [],
        filterOpts: {},
        watcherTap: {
          observe: (event) => {
            if (event.type === 'tool_start') starts++;
          },
          getHalt: () =>
            starts >= 2
              ? { action: 'terminate', rule: 'hot-loop', reason: 'watcher says stop' }
              : null,
        },
        counters,
        checkBudgets: () =>
          checkTurnBudgets(
            counters.totalToolCalls,
            1000,
            counters.toolNameCounts,
            1000,
            counters.identicalStreak,
            1000,
          ),
      });
      const base = makeTestToolContext();
      const ctx: ToolContext = { ...base, scriptTools: bridge.bind(() => ctx) };
      const script = [
        'import ethos',
        'for i in range(10):',
        `    ethos.call('read_file', {'path': ${JSON.stringify(join(dir, 'f1.txt'))}})`,
        "print('unreachable')",
      ].join('\n');
      const started = Date.now();
      const result = await tools
        .get('run_code')
        ?.execute({ runtime: 'python', code: script, timeout_ms: 120_000 }, ctx);
      expect(result?.ok).toBe(false);
      if (result && !result.ok) {
        expect(result.error).toContain('watcher says stop');
      }
      // Killed by the abort, not the 120s wall clock.
      expect(Date.now() - started).toBeLessThan(110_000);
    } finally {
      await backend.dispose();
    }
  });

  it('no-bridge: import ethos fails as a normal interpreter error, no hang', {
    timeout: 180_000,
  }, async () => {
    const backend = new DockerExecutionBackend({
      config: { images: { default: pyImage as string } },
      secrets: secretsStub,
      logger: loggerStub,
    });
    try {
      const [runCode] = createCodeTools({ backend });
      const result = await runCode.execute(
        { runtime: 'python', code: "import ethos\nprint('nope')", timeout_ms: 60_000 },
        makeTestToolContext(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('execution_failed');
        expect(result.error).toContain('ModuleNotFoundError');
      }
    } finally {
      await backend.dispose();
    }
  });
});
