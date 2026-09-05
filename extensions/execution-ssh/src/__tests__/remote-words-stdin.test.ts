import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildRemoteWords } from '../index';

/**
 * The claim the HIGH-1 fix rests on, executed rather than asserted.
 *
 * `buildRemoteWords` used to discard the remote cwd whenever `opts.shell` was
 * `false` — which is every `run_code` call — on the theory that an `sh -c` wrap
 * would eat the stdin a stdin-driven runner reads its program from. That theory
 * is wrong: `sh -c` does not consume its child's stdin, so the runner still
 * inherits the descriptor.
 *
 * These tests prove it end to end with a REAL shell. `node:child_process` is
 * deliberately NOT mocked here (unlike `ssh.test.ts`) — a mock could not falsify
 * the claim. Nothing connects to anything: the local `sh` stands in for the
 * remote LOGIN shell, receiving the remote words joined by spaces exactly as ssh
 * hands them over.
 */
function runAsRemoteLoginShell(
  words: readonly string[],
  stdin: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // ssh joins its remote words with spaces and hands the result to the remote
    // login shell, which parses it. This is that step, locally.
    const child = spawn('sh', ['-c', words.join(' ')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.write(stdin, 'utf-8');
    child.stdin.end();
  });
}

const dirs: string[] = [];
function scratchDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ethos-ssh-${name}-`));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('remote words actually executed by a real shell', () => {
  it('delivers stdin to a `sh -s` runner AND applies remoteWorkdir', async () => {
    const workdir = scratchDir('workdir');
    const words = buildRemoteWords({ host: 'h', remoteWorkdir: workdir }, 'sh -s', {
      shell: false,
    });
    const result = await runAsRemoteLoginShell(
      words,
      'printf "%s|%s\\n" STDIN_REACHED_RUNNER "$PWD"\n',
    );
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(`STDIN_REACHED_RUNNER|${workdir}`);
    expect(result.code).toBe(0);
  });

  it('delivers stdin to `node --input-type=module` AND applies remoteWorkdir', async () => {
    const workdir = scratchDir('node');
    // `run_code` sends the bare word `node`; `process.execPath` is the same
    // interpreter without depending on the test runner's PATH.
    const words = buildRemoteWords(
      { host: 'h', remoteWorkdir: workdir },
      `'${process.execPath}' --input-type=module`,
      { shell: false },
    );
    const result = await runAsRemoteLoginShell(
      words,
      "console.log('STDIN_REACHED_RUNNER|' + process.cwd());\n",
    );
    expect(result.stdout.trim()).toBe(`STDIN_REACHED_RUNNER|${workdir}`);
    expect(result.code).toBe(0);
  });

  it('propagates the runner exit status through the `exec` wrap', async () => {
    const workdir = scratchDir('exit');
    const words = buildRemoteWords({ host: 'h', remoteWorkdir: workdir }, 'sh -s', {
      shell: false,
    });
    // `exec` replaces the wrapping shell, so this IS the runner's own status —
    // not a shell reporting a child's.
    const result = await runAsRemoteLoginShell(words, 'exit 7\n');
    expect(result.code).toBe(7);
  });

  it('survives an embedded single quote in the workdir, wrapped and unwrapped alike', async () => {
    const parent = scratchDir('quote');
    const workdir = join(parent, "o'brien's dir");
    await runAsRemoteLoginShell(
      buildRemoteWords({ host: 'h' }, 'sh -s', {}),
      `mkdir -p '${workdir.replaceAll("'", `'\\''`)}'\n`,
    );
    const stdinDriven = buildRemoteWords({ host: 'h', remoteWorkdir: workdir }, 'sh -s', {
      shell: false,
    });
    const result = await runAsRemoteLoginShell(stdinDriven, 'printf "%s\\n" "$PWD"\n');
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(workdir);

    // Same for the shell:true path, whose quoting this fix must not disturb.
    const shellDriven = buildRemoteWords(
      { host: 'h', remoteWorkdir: workdir },
      'printf "%s\\n" "$PWD"',
      {},
    );
    const wrapped = await runAsRemoteLoginShell(shellDriven, '');
    expect(wrapped.stdout.trim()).toBe(workdir);
  });

  it('parses a command containing a single quote exactly once, on both paths', async () => {
    const workdir = scratchDir('cmdquote');
    const shellDriven = buildRemoteWords(
      { host: 'h', remoteWorkdir: workdir },
      `echo "it's here"`,
      {},
    );
    const a = await runAsRemoteLoginShell(shellDriven, '');
    expect(a.stdout.trim()).toBe("it's here");

    // `shell: false` promises no EXTRA quoting layer around `cmd`: the command
    // is parsed once, by the wrapping `sh`, exactly as the unwrapped form is
    // parsed once by the login shell.
    const stdinDriven = buildRemoteWords(
      { host: 'h', remoteWorkdir: workdir },
      `sh -c "echo \\"it's here\\""`,
      { shell: false },
    );
    const b = await runAsRemoteLoginShell(stdinDriven, '');
    expect(b.stdout.trim()).toBe("it's here");
  });
});
