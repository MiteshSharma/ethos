// Integration tests for the framed stdio RPC transport (tools-as-code-api
// Lane A), driven end-to-end through a real `--network none` container.
// Docker-gated like the execution-docker suites: they run only when the
// daemon is up AND a digest-pinned image with the runtime is provided via
// ETHOS_TEST_DOCKER_PYTHON_IMAGE / ETHOS_TEST_DOCKER_NODE_IMAGE (images must
// be present locally — the backend passes --pull=never).

import { DockerExecutionBackend, ExecTimeoutError } from '@ethosagent/execution-docker';
import type {
  ExecChunk,
  ExecRpcRequest,
  ExecutionBackend,
  Logger,
  SecretsResolver,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildShimCommand } from '../shim';

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
const nodeImage = process.env.ETHOS_TEST_DOCKER_NODE_IMAGE;

function makeBackend(image: string): ExecutionBackend {
  return new DockerExecutionBackend({
    config: { images: { default: image } },
    secrets: secretsStub,
    logger: loggerStub,
  });
}

async function drain(
  stream: AsyncIterable<ExecChunk>,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  for await (const chunk of stream) {
    if (chunk.stream === 'exit') exitCode = chunk.code;
    else if (chunk.stream === 'stdout') stdout += chunk.data;
    else stderr += chunk.data;
  }
  return { stdout, stderr, exitCode };
}

describe.skipIf(!dockerAvailable || !pyImage)('shim RPC over docker — python', () => {
  it('a script calls ethos.call() served by a stub onRequest inside --network none', {
    timeout: 120_000,
  }, async () => {
    const be = makeBackend(pyImage as string);
    const calls: ExecRpcRequest[] = [];
    const script = [
      'import ethos',
      "r = ethos.call('echo_fixture', {'msg': 'hi'})",
      "print(r['ok'], r['value'])",
    ].join('\n');
    // No personality → no mounts, and resolveNetworkMode(undefined) → 'none'.
    const result = await drain(
      be.exec(buildShimCommand('python'), {
        stdin: script,
        timeoutMs: 60_000,
        env: {},
        rpc: {
          onRequest: async (req) => {
            calls.push(req);
            return { ok: true, value: `echo:${(req.args as { msg: string }).msg}` };
          },
        },
      }),
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('True echo:hi\n');
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{ name: 'echo_fixture', args: { msg: 'hi' } }]);
  });

  it('an ok:false response reaches the script as data', { timeout: 120_000 }, async () => {
    const be = makeBackend(pyImage as string);
    const script = [
      'import ethos',
      "r = ethos.call('forbidden_tool')",
      "print(r['ok'], r['error'], r['code'])",
    ].join('\n');
    const result = await drain(
      be.exec(buildShimCommand('python'), {
        stdin: script,
        timeoutMs: 60_000,
        env: {},
        rpc: {
          onRequest: async () => ({ ok: false, error: 'no such tool', code: 'not_available' }),
        },
      }),
    );
    expect(result.stdout).toBe('False no such tool not_available\n');
    expect(result.exitCode).toBe(0);
  });

  it('a no-RPC script is byte-identical to the pre-change path', { timeout: 120_000 }, async () => {
    const be = makeBackend(pyImage as string);
    // No opts.rpc → the plain interpreter path run_code uses today.
    const result = await drain(
      be.exec('python3 -', {
        stdin: "import sys\nprint('plain out')\nsys.stderr.write('plain err\\n')",
        timeoutMs: 60_000,
        env: {},
      }),
    );
    expect(result.stdout).toBe('plain out\n');
    expect(result.stderr).toBe('plain err\n');
    expect(result.exitCode).toBe(0);
  });

  it('a pending RPC at kill-time rejects cleanly (no host hang)', {
    timeout: 120_000,
  }, async () => {
    const be = makeBackend(pyImage as string);
    const script = "import ethos\nethos.call('hang')\nprint('unreachable')";
    const started = Date.now();
    await expect(
      drain(
        be.exec(buildShimCommand('python'), {
          stdin: script,
          timeoutMs: 10_000,
          env: {},
          rpc: { onRequest: () => new Promise(() => {}) }, // never resolves
        }),
      ),
    ).rejects.toBeInstanceOf(ExecTimeoutError);
    // Bounded by the exec timeout, not wedged on the pending handler.
    expect(Date.now() - started).toBeLessThan(60_000);
  });
});

describe.skipIf(!dockerAvailable || !nodeImage)('shim RPC over docker — js', () => {
  it('a script calls the synchronous ethos.call() inside --network none', {
    timeout: 120_000,
  }, async () => {
    const be = makeBackend(nodeImage as string);
    const calls: ExecRpcRequest[] = [];
    const script = [
      "const r = ethos.call('echo_fixture', { msg: 'hi' });",
      'console.log(r.ok, r.value);',
    ].join('\n');
    const result = await drain(
      be.exec(buildShimCommand('js'), {
        stdin: script,
        timeoutMs: 60_000,
        env: {},
        rpc: {
          onRequest: async (req) => {
            calls.push(req);
            return { ok: true, value: `echo:${(req.args as { msg: string }).msg}` };
          },
        },
      }),
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('true echo:hi\n');
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{ name: 'echo_fixture', args: { msg: 'hi' } }]);
  });
});
