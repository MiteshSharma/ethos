import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { runExecutionConformance } from '@ethosagent/core';
import type { ExecChunk, Logger, PersonalityConfig, SecretsResolver } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import {
  buildRemoteWords,
  buildSshArgs,
  SshDestinationInvalidError,
  SshEnvUnsupportedError,
  SshExecutionBackend,
  SshKnownHostsInvalidError,
  SshTransportError,
  sshDestinationError,
  sshKnownHostsError,
} from '../index';

const secretsStub: SecretsResolver = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  list: async () => [],
};

const debugLines: string[] = [];
const loggerStub: Logger = {
  debug: (m: string) => {
    debugLines.push(m);
  },
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => loggerStub,
};

/** Minimal stand-in for the spawned ssh client. No connection is ever opened. */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true, end: () => {} };
  kills = 0;
  kill(): boolean {
    this.kills++;
    return true;
  }
}

interface Reply {
  stdout?: string[];
  /**
   * `Buffer` entries let a test emit RAW bytes — a multi-byte character split
   * across two `data` events, which is what a real socket does and what the
   * diagnostic buffer has to rejoin before decoding.
   */
  stderr?: (string | Buffer)[];
  code: number;
}

const spawned: { args: string[]; child: FakeChild }[] = [];
let replies: Reply[] = [];

/**
 * `setTimeout(0)` rather than a microtask: the stream generator registers its
 * listeners across an await, so an emit on the microtask queue would land
 * before anything was listening.
 */
function fakeSpawn(replyFor: (index: number) => Reply) {
  return (_cmd: string, args: readonly string[]) => {
    const child = new FakeChild();
    const index = spawned.length;
    spawned.push({ args: [...args], child });
    setTimeout(() => {
      const reply = replyFor(index);
      for (const s of reply.stdout ?? []) child.stdout.emit('data', Buffer.from(s));
      for (const s of reply.stderr ?? []) {
        child.stderr.emit('data', Buffer.isBuffer(s) ? s : Buffer.from(s));
      }
      child.emit('close', reply.code);
    }, 0);
    return child as unknown as ChildProcess;
  };
}

function useReplies(list: Reply[]): void {
  replies = list;
  vi.mocked(spawn).mockImplementation(
    fakeSpawn((i) => replies[i] ?? replies[replies.length - 1] ?? { code: 0 }) as typeof spawn,
  );
}

function backend(ssh?: Record<string, unknown>) {
  return new SshExecutionBackend({
    config: ssh ? { ssh: { host: 'build-01', ...ssh } } : {},
    secrets: secretsStub,
    logger: loggerStub,
  });
}

/**
 * Read one word back the way `sh` would: single-quoted runs are literal,
 * `\<c>` is an escaped `c`, and ANY other bare character means the wrap failed
 * to contain the argument — which is the whole failure mode these tests exist
 * to catch, so it throws rather than being silently accepted.
 */
function unquoteSingleWord(word: string): string {
  let out = '';
  let i = 0;
  while (i < word.length) {
    const ch = word[i];
    if (ch === "'") {
      i++;
      while (i < word.length && word[i] !== "'") {
        out += word[i];
        i++;
      }
      if (i >= word.length) throw new Error(`unterminated quote in: ${word}`);
      i++;
    } else if (ch === '\\') {
      const next = word[i + 1];
      if (next === undefined) throw new Error(`trailing backslash in: ${word}`);
      out += next;
      i += 2;
    } else {
      throw new Error(`unquoted "${ch}" escaped the wrap in: ${word}`);
    }
  }
  return out;
}

async function collect(stream: AsyncIterable<ExecChunk>): Promise<ExecChunk[]> {
  const chunks: ExecChunk[] = [];
  for await (const c of stream) chunks.push(c);
  return chunks;
}

beforeEach(() => {
  spawned.length = 0;
  debugLines.length = 0;
  vi.mocked(spawn).mockReset();
  useReplies([{ code: 0 }]);
});

describe('buildSshArgs', () => {
  it('emits BatchMode, ConnectTimeout, -T and accept-new host keys by default', () => {
    expect(buildSshArgs({ host: 'build-01' }, ['sh', '-c', "'true'"])).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-T',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '--',
      'build-01',
      'sh',
      '-c',
      "'true'",
    ]);
  });

  it('emits user@host, port, identity, known-hosts file and strict host keys', () => {
    expect(
      buildSshArgs(
        {
          host: 'build-01',
          user: 'deploy',
          port: 2222,
          identityFile: '/keys/id_ed25519',
          knownHostsFile: '/keys/known_hosts',
          strictHostKeys: 'yes',
        },
        ['true'],
      ),
    ).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-T',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UserKnownHostsFile=/keys/known_hosts',
      '-p',
      '2222',
      '-i',
      '/keys/id_ed25519',
      '--',
      'deploy@build-01',
      'true',
    ]);
  });

  // The terminator goes BEFORE the destination, which is where ssh honours it.
  // A TRAILING `--` would be sent to the remote as the command's argv[0] — the
  // reason an earlier lane removed one — so the position is the whole point.
  it('puts the option terminator immediately before the destination, never after it', () => {
    const args = buildSshArgs({ host: 'build-01' }, ['echo hi']);
    const terminator = args.indexOf('--');
    expect(terminator).toBeGreaterThanOrEqual(0);
    expect(args.lastIndexOf('--')).toBe(terminator);
    expect(args[terminator + 1]).toBe('build-01');
    // Nothing between the terminator and the destination, and the remote words
    // follow the destination untouched.
    expect(args.slice(terminator)).toEqual(['--', 'build-01', 'echo hi']);
  });

  // Defence in depth: `sshDestinationError` refuses this before spawn (below),
  // but if a caller reaches `buildSshArgs` directly the argv must STILL be
  // inert. Verified against OpenSSH 9.6p1: with the terminator ssh reports
  // `hostname contains invalid characters` and applies no ProxyCommand;
  // without it, `ssh -G` resolves `proxycommand touch /tmp/x`.
  it('neutralises a leading-dash destination in the argv with the terminator', () => {
    const args = buildSshArgs({ host: '-oProxyCommand=touch /tmp/pwned' }, ['true']);
    const terminator = args.indexOf('--');
    expect(args[terminator + 1]).toBe('-oProxyCommand=touch /tmp/pwned');
    // The hostile value is positional, never an option ssh would parse.
    expect(args.indexOf('-oProxyCommand=touch /tmp/pwned')).toBeGreaterThan(terminator);
  });
});

describe('sshDestinationError (pre-spawn destination grammar)', () => {
  it.each([
    ['-oProxyCommand=touch /tmp/pwned', /must not begin with '-'/],
    ['-D1234', /must not begin with '-'/],
    ['build 01', /not valid in a hostname/],
    ['build-01;touch /tmp/pwned', /not valid in a hostname/],
    ['$(touch /tmp/pwned)', /not valid in a hostname/],
    ['build-01\n-oProxyCommand=x', /not valid in a hostname/],
    ['', /not valid in a hostname/],
  ])('rejects host %j', (host, message) => {
    expect(sshDestinationError({ host })).toMatch(message);
  });

  it.each([
    ['-oProxyCommand=touch /tmp/pwned', /must not begin with '-'/],
    ['de ploy', /not valid in a login name/],
    ['deploy@evil', /not valid in a login name/],
  ])('rejects user %j', (user, message) => {
    expect(sshDestinationError({ host: 'build-01', user })).toMatch(message);
  });

  it.each([
    { host: 'build-01' },
    { host: 'build-01.internal.example.com' },
    { host: '10.0.0.7' },
    { host: '[::1]' },
    { host: 'fe80::1%eth0' },
    { host: 'build_01', user: 'deploy' },
    { host: 'build-01', user: 'deploy.ci-2' },
  ])('accepts %j', (ssh) => {
    expect(sshDestinationError(ssh)).toBeNull();
  });
});

// HIGH. `strictHostKeys` is an `'accept-new' | 'yes'` literal union precisely
// so `no` cannot be written down — this surface refuses to spell host-key
// verification off. `knownHostsFile` spelled it by another route: `accept-new`
// promises "learn the key once, refuse it if it ever changes", and the second
// half is bought entirely by PERSISTENCE. Point `UserKnownHostsFile` at a
// destination that keeps nothing and every connection is a first connection,
// accepting whatever key is offered — silent MITM, no diagnostic anywhere.
describe('sshKnownHostsError (pre-spawn host-key persistence)', () => {
  it.each([
    'none',
    'None',
    'NONE',
    '/dev/null',
    'nul',
    'NUL',
    // `UserKnownHostsFile` takes a whitespace-separated LIST; ssh consults all
    // of them, so one poisoned entry anywhere in it is enough.
    '/keys/known_hosts /dev/null',
    'none /keys/known_hosts',
  ])('rejects the non-persistent destination %j', (knownHostsFile) => {
    expect(sshKnownHostsError({ host: 'build-01', knownHostsFile })).toMatch(
      /cannot persist a learned host key/,
    );
  });

  it('rejects a whitespace-only value, which names no file at all', () => {
    expect(sshKnownHostsError({ host: 'build-01', knownHostsFile: '   ' })).toMatch(
      /must not be blank/,
    );
  });

  it.each([
    undefined,
    '/keys/known_hosts',
    '~/.ssh/known_hosts_ethos',
    // A path ssh has not created YET is the ordinary way an operator adopts a
    // dedicated file: `accept-new` writes it on the first connection. Absence
    // must never read as non-persistence.
    '/keys/does_not_exist_yet',
    '/keys/known_hosts /keys/known_hosts_ethos',
    // Named after the refused literals, but real files.
    '/keys/none',
    '/keys/dev/null',
  ])('accepts the persistent destination %j', (knownHostsFile) => {
    expect(
      sshKnownHostsError({ host: 'build-01', ...(knownHostsFile ? { knownHostsFile } : {}) }),
    ).toBeNull();
  });
});

describe('buildRemoteWords', () => {
  it('wraps the command in sh -c with no cd when no workdir is configured', () => {
    expect(buildRemoteWords({ host: 'h' }, 'echo hi', {})).toEqual(['sh', '-c', "'echo hi'"]);
  });

  it('prefixes cd <remoteWorkdir> when the operator configured one', () => {
    const words = buildRemoteWords({ host: 'h', remoteWorkdir: '/srv/app' }, 'echo hi', {});
    expect(words.slice(0, 2)).toEqual(['sh', '-c']);
    expect(unquoteSingleWord(words[2] ?? '')).toBe("cd '/srv/app' && echo hi");
  });

  it('prefers an explicit tool-call cwd over remoteWorkdir, verbatim as a remote path', () => {
    const words = buildRemoteWords({ host: 'h', remoteWorkdir: '/srv/app' }, 'pwd', {
      cwd: '/var/tmp/job',
    });
    expect(unquoteSingleWord(words[2] ?? '')).toBe("cd '/var/tmp/job' && pwd");
  });

  // HIGH 1. `shell: false` used to return early and discard BOTH `opts.cwd` and
  // `ssh.remoteWorkdir`, so every `run_code` call — all of which set
  // `shell: false` — ran in the remote LOGIN directory while config.yaml, the
  // character sheet and the injected prompt all said `remoteWorkdir`.
  it('applies remoteWorkdir to a stdin-driven runner when shell is false', () => {
    const words = buildRemoteWords({ host: 'h', remoteWorkdir: '/srv/app' }, 'python3 -', {
      shell: false,
    });
    expect(words.slice(0, 2)).toEqual(['sh', '-c']);
    expect(unquoteSingleWord(words[2] ?? '')).toBe("cd '/srv/app' && exec python3 -");
  });

  it('prefers an explicit cwd over remoteWorkdir when shell is false', () => {
    const words = buildRemoteWords({ host: 'h', remoteWorkdir: '/srv/app' }, 'bash -s', {
      shell: false,
      cwd: '/var/tmp/job',
    });
    expect(unquoteSingleWord(words[2] ?? '')).toBe("cd '/var/tmp/job' && exec bash -s");
  });

  // With no workdir there is nothing to wrap, so `shell: false` keeps its one
  // remaining job: no quoting layer around a command the caller already composed
  // as a remote command line.
  it('leaves the command unwrapped when shell is false and no workdir applies', () => {
    expect(buildRemoteWords({ host: 'h' }, 'node --input-type=module', { shell: false })).toEqual([
      'node --input-type=module',
    ]);
  });

  it('uses exec only on the shell:false path, so a shell:true command still runs as a child', () => {
    const wrapped = unquoteSingleWord(
      buildRemoteWords({ host: 'h', remoteWorkdir: '/srv/app' }, 'echo hi', {})[2] ?? '',
    );
    expect(wrapped).toBe("cd '/srv/app' && echo hi");
    expect(wrapped).not.toContain('exec');
  });

  it('survives an embedded single quote in the workdir on the shell:false path', () => {
    const words = buildRemoteWords({ host: 'h', remoteWorkdir: "/srv/o'brien" }, 'python3 -', {
      shell: false,
    });
    const script = unquoteSingleWord(words[2] ?? '');
    expect(script.endsWith(' && exec python3 -')).toBe(true);
    const cdWord = script.slice(3, script.indexOf(' && '));
    expect(unquoteSingleWord(cdWord)).toBe("/srv/o'brien");
  });

  it('survives an embedded single quote in the command', () => {
    const cmd = `echo "it's here"`;
    const words = buildRemoteWords({ host: 'h' }, cmd, {});
    // Reading the wrapped word back the way sh would must yield the command
    // unchanged — and must not split into a second word.
    expect(unquoteSingleWord(words[2] ?? '')).toBe(cmd);
  });

  it('survives an embedded single quote in the workdir', () => {
    const words = buildRemoteWords({ host: 'h', remoteWorkdir: "/srv/o'brien" }, 'pwd', {});
    const script = unquoteSingleWord(words[2] ?? '');
    const [cdWord, rest] = [script.slice(3, script.indexOf(' && ')), script.slice(-3)];
    expect(rest).toBe('pwd');
    expect(unquoteSingleWord(cdWord)).toBe("/srv/o'brien");
  });
});

describe('SshExecutionBackend.exec', () => {
  it('spawns ssh with the full hardened arg vector and the sh -c wrapped command', async () => {
    const be = backend({ user: 'deploy', port: 2222, remoteWorkdir: '/srv/app' });
    await collect(be.exec('echo hi', {}));
    expect(spawned[0]?.args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-T',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-p',
      '2222',
      '--',
      'deploy@build-01',
      'sh',
      '-c',
      "'cd '\\''/srv/app'\\'' && echo hi'",
    ]);
  });

  it('sends a stdin-driven runner into remoteWorkdir, with stdin still written', async () => {
    const be = backend({ remoteWorkdir: '/srv/app' });
    await collect(be.exec('python3 -', { shell: false, stdin: 'print(1)' }));
    expect(spawned[0]?.args.slice(-5)).toEqual([
      '--',
      'build-01',
      'sh',
      '-c',
      "'cd '\\''/srv/app'\\'' && exec python3 -'",
    ]);
  });

  it('sends the runner unwrapped when shell is false and no workdir is configured', async () => {
    const be = backend({});
    await collect(be.exec('python3 -', { shell: false, stdin: 'print(1)' }));
    expect(spawned[0]?.args.slice(-3)).toEqual(['--', 'build-01', 'python3 -']);
  });

  // HIGH 2. The destination is refused BEFORE spawn — asserted on what would
  // have reached `spawn`, not merely on the thrown message.
  it('refuses a ProxyCommand-shaped host before spawning anything', async () => {
    const be = new SshExecutionBackend({
      config: { ssh: { host: '-oProxyCommand=touch /tmp/pwned' } },
      secrets: secretsStub,
      logger: loggerStub,
    });
    await expect(collect(be.exec('echo hi', {}))).rejects.toBeInstanceOf(
      SshDestinationInvalidError,
    );
    expect(spawned).toHaveLength(0);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it('refuses a ProxyCommand-shaped user before spawning anything', async () => {
    const be = backend({ user: '-oProxyCommand=touch /tmp/pwned' });
    await expect(collect(be.exec('echo hi', {}))).rejects.toBeInstanceOf(
      SshDestinationInvalidError,
    );
    expect(spawned).toHaveLength(0);
  });

  // HIGH. The back door around the `strictHostKeys: 'no'` refusal, closed
  // before spawn — asserted on what would have reached `spawn`, not merely on
  // the thrown message. `buildSshArgs` has no `--`-style neutralisation to fall
  // back on here: `UserKnownHostsFile=none` means exactly what it says.
  it.each(['none', '/dev/null', 'NUL', '/keys/known_hosts /dev/null'])(
    'refuses the non-persistent knownHostsFile %j before spawning anything',
    async (knownHostsFile) => {
      const be = backend({ knownHostsFile });
      await expect(collect(be.exec('echo hi', {}))).rejects.toBeInstanceOf(
        SshKnownHostsInvalidError,
      );
      expect(spawned).toHaveLength(0);
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    },
  );

  // `strictHostKeys: yes` is NOT an escape hatch. Against a destination that
  // keeps nothing it matches nothing, so every connection fails — safe and
  // useless, and it fails at the first tool call instead of at boot.
  it('refuses a non-persistent knownHostsFile even with strictHostKeys yes', async () => {
    const be = backend({ knownHostsFile: 'none', strictHostKeys: 'yes' });
    await expect(collect(be.exec('echo hi', {}))).rejects.toBeInstanceOf(SshKnownHostsInvalidError);
    expect(spawned).toHaveLength(0);
  });

  it('still spawns for a persistent knownHostsFile, forwarded verbatim', async () => {
    const be = backend({ knownHostsFile: '/keys/known_hosts' });
    await collect(be.exec('echo hi', {}));
    expect(spawned[0]?.args).toContain('UserKnownHostsFile=/keys/known_hosts');
  });

  it('rejects a non-empty env instead of silently dropping it', async () => {
    const be = backend({});
    await expect(collect(be.exec('echo hi', { env: { TOKEN: 'x' } }))).rejects.toBeInstanceOf(
      SshEnvUnsupportedError,
    );
    expect(spawned).toHaveLength(0);
  });

  it('accepts an empty env (what the routed callers pass)', async () => {
    const be = backend({});
    const chunks = await collect(be.exec('echo hi', { env: {} }));
    expect(chunks.at(-1)).toEqual({ stream: 'exit', code: 0 });
  });

  it('ends the stream with the remote exit code', async () => {
    useReplies([{ stdout: ['hi\n'], code: 3 }]);
    const chunks = await collect(backend({}).exec('false', {}));
    expect(chunks).toEqual([
      { stream: 'stdout', data: 'hi\n' },
      { stream: 'exit', code: 3 },
    ]);
  });

  it('truncates at the byte ceiling and kills the local ssh client', async () => {
    useReplies([{ stdout: ['x'.repeat(1_000_001)], code: 0 }]);
    const chunks = await collect(backend({}).exec('yes', {}));
    expect(chunks.at(-1)).toEqual({
      stream: 'stderr',
      data: '\n[output truncated at 1000000 bytes]\n',
    });
    expect(spawned[0]?.child.kills).toBe(1);
  });

  it('treats exit 255 with an ssh: diagnostic as a transport failure', async () => {
    useReplies([
      { stderr: ['ssh: connect to host build-01 port 22: Connection refused\n'], code: 255 },
    ]);
    await expect(collect(backend({}).exec('echo hi', {}))).rejects.toBeInstanceOf(
      SshTransportError,
    );
  });

  it('passes a remote command that genuinely exited 255 through as an exit chunk', async () => {
    useReplies([{ stderr: ['app: fatal\n'], code: 255 }]);
    const chunks = await collect(backend({}).exec('exit 255', {}));
    expect(chunks.at(-1)).toEqual({ stream: 'exit', code: 255 });
  });
});

describe('SshExecutionBackend.isAvailable', () => {
  it('probes the configured target with BatchMode and ConnectTimeout=5', async () => {
    expect(await backend({ user: 'deploy' }).isAvailable()).toBe(true);
    expect(spawned[0]?.args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-T',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '--',
      'deploy@build-01',
      'true',
    ]);
  });

  it('caches a success for the TTL — the second call opens no connection', async () => {
    const be = backend({});
    expect(await be.isAvailable()).toBe(true);
    expect(await be.isAvailable()).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it('never caches a failure — every call re-probes', async () => {
    useReplies([{ stderr: ['deploy@build-01: Permission denied (publickey).\n'], code: 255 }]);
    const be = backend({});
    expect(await be.isAvailable()).toBe(false);
    expect(await be.isAvailable()).toBe(false);
    expect(spawned).toHaveLength(2);
  });

  it('surfaces the probe stderr verbatim', async () => {
    useReplies([
      { stderr: ['ssh: connect to host build-01 port 22: Connection timed out\n'], code: 255 },
    ]);
    const be = backend({});
    expect(await be.isAvailable()).toBe(false);
    expect(be.lastProbeError).toBe('ssh: connect to host build-01 port 22: Connection timed out');
    expect(debugLines.at(-1)).toContain('Connection timed out');
  });

  it('resolves false when no host is configured, without spawning', async () => {
    const be = backend();
    expect(await be.isAvailable()).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(be.lastProbeError).toContain('config.ssh.host');
  });

  // The probe is the second pre-spawn gate. It answers false rather than
  // throwing (`isAvailable` must not reject), but it opens no connection —
  // otherwise the probe itself would be the unpinned first connection.
  it('resolves false for a non-persistent knownHostsFile, without spawning', async () => {
    const be = backend({ knownHostsFile: 'none' });
    expect(await be.isAvailable()).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(be.lastProbeError).toContain('cannot persist a learned host key');
  });
});

// LOW. The retained diagnostic used to test `stderrHead.length` BEFORE
// appending a whole chunk, so a single oversized chunk was kept in full — the
// one case a bound exists for — and `String.length` counted UTF-16 code units,
// not bytes.
describe('bounded stderr diagnostic', () => {
  it('keeps exactly 4096 bytes of a single chunk far larger than the bound', async () => {
    useReplies([{ stderr: ['x'.repeat(100_000)], code: 1 }]);
    const result = await backend({}).probe();
    expect(result.ok).toBe(false);
    expect(Buffer.byteLength(result.error ?? '', 'utf-8')).toBe(4096);
  });

  it('bounds the transport diagnostic of an oversized single chunk', async () => {
    useReplies([{ stderr: [`ssh: ${'x'.repeat(100_000)}\n`], code: 255 }]);
    let message = '';
    try {
      await collect(backend({}).exec('true', {}));
    } catch (e) {
      expect(e).toBeInstanceOf(SshTransportError);
      message = e instanceof Error ? e.message : '';
    }
    // `ssh: ` is 5 of the 4096 retained bytes; the rest is the payload.
    expect(message).toBe(`ssh transport failed: ssh: ${'x'.repeat(4096 - 5)}`);
  });

  // The buffer carries the stderr an operator READS to diagnose a failure, so a
  // cap that splits a UTF-8 sequence and leaves U+FFFD defeats its purpose. The
  // cut backs off to the character boundary instead.
  it.each([
    // '€' is 3 bytes (E2 82 AC), so these place a sequence across byte 4096 at
    // each of its three offsets. The first two straddle and back off; the third
    // lands exactly on the boundary and keeps the whole character.
    ['a'.repeat(4095), 'a'.repeat(4095), 4095],
    ['a'.repeat(4094), 'a'.repeat(4094), 4094],
    ['a'.repeat(4093), `${'a'.repeat(4093)}€`, 4096],
  ])('never cuts a multi-byte character at the bound (%#)', async (prefix, kept, bytes) => {
    useReplies([{ stderr: [`${prefix}${'€'.repeat(20)}`], code: 1 }]);
    const result = await backend({}).probe();
    expect(result.error).not.toContain('�');
    expect(result.error).toBe(kept);
    expect(Buffer.byteLength(result.error ?? '', 'utf-8')).toBe(bytes);
  });

  // A real socket splits wherever it likes. Retaining BYTES and decoding once
  // at the end is what makes a character straddling two `data` events survive.
  it('rejoins a multi-byte character split across two chunks', async () => {
    const euro = Buffer.from('€', 'utf-8');
    useReplies([
      {
        stderr: [Buffer.from('ssh: '), euro.subarray(0, 1), euro.subarray(1), Buffer.from('!')],
        code: 1,
      },
    ]);
    const result = await backend({}).probe();
    expect(result.error).toBe('ssh: €!');
  });

  // Once a chunk does not fit, later chunks are dropped WHOLE. Topping the
  // buffer up with a smaller later chunk would splice together bytes that were
  // never adjacent — a plausible-looking ssh message that was never printed.
  it('drops later chunks whole rather than splicing a non-contiguous prefix', async () => {
    useReplies([{ stderr: ['x'.repeat(100_000), 'LATER'], code: 1 }]);
    const result = await backend({}).probe();
    expect(result.error).not.toContain('LATER');
    expect(Buffer.byteLength(result.error ?? '', 'utf-8')).toBe(4096);
  });
});

describe('SshExecutionBackend contract surface', () => {
  it('mountsFor returns no mounts (not mount-confined)', () => {
    expect(backend({}).mountsFor({} as PersonalityConfig)).toEqual([]);
  });

  it('attests nothing but the absent docker socket', () => {
    expect(backend({}).attest()).toEqual({
      readonlyRootFs: false,
      noHostMounts: false,
      egressControlled: false,
      noDockerSocket: true,
      nonRoot: false,
      noPrivileged: false,
      noCapAdd: false,
      capDropAll: false,
      noNewPrivs: false,
    });
  });

  it('spawnSession opens a fresh connection per exec (thin session, no shared state)', async () => {
    const session = backend({}).spawnSession('remote-hands');
    expect(session.personalityId).toBe('remote-hands');
    expect(session.stop).toBeUndefined();
    await collect(session.exec('pwd'));
    await collect(session.exec('pwd'));
    expect(spawned).toHaveLength(2);
    await session.dispose();
  });

  it('exposes the target it was CONSTRUCTED with, frozen and copied', () => {
    // The registry memoises this instance, so an operator editing
    // `execution.ssh.*` does not change what it dials. A surface that wants to
    // say so has to be able to read the instance's own target rather than pair
    // fresh config with an opaque object.
    const ssh = { host: 'build-01', user: 'deploy', port: 2222 };
    const b = new SshExecutionBackend({
      config: { ssh },
      secrets: secretsStub,
      logger: loggerStub,
    });
    expect(b.configuredTarget).toEqual(ssh);
    // A copy, not the caller's object: mutating the source cannot rewrite the
    // identity, and neither can mutating the identity.
    ssh.host = 'build-02';
    expect(b.configuredTarget?.host).toBe('build-01');
    expect(Object.isFrozen(b.configuredTarget)).toBe(true);
  });

  it('has no target identity when it was built with no ssh block', () => {
    expect(backend().configuredTarget).toBeUndefined();
  });

  it('passes the core ExecutionBackend conformance harness', async () => {
    useReplies([{ code: 0 }, { stdout: ['conformance-test\n'], code: 0 }]);
    const result = await runExecutionConformance(backend({}));
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
