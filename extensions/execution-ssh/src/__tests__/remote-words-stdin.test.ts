import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildRemoteWords } from '../index';

/**
 * A stand-in for the per-exec exit-255 receipt. The production value is 128
 * random bits; nothing here depends on the randomness, only on the shape being
 * a bare `sh` word, so a fixed literal keeps the assertions readable.
 */
const SENTINEL = '__ethos_ssh_exit255_fixed_for_tests__';

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
    // Three call sites below hand empty stdin to a wrapped command that never
    // reads it, so under load the shell can exit — closing the read end —
    // before this write lands. That is EPIPE on the pipe, and with no listener
    // Node raises it as an unhandled error that fails the whole run rather than
    // a test. Ignoring EPIPE cannot mask a genuine broken pipe: nothing here
    // trusts the write to report delivery. Whether stdin actually reached the
    // runner is proved by the stdout and exit-status assertions, which still
    // fail if the bytes never arrive. Any other stream error is real, and
    // rejects.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') reject(err);
    });
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
    const words = buildRemoteWords(
      { host: 'h', remoteWorkdir: workdir },
      'sh -s',
      { shell: false },
      SENTINEL,
    );
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
      SENTINEL,
    );
    const result = await runAsRemoteLoginShell(
      words,
      "console.log('STDIN_REACHED_RUNNER|' + process.cwd());\n",
    );
    expect(result.stdout.trim()).toBe(`STDIN_REACHED_RUNNER|${workdir}`);
    expect(result.code).toBe(0);
  });

  // `exec` used to front the runner so its status WAS the wrapping shell's.
  // The exit-255 epilogue cannot coexist with `exec` — an `exec`d process never
  // returns to the shell that would emit the receipt — so the status is now
  // carried explicitly by `exit $__ethos_st`. That claim is what this executes:
  // if the epilogue were status-opaque, `run_tests` would report the wrong code
  // for every remote failure.
  it('preserves the runner exit status now that `exec` is gone', async () => {
    const workdir = scratchDir('exit');
    const words = buildRemoteWords(
      { host: 'h', remoteWorkdir: workdir },
      'sh -s',
      { shell: false },
      SENTINEL,
    );
    const result = await runAsRemoteLoginShell(words, 'exit 7\n');
    expect(result.code).toBe(7);
    // 7 is not 255, so no receipt is emitted and nothing is added to stderr.
    expect(result.stderr).toBe('');
  });

  // The discriminator itself, executed rather than asserted: a remote command
  // exiting 255 leaves a receipt, and one exiting anything else does not.
  it.each([
    [0, false],
    [1, false],
    [254, false],
    [255, true],
  ])('emits the receipt for exit %i: %s', async (status, expected) => {
    const words = buildRemoteWords({ host: 'h' }, 'sh -s', { shell: false }, SENTINEL);
    const result = await runAsRemoteLoginShell(words, `exit ${status}\n`);
    expect(result.code).toBe(status);
    expect(result.stderr.includes(SENTINEL)).toBe(expected);
  });

  // The epilogue is joined with TWO newlines, and this is why. A command ending
  // in a backslash is a line CONTINUATION: with one newline the shell splices
  // `__ethos_st=$?` onto the command and runs `echo a __ethos_st=$?`, exiting
  // 2. With two, the continuation consumes the empty line and the command runs
  // exactly as it does unwrapped.
  it('survives a command ending in a line continuation', async () => {
    const words = buildRemoteWords({ host: 'h' }, 'echo a \\', {}, SENTINEL);
    const result = await runAsRemoteLoginShell(words, '');
    expect(result.stdout).toBe('a\n');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  // And this is why the epilogue is joined with a NEWLINE rather than `;` — a
  // `;`-joined epilogue disappears into the comment.
  it('survives a command ending in a comment', async () => {
    const words = buildRemoteWords({ host: 'h' }, 'echo hi # list them', {}, SENTINEL);
    const result = await runAsRemoteLoginShell(words, '');
    expect(result.stdout).toBe('hi\n');
    expect(result.code).toBe(0);
  });

  it('survives an embedded single quote in the workdir, wrapped and unwrapped alike', async () => {
    const parent = scratchDir('quote');
    const workdir = join(parent, "o'brien's dir");
    await runAsRemoteLoginShell(
      buildRemoteWords({ host: 'h' }, 'sh -s', {}, SENTINEL),
      `mkdir -p '${workdir.replaceAll("'", `'\\''`)}'\n`,
    );
    const stdinDriven = buildRemoteWords(
      { host: 'h', remoteWorkdir: workdir },
      'sh -s',
      { shell: false },
      SENTINEL,
    );
    const result = await runAsRemoteLoginShell(stdinDriven, 'printf "%s\\n" "$PWD"\n');
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(workdir);

    // Same for the shell:true path, whose quoting this fix must not disturb.
    const shellDriven = buildRemoteWords(
      { host: 'h', remoteWorkdir: workdir },
      'printf "%s\\n" "$PWD"',
      {},
      SENTINEL,
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
      SENTINEL,
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
      SENTINEL,
    );
    const b = await runAsRemoteLoginShell(stdinDriven, '');
    expect(b.stdout.trim()).toBe("it's here");
  });
});
