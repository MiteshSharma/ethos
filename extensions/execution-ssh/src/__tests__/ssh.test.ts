import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutionConformance } from '@ethosagent/core';
import type { ExecChunk, Logger, PersonalityConfig, SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

import { spawn, spawnSync } from 'node:child_process';
import {
  buildRemoteWords,
  buildSshArgs,
  knownHostsFromSshConfig,
  SshDestinationInvalidError,
  SshEnvUnsupportedError,
  SshExecutionBackend,
  SshKnownHostsInvalidError,
  SshTransportError,
  sshDestinationError,
  sshKnownHostsError,
  sshKnownHostsUnwritableError,
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

/**
 * Drive the `ssh -G` lookup without a real ssh binary. `null` is the
 * subprocess failing (no binary, non-zero status, timeout); a string is its
 * stdout.
 */
function useSshConfig(stdout: string | null): void {
  vi.mocked(spawnSync).mockReturnValue(
    (stdout === null
      ? { status: 1, stdout: '', stderr: '' }
      : { status: 0, stdout, stderr: '' }) as ReturnType<typeof spawnSync>,
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

/**
 * A throwaway `$HOME` with a writable `.ssh/`, for the duration of every test.
 *
 * The known-hosts writability probe reads the real filesystem, and with
 * `knownHostsFile` unset it resolves ssh's own default — `~/.ssh/known_hosts`.
 * Left pointing at the developer's or the runner's actual home, every test that
 * reaches `exec` or `probe` would pass or fail on whatever that machine happens
 * to look like. Same save/restore shape as
 * `extensions/llm-codex/src/__tests__/token-store.test.ts`.
 */
let tmpHome = '';
let savedHome: string | undefined;
/** Directories a test made read-only, restored before the tree is removed. */
const restorePerms: string[] = [];

/**
 * `chmod` means nothing to uid 0 — a 0500 directory is still writable for root,
 * so the permission-based cases assert nothing there and are skipped rather
 * than reported as passing. The missing-directory cases below cover the same
 * refusal for any uid.
 */
const asUnprivilegedUser = process.getuid?.() === 0 ? it.skip : it;

beforeEach(() => {
  spawned.length = 0;
  debugLines.length = 0;
  vi.mocked(spawn).mockReset();
  useReplies([{ code: 0 }]);
  // Default: `ssh -G` could not be run. That is the FAIL-OPEN branch, so every
  // pre-existing expectation about the unset default still describes the
  // behaviour under test rather than being rewritten around the new lookup.
  useSshConfig(null);
  savedHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'ethos-ssh-home-'));
  mkdirSync(join(tmpHome, '.ssh'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  for (const dir of restorePerms) chmodSync(dir, 0o700);
  restorePerms.length = 0;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

/** A directory inside the throwaway home that this process cannot write. */
function readOnlyDir(name: string): string {
  const dir = join(tmpHome, name);
  mkdirSync(dir);
  chmodSync(dir, 0o500);
  restorePerms.push(dir);
  return dir;
}

describe('buildSshArgs', () => {
  it('emits BatchMode, ConnectTimeout, -T and accept-new host keys by default', () => {
    expect(buildSshArgs({ host: 'build-01' }, ['sh', '-c', "'true'"])).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'PermitLocalCommand=no',
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
      'PermitLocalCommand=no',
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

  // The operator's `~/.ssh/config` is trusted input, but a `Host`/`Match` block
  // setting `LocalCommand` runs ON THE ETHOS HOST after every successful
  // connection, while the execution posture says the command ran remotely. A
  // command-line `-o` is read before any config file and ssh keeps the FIRST
  // value it obtains, so pinning it here is what a config-file
  // `PermitLocalCommand yes` cannot beat. It must also land BEFORE the
  // terminator — anything after the destination is remote words, not options.
  it('pins PermitLocalCommand off, before the option terminator', () => {
    const args = buildSshArgs({ host: 'build-01' }, ['true']);
    const at = args.indexOf('PermitLocalCommand=no');
    expect(at).toBeGreaterThan(0);
    expect(args[at - 1]).toBe('-o');
    expect(at).toBeLessThan(args.indexOf('--'));
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

// `accept-new` promises "learn the key on first sight, refuse it if it ever
// changes", and the second clause is bought entirely by the learned key being
// PERSISTED. OpenSSH warns and CONTINUES when it cannot write one (verified
// 9.6p1 against a real sshd: "Failed to add the host to the list of known
// hosts", remote command ran, exit 0), so an unwritable destination means every
// connection is a first connection — with the config still claiming pinning.
// The lexical check above cannot see any of this.
describe('sshKnownHostsUnwritableError (pre-spawn host-key persistence on this machine)', () => {
  it('accepts a writable file', () => {
    const file = join(tmpHome, '.ssh', 'known_hosts');
    writeFileSync(file, '');
    expect(sshKnownHostsUnwritableError({ host: 'build-01', knownHostsFile: file })).toBeNull();
  });

  // Absence is the ORDINARY case — `accept-new` creates the file on the first
  // connection, which is how an operator adopts a dedicated known-hosts file.
  it('accepts a file that does not exist yet in a writable directory', () => {
    const file = join(tmpHome, '.ssh', 'known_hosts_ethos');
    expect(sshKnownHostsUnwritableError({ host: 'build-01', knownHostsFile: file })).toBeNull();
  });

  it('rejects a file whose directory does not exist, naming the directory to create', () => {
    const file = join(tmpHome, 'nodir', 'known_hosts');
    const err = sshKnownHostsUnwritableError({ host: 'build-01', knownHostsFile: file });
    expect(err).toContain(file);
    expect(err).toContain(`mkdir -p '${join(tmpHome, 'nodir')}'`);
  });

  asUnprivilegedUser('rejects a file whose directory is not writable', () => {
    const dir = readOnlyDir('ro-dir');
    const file = join(dir, 'known_hosts');
    const err = sshKnownHostsUnwritableError({ host: 'build-01', knownHostsFile: file });
    expect(err).toContain(file);
    expect(err).toContain('is not writable');
  });

  asUnprivilegedUser('rejects an existing file that is not writable', () => {
    const file = join(tmpHome, '.ssh', 'known_hosts');
    writeFileSync(file, '');
    chmodSync(file, 0o400);
    const err = sshKnownHostsUnwritableError({ host: 'build-01', knownHostsFile: file });
    expect(err).toContain(file);
    expect(err).toContain('that file is not writable');
  });

  // The unset case is the common one and the one most likely to be unwritable
  // in a container, so the probe must resolve ssh's own default rather than
  // skip. Here `$HOME` itself does not exist, so nothing about the path is
  // inherited from the machine running the test.
  it('resolves ssh’s own default when knownHostsFile is unset', () => {
    process.env.HOME = join(tmpHome, 'no-such-home');
    const err = sshKnownHostsUnwritableError({ host: 'build-01' });
    expect(err).toContain(join(tmpHome, 'no-such-home', '.ssh', 'known_hosts'));
    expect(err).toContain('does not exist');
  });

  it('accepts the unset default when ~/.ssh is writable', () => {
    expect(sshKnownHostsUnwritableError({ host: 'build-01' })).toBeNull();
  });

  // `~/.ssh` is the ONE directory ssh creates for itself
  // (`hostfile_create_user_ssh_dir`), so a fresh container missing it must not
  // be refused for a directory ssh would have made. Verified 9.6p1: any OTHER
  // missing directory is not created and the write fails.
  it('defers to the home directory when only ~/.ssh is missing', () => {
    rmSync(join(tmpHome, '.ssh'), { recursive: true });
    expect(sshKnownHostsUnwritableError({ host: 'build-01' })).toBeNull();
  });

  asUnprivilegedUser('rejects the unset default under an unwritable home', () => {
    const home = readOnlyDir('ro-home');
    process.env.HOME = home;
    const err = sshKnownHostsUnwritableError({ host: 'build-01' });
    expect(err).toContain(join(home, '.ssh', 'known_hosts'));
  });

  // Under `yes` nothing is ever LEARNED — an unknown host is refused outright —
  // so whether a key could be written is irrelevant, and a deliberately
  // read-only known_hosts is a legitimate deployment this must not break.
  it('does not probe at all when strictHostKeys is yes', () => {
    const file = join(tmpHome, 'nodir', 'known_hosts');
    expect(
      sshKnownHostsUnwritableError({
        host: 'build-01',
        knownHostsFile: file,
        strictHostKeys: 'yes',
      }),
    ).toBeNull();
  });

  // A learned key goes to the FIRST file listed; the rest are read-only
  // fallbacks (ssh_config(5)), so they are not this probe's subject.
  it('probes only the first file of a list', () => {
    const first = join(tmpHome, '.ssh', 'known_hosts');
    expect(
      sshKnownHostsUnwritableError({
        host: 'build-01',
        knownHostsFile: `${first} ${join(tmpHome, 'nodir', 'known_hosts2')}`,
      }),
    ).toBeNull();
  });

  // `%`-tokens and `${ENV}` expansions are resolved by ssh, not here. Refusing
  // a target on a path this process mis-resolved would be worse than the gap.
  // ssh_config(5) spells the environment form `${ENV}`; here it is INPUT to the
  // code under test, not an interpolation that lost its backticks.
  it.each([
    '~build/known_hosts',
    '%d/.ssh/known_hosts',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ssh's own syntax, quoted verbatim.
    '${HOME}/.ssh/known_hosts',
  ])('declines to guess at the unresolvable path %j', (knownHostsFile) => {
    expect(sshKnownHostsUnwritableError({ host: 'build-01', knownHostsFile })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F10 — the writability probe has to probe the file ssh WILL USE.
//
// With `knownHostsFile` unset — the common case — Ethos passes no
// `-o UserKnownHostsFile`, so the operator's `~/.ssh/config` decides. A
// `Host build-01 / UserKnownHostsFile /dev/null` block leaves a probe of
// `~/.ssh/known_hosts` passing on a file ssh never opens, and NOTHING IS EVER
// PINNED — the exact state the probe exists to refuse. `ssh -G` resolves the
// effective config for a destination without connecting, so that is what the
// unset case asks. Driven through a fake here; no real ssh is required.
// ---------------------------------------------------------------------------
describe('knownHostsFromSshConfig (parsing `ssh -G` output)', () => {
  it('reads the userknownhostsfile list', () => {
    expect(
      knownHostsFromSshConfig(
        'user deploy\nhostname build-01\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\nport 22\n',
      ),
    ).toEqual(['~/.ssh/known_hosts', '~/.ssh/known_hosts2']);
  });

  it('returns null when the output names no known-hosts file', () => {
    expect(knownHostsFromSshConfig('user deploy\nhostname build-01\n')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(knownHostsFromSshConfig('')).toBeNull();
  });

  // OpenSSH quotes a path containing spaces. Splitting one on whitespace would
  // yield fragments that are not paths, which the caller would then probe as if
  // they were and refuse a working target over.
  it('declines to split a quoted path', () => {
    expect(knownHostsFromSshConfig('userknownhostsfile "/keys/my hosts/known_hosts"\n')).toBeNull();
  });
});

describe('sshKnownHostsUnwritableError (effective known-hosts per `ssh -G`)', () => {
  const G = (line: string) => () => `hostname build-01\n${line}\n`;

  it('refuses when the operator’s ssh config redirects known-hosts to /dev/null', () => {
    const err = sshKnownHostsUnwritableError(
      { host: 'build-01' },
      G('userknownhostsfile /dev/null'),
    );
    expect(err).toContain('/dev/null');
    expect(err).toContain('build-01');
    expect(err).toContain('cannot persist a learned host key');
  });

  // OpenSSH's literal, not a path. Same hole, spelled differently.
  it('refuses the OpenSSH literal `none`', () => {
    expect(
      sshKnownHostsUnwritableError({ host: 'build-01' }, G('userknownhostsfile none')),
    ).toContain('cannot persist');
  });

  // A list is only as trustworthy as what ssh actually consults — the same rule
  // the lexical check applies to a configured list.
  it('refuses a non-persistent entry anywhere in the resolved list', () => {
    expect(
      sshKnownHostsUnwritableError(
        { host: 'build-01' },
        G('userknownhostsfile ~/.ssh/known_hosts /dev/null'),
      ),
    ).toContain('/dev/null');
  });

  it('names the destination it resolved for, user included', () => {
    expect(
      sshKnownHostsUnwritableError(
        { host: 'build-01', user: 'deploy' },
        G('userknownhostsfile /dev/null'),
      ),
    ).toContain('deploy@build-01');
  });

  // The redirect is a REAL path, just not the default one: the probe must
  // follow it rather than keep testing ~/.ssh/known_hosts.
  it('probes the file `ssh -G` actually named, not the default', () => {
    const redirected = join(tmpHome, 'nodir', 'known_hosts');
    const err = sshKnownHostsUnwritableError(
      { host: 'build-01' },
      G(`userknownhostsfile ${redirected}`),
    );
    expect(err).toContain(redirected);
    expect(err).not.toContain(join(tmpHome, '.ssh', 'known_hosts'));
  });

  it('accepts a redirected file whose directory is writable', () => {
    expect(
      sshKnownHostsUnwritableError(
        { host: 'build-01' },
        G(`userknownhostsfile ${join(tmpHome, 'known_hosts_alt')}`),
      ),
    ).toBeNull();
  });

  // FAIL OPEN on not knowing. Each of these falls back to ~/.ssh/known_hosts —
  // the behaviour that shipped before `-G` was consulted — so an ssh that
  // formats its resolved config differently is no worse off than it was.
  it.each<[string, () => string | null]>([
    ['`ssh -G` could not be run', () => null],
    ['the output carries no userknownhostsfile line', () => 'hostname build-01\n'],
    ['the resolved path is quoted', () => 'userknownhostsfile "/a b/known_hosts"\n'],
  ])('falls back to ssh’s own default when %s', (_label, resolver) => {
    // ~/.ssh is writable here, so the fallback ACCEPTS …
    expect(sshKnownHostsUnwritableError({ host: 'build-01' }, resolver)).toBeNull();
    // … and it is genuinely the default being probed, not a skipped check.
    process.env.HOME = join(tmpHome, 'no-such-home');
    expect(sshKnownHostsUnwritableError({ host: 'build-01' }, resolver)).toContain(
      join(tmpHome, 'no-such-home', '.ssh', 'known_hosts'),
    );
  });

  // A configured knownHostsFile is passed as a command-line `-o`, which
  // outranks the config file — there is nothing for `-G` to tell us.
  it('does not consult `ssh -G` when knownHostsFile is set', () => {
    const resolver = vi.fn(() => 'userknownhostsfile /dev/null\n');
    expect(
      sshKnownHostsUnwritableError(
        { host: 'build-01', knownHostsFile: join(tmpHome, '.ssh', 'known_hosts') },
        resolver,
      ),
    ).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('does not consult `ssh -G` under strictHostKeys yes', () => {
    const resolver = vi.fn(() => 'userknownhostsfile /dev/null\n');
    expect(
      sshKnownHostsUnwritableError({ host: 'build-01', strictHostKeys: 'yes' }, resolver),
    ).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });
});

// The same refusal at the seam that matters: nothing is spawned.
describe('SshExecutionBackend and a redirected known-hosts file', () => {
  it('refuses exec before spawning ssh when `ssh -G` resolves /dev/null', async () => {
    useSshConfig('hostname build-01\nuserknownhostsfile /dev/null\n');
    await expect(collect(backend({}).exec('echo hi', {}))).rejects.toBeInstanceOf(
      SshKnownHostsInvalidError,
    );
    expect(spawned).toHaveLength(0);
  });

  it('reports the same target unavailable, without connecting', async () => {
    useSshConfig('hostname build-01\nuserknownhostsfile /dev/null\n');
    const be = backend({});
    expect(await be.isAvailable()).toBe(false);
    expect(be.lastProbeError).toContain('/dev/null');
    expect(spawned).toHaveLength(0);
  });

  it('still spawns when `ssh -G` resolves a writable file', async () => {
    useSshConfig(`hostname build-01\nuserknownhostsfile ${join(tmpHome, '.ssh', 'known_hosts')}\n`);
    await collect(backend({}).exec('echo hi', {}));
    expect(spawned).toHaveLength(1);
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
      'PermitLocalCommand=no',
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
    const file = join(tmpHome, '.ssh', 'known_hosts');
    writeFileSync(file, '');
    const be = backend({ knownHostsFile: file });
    await collect(be.exec('echo hi', {}));
    expect(spawned[0]?.args).toContain(`UserKnownHostsFile=${file}`);
  });

  // Absence is not a failure: `accept-new` creates the file on the first
  // connection, and refusing that would break the ordinary way an operator
  // adopts a dedicated known-hosts file.
  it('still spawns for a knownHostsFile that does not exist yet', async () => {
    const be = backend({ knownHostsFile: join(tmpHome, '.ssh', 'known_hosts_ethos') });
    await collect(be.exec('echo hi', {}));
    expect(spawned).toHaveLength(1);
  });

  // The other half of the `accept-new` promise. ssh warns and CONTINUES when it
  // cannot record a key, so by the time the warning exists the command has
  // already run remotely, unpinned — the refusal has to beat the spawn, which
  // is what is asserted here rather than merely the thrown message.
  it('refuses an unpersistable known-hosts destination before spawning anything', async () => {
    const file = join(tmpHome, 'nodir', 'known_hosts');
    const be = backend({ knownHostsFile: file });
    await expect(collect(be.exec('echo hi', {}))).rejects.toThrow(
      new RegExp(file.replaceAll('/', '\\/')),
    );
    expect(spawned).toHaveLength(0);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  asUnprivilegedUser(
    'refuses an unwritable known-hosts directory before spawning anything',
    async () => {
      const file = join(readOnlyDir('ro-exec'), 'known_hosts');
      const be = backend({ knownHostsFile: file });
      await expect(collect(be.exec('echo hi', {}))).rejects.toBeInstanceOf(
        SshKnownHostsInvalidError,
      );
      expect(spawned).toHaveLength(0);
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    },
  );

  // The unset case resolves ssh's own `~/.ssh/known_hosts` rather than skipping
  // — it is the common configuration, and the one a container is most likely to
  // get wrong.
  it('refuses the unset default when the home directory does not exist', async () => {
    process.env.HOME = join(tmpHome, 'no-such-home');
    const be = backend({});
    await expect(collect(be.exec('echo hi', {}))).rejects.toBeInstanceOf(SshKnownHostsInvalidError);
    expect(spawned).toHaveLength(0);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  // Nothing is learned under `yes`, so persistence is irrelevant and a
  // read-only known-hosts file is a legitimate deployment.
  it('spawns under strictHostKeys yes even when the destination cannot be written', async () => {
    const be = backend({
      knownHostsFile: join(tmpHome, 'nodir', 'known_hosts'),
      strictHostKeys: 'yes',
    });
    await collect(be.exec('echo hi', {}));
    expect(spawned).toHaveLength(1);
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

  // F11 — the event the known-hosts apparatus exists to PRODUCE. ssh prints
  // this line without its `ssh:` prefix, so a prefix-only test classified a
  // changed or unverifiable host key as a remote exit 255 — which `run_tests`
  // then rendered as `Tests failed (code 255)`, an instruction to the agent to
  // go fix a suite that never ran.
  it('reports a host-key verification failure as a transport error', async () => {
    useReplies([
      {
        stderr: [
          '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n',
          '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n',
          'Host key verification failed.\n',
        ],
        code: 255,
      },
    ]);
    let message = '';
    try {
      await collect(backend({}).exec('pnpm test', {}));
    } catch (e) {
      expect(e).toBeInstanceOf(SshTransportError);
      message = e instanceof Error ? e.message : '';
    }
    expect(message).toBe('ssh transport failed: Host key verification failed.');
  });

  // `extensions/tools-code` classifies a transport failure by reading this code
  // structurally — it must not import a concrete backend — so the string is one
  // half of a contract with no compiler holding it together. This is the pin.
  it('SshTransportError carries the code tools-code matches on', () => {
    expect(new SshTransportError('x').code).toBe('SSH_TRANSPORT_FAILED');
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
      'PermitLocalCommand=no',
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

  // A probe connection under `accept-new` is ITSELF a first connection that
  // learns and pins a key, so it must not run against a destination that cannot
  // keep one either.
  it('resolves false for an unpersistable known-hosts destination, without spawning', async () => {
    const file = join(tmpHome, 'nodir', 'known_hosts');
    const be = backend({ knownHostsFile: file });
    expect(await be.isAvailable()).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(be.lastProbeError).toContain(file);
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
