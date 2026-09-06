import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ExecChunk,
  ExecOpts,
  ExecSession,
  ExecutionBackend,
  ExecutionBackendConfig,
  Logger,
  MountSpec,
  PersonalityConfig,
  SandboxAttestation,
  SecretsResolver,
} from '@ethosagent/types';

export class ExecAbortedError extends Error {
  readonly code = 'EXEC_ABORTED';
  constructor(message = 'Execution aborted') {
    super(message);
    this.name = 'ExecAbortedError';
  }
}

export class ExecTimeoutError extends Error {
  readonly code = 'EXEC_TIMEOUT';
  constructor(message = 'Execution timed out') {
    super(message);
    this.name = 'ExecTimeoutError';
  }
}

export class SshHostMissingError extends Error {
  readonly code = 'SSH_HOST_MISSING';
  constructor(message = 'ssh backend requires config.ssh.host to be set') {
    super(message);
    this.name = 'SshHostMissingError';
  }
}

/**
 * The configured `user`/`host` cannot be spelled into an ssh destination
 * safely.
 *
 * A destination is appended to ssh's own argv, and ssh parses any argument
 * beginning with `-` as ANOTHER LOCAL OPTION — so a host of
 * `-oProxyCommand=<cmd>` runs `<cmd>` ON THE ETHOS HOST, which is precisely the
 * local/remote confusion this backend exists to prevent. Verified against
 * OpenSSH 9.6p1: `ssh -G -oProxyCommand=touch /tmp/x realhost true` reports
 * `proxycommand touch /tmp/x` in its resolved config.
 *
 * {@link buildSshArgs} neutralises this in the argv with a `--` terminator; this
 * error is the SECOND layer, refusing the value outright before anything is
 * spawned (`packages/config` carries a third, at boot). Defence in depth is
 * deliberate: the terminator relies on ssh's parser, the grammar does not.
 */
export class SshDestinationInvalidError extends Error {
  readonly code = 'SSH_DESTINATION_INVALID';
  constructor(reason: string) {
    super(reason);
    this.name = 'SshDestinationInvalidError';
  }
}

/**
 * `knownHostsFile` names a destination that cannot REMEMBER a host key.
 *
 * The default policy is `StrictHostKeyChecking=accept-new` — learn the key on
 * first sight, refuse it if it ever changes. The second half of that promise is
 * bought entirely by PERSISTENCE: the learned key has to still be there next
 * time. Point `UserKnownHostsFile` at OpenSSH's literal `none`, or at a null
 * device, and nothing is ever written back, so every connection is a first
 * connection and accepts whatever key it is offered — silent MITM exposure,
 * with no diagnostic anywhere.
 *
 * That is host-key verification OFF, which this surface refuses to spell:
 * `strictHostKeys` is an `'accept-new' | 'yes'` literal union precisely so
 * `no` cannot be written down. Rejecting `no` while accepting
 * `knownHostsFile: none` would leave the refusal decorative.
 *
 * Rejected outright rather than downgraded (e.g. to "then you must also set
 * `strictHostKeys: yes`"): with a destination that keeps nothing, `yes` matches
 * NOTHING, so every connection fails. That is safe and useless, and it fails at
 * the first tool call with an ssh error instead of at boot with this one.
 *
 * This error covers BOTH pre-spawn known-hosts gates, because they are the same
 * failure told two ways:
 *
 *  - {@link sshKnownHostsError}, lexical, on the configured VALUE — `none` and
 *    the null devices. `packages/config` carries a copy of this one, at boot.
 *  - {@link sshKnownHostsUnwritableError}, on the effective DESTINATION — a
 *    perfectly ordinary path that this machine cannot actually write.
 *
 * KNOWN LIMIT: the lexical half stays lexical — it refuses the spellings an
 * operator would actually write, not every path that happens to resolve to a
 * null device (`/dev/./null`, a symlink to it). `/dev/null` is writable, so the
 * probe waves it through and the lexical rule is what catches it; neither
 * pretends to defend against an operator circumventing on purpose.
 */
export class SshKnownHostsInvalidError extends Error {
  readonly code = 'SSH_KNOWN_HOSTS_INVALID';
  constructor(reason: string) {
    super(reason);
    this.name = 'SshKnownHostsInvalidError';
  }
}

/**
 * `opts.env` carried a value. v1 has no way to deliver it: `AcceptEnv` is
 * sshd-side operator config this backend cannot see, and inlining `K=V` into
 * the remote command string would silently change quoting semantics for the
 * caller. Routed callers (terminal, run_code) pass `{}` — so a non-empty env is
 * a wiring mistake, and failing is the only honest answer (plan §5).
 */
export class SshEnvUnsupportedError extends Error {
  readonly code = 'SSH_ENV_UNSUPPORTED';
  constructor(keys: readonly string[]) {
    super(
      `ssh backend cannot deliver environment variables (${keys.join(', ')}); ` +
        'set them inside the command instead',
    );
    this.name = 'SshEnvUnsupportedError';
  }
}

/**
 * ssh itself failed — it could not connect, authenticate, or hold the session
 * open — as opposed to the remote command running and exiting non-zero.
 *
 * ssh reports BOTH as exit status 255: it exits 255 on its own failures, and it
 * also propagates a remote command that genuinely exited 255. The two are told
 * apart by the diagnostic ssh writes to stderr, only SOME of which it prefixes
 * `ssh:` (plan §5) — see {@link isSshDiagnostic} for the unprefixed lines that
 * are also ssh's own, and for how they are told apart from remote output.
 *
 * KNOWN LIMIT: the classification is string matching over stderr, so it is
 * bounded in two directions and neither is closed.
 *
 *  - TOO NARROW. Only the patterns {@link SSH_SELF_DIAGNOSTICS} lists are
 *    claimed, and that list is what one OpenSSH build was observed to print,
 *    not what every build can print. An unlisted fatal line still surfaces as
 *    a remote exit 255. There is no seam behind this one: the gap opens
 *    MID-EXEC, after `isAvailable()` has already passed, and a probe cannot
 *    cover a connection that dies during a ten-minute test run. What the probe
 *    gate DOES cover is a failure that is already true before the command is
 *    sent — a wrong key, an unreachable host, a known-hosts destination this
 *    machine cannot write — and it covers those for every execution tool
 *    (`createRunCodeTool` and `makeCommandTool` in `@ethosagent/tools-code`,
 *    `makeTerminalTool` in `@ethosagent/tools-terminal`).
 *  - TOO BROAD is the worse error, so the patterns are anchored to a WHOLE
 *    line rather than searched for inside one: remote output that merely
 *    contains `Connection reset by peer` is a failing command, and reporting
 *    it as a transport failure would tell the agent its test suite never ran
 *    when it did. A remote command whose own stderr is byte-identical to one
 *    of ssh's fatal lines is still claimed — in practice that means the remote
 *    ran `ssh` and it failed, which is the honest reading anyway.
 */
export class SshTransportError extends Error {
  readonly code = 'SSH_TRANSPORT_FAILED';
  constructor(diagnostic: string) {
    super(`ssh transport failed: ${diagnostic}`);
    this.name = 'SshTransportError';
  }
}

/**
 * The ssh target as the operator configures it (plan D2) — `execution.ssh` from
 * `~/.ethos/config.yaml`, carried on `ExecutionBackendConfig` in
 * `@ethosagent/types`. A local alias for the contract's own shape, not a
 * widening of it: `shell` on `ExecOpts` and the full `ssh` block landed in
 * `packages/types` with the wiring lane (plan T5), so the two temporary
 * intersection types this file used to declare are gone.
 */
export type SshTarget = NonNullable<ExecutionBackendConfig['ssh']>;

/**
 * POSIX single-quote wrap.
 *
 * Copied — not imported — from `apps/ethos/src/commands/personality-export.ts`,
 * which carries the index of the other copies
 * (`apps/ethos/src/commands/backup.ts`, `apps/ethos/src/lib/tui-capabilities.ts`,
 * `packages/wiring/src/backup/secrets-manifest.ts`, `extensions/cron/src/index.ts`,
 * `apps/web`'s AddMcpModal). Same dialect, deliberately: an embedded `'` is
 * closed, escaped, and reopened, so a quote inside the command survives instead
 * of ending the wrap. This is the SEVENTH copy; those files' comments still say
 * six, and correcting them belongs to whoever consolidates them.
 */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Byte ceiling for one exec stream. Copied from `extensions/execution-docker/src/index.ts:183`. */
const MAX_EXEC_OUTPUT_BYTES = 1_000_000;

/** How long a successful availability probe is trusted (plan §4). */
const AVAILABILITY_TTL_MS = 60_000;

/** Bytes of stderr retained for transport diagnosis — bounded on purpose. */
const MAX_DIAGNOSTIC_BYTES = 4096;

/**
 * The largest `n <= limit` at which `buf` can be cut without splitting a UTF-8
 * sequence.
 *
 * A continuation byte is `10xxxxxx`. If the byte AT the cut is one, the
 * character starting before the cut runs past it, so walk back to that
 * character's lead byte and exclude the whole thing. If it is not, `limit` is
 * already a boundary. Never more than three steps — no UTF-8 sequence is longer
 * than four bytes.
 */
function utf8SafeEnd(buf: Buffer, limit: number): number {
  if (limit >= buf.length) return buf.length;
  let end = limit;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return end;
}

/**
 * A byte-exact PREFIX of a stream, capped at {@link MAX_DIAGNOSTIC_BYTES}.
 *
 * Retains raw bytes and decodes once, at the end. Two reasons, both of which
 * the previous `if (s.length < MAX) s += chunk.toString()` got wrong:
 *
 *  - It bounded nothing. The length test ran BEFORE appending a whole chunk, so
 *    a single 10 MB stderr burst was retained in full — the one case a bound
 *    exists for.
 *  - `String.length` counts UTF-16 code units, not bytes, so the cap was off by
 *    up to 3x either way depending on the encoding of what ssh printed.
 *
 * Decoding at the end is also what keeps the text READABLE, which is the whole
 * point of this buffer — an operator reads it to diagnose a transport failure.
 * A multi-byte character split across two `data` events decodes correctly
 * because the halves are rejoined before decoding, and the cap itself lands on
 * a character boundary via {@link utf8SafeEnd} rather than emitting U+FFFD.
 *
 * Once a chunk does not fit, the buffer is FULL and later chunks are dropped
 * whole. Topping it up with a smaller later chunk would splice together bytes
 * that were never adjacent, which reads as a plausible ssh message that was
 * never printed.
 */
function createDiagnosticBuffer(): { push: (chunk: Buffer) => void; text: () => string } {
  const parts: Buffer[] = [];
  let len = 0;
  let full = false;
  return {
    push(chunk: Buffer): void {
      if (full) return;
      const room = MAX_DIAGNOSTIC_BYTES - len;
      if (chunk.length <= room) {
        parts.push(chunk);
        len += chunk.length;
        return;
      }
      const end = utf8SafeEnd(chunk, room);
      if (end > 0) {
        parts.push(chunk.subarray(0, end));
        len += end;
      }
      full = true;
    },
    text(): string {
      return Buffer.concat(parts).toString('utf-8');
    },
  };
}

/**
 * The stderr lines ssh writes ABOUT ITSELF on a fatal path, beyond the ones it
 * prefixes `ssh:`.
 *
 * Every entry is anchored `^…$` and matched against a TRIMMED whole line. That
 * anchoring is the entire line-drawing rule, and it is drawn deliberately on
 * the narrow side. stderr carries the remote command's output interleaved with
 * ssh's own, and a matcher that SEARCHED for these phrases would claim
 * `curl: (56) Recv failure: Connection reset by peer` — an ordinary failing
 * command — as a transport failure and tell the agent its suite never ran. The
 * variable parts are constrained too (`\S+`, `port \d+`), so the bare libc
 * string `Connection reset by peer` does not match while ssh's own
 * `Connection reset by 10.0.0.5 port 22` does.
 *
 * Each pattern below was produced by driving the LOCAL ssh binary
 * (OpenSSH_9.6p1 Ubuntu-3ubuntu13.18) into the failure, against a throwaway
 * sshd or a socket server, and recording what it printed before exiting 255 —
 * except {@link CORRUPTED_MAC}, whose emission path needs a corrupted stream to
 * reach; only its literal is verified, in the shipped binary's own strings.
 * The comment on each entry names the run.
 *
 * This list is a snapshot of one build, not a proof of coverage — see the
 * KNOWN LIMIT on {@link SshTransportError}.
 */
const SSH_SELF_DIAGNOSTICS: readonly RegExp[] = [
  // EVERY host-key refusal — an unknown host under `StrictHostKeyChecking=yes`,
  // and a CHANGED key under `accept-new` or `yes` alike. `sshconnect.c`,
  // `verify_host_key` failure path. Driven through the same stderr path a real
  // client uses by ssh.test.ts ("reports a host-key verification failure as a
  // transport error"). A changed or unpinnable host key is precisely what
  // {@link sshKnownHostsUnwritableError} exists to make impossible to miss.
  /^Host key verification failed\.$/,
  // `deploy@build-01: Permission denied (publickey).` Reproduced against a
  // throwaway sshd with an empty `authorized_keys`. This line used to be a
  // documented gap on the ground that matching it "would have to guess which
  // Permission denied lines are ssh's" — true of a SEARCH, not of this
  // whole-line shape: `rsync: … : Permission denied (13)` and a bare
  // `Permission denied` both fail to match it.
  /^\S+@\S+: Permission denied \([^()]*\)\.$/,
  // `kex_exchange_identification: read: Connection reset by peer`. Reproduced
  // against a socket server that accepts and immediately closes. The prefix is
  // ssh's own function name; nothing but ssh prints it.
  /^kex_exchange_identification: /,
  // `Connection reset by 127.0.0.1 port 22001` / `Connection closed by
  // 127.0.0.1 port 22002` — `sshpkt_vfatal`, whose `remote_id` is
  // `<addr> port <n>`. Both reproduced against the same socket server (reset on
  // an immediate close, closed after a banner then a shutdown).
  /^Connection (?:reset|closed) by \S+ port \d+$/,
  // `Connection to 127.0.0.1 closed by remote host.` MID-EXEC: reproduced by
  // killing the sshd session while `echo STARTED; sleep 20` was running — the
  // remote had already streamed output, and ssh exited 255 after it.
  /^Connection to \S+ closed by remote host\.$/,
  // `Timeout, server 127.0.0.1 not responding.` Also mid-exec: reproduced with
  // `ServerAliveInterval=1 ServerAliveCountMax=2` and the sshd session
  // SIGSTOPped mid-command. `clientloop.c` calls `cleanup_exit(255)` right
  // after printing it.
  /^Timeout, server \S+ not responding\.$/,
  // Literal-only verification: present in the shipped binary's strings
  // (`packet.c`, the `SSH_ERR_MAC_INVALID` arm of `sshpkt_vfatal`), but a
  // corrupted stream is not reachable from a test harness here.
  /^Corrupted MAC on input\.$/,
];

/**
 * Whether a stderr line is ssh diagnosing ITSELF, rather than output from the
 * remote command.
 *
 * `ssh:`-prefixed lines are ssh's own by construction. The rest are the
 * anchored patterns in {@link SSH_SELF_DIAGNOSTICS}; the reason for anchoring
 * and the limits of the list are documented there and on
 * {@link SshTransportError}. Classifying one of these as a remote failure hands
 * it to the agent as a failing command — an instruction to go fix something
 * that never ran.
 *
 * A remote command whose own stderr carries one of these lines (a nested `ssh`
 * on the target that failed, and whose 255 the outer ssh propagates) is
 * classified as a transport failure too. That is the honest reading: it IS an
 * ssh failure, and reporting it as one is more useful than reporting it as a
 * command that failed.
 */
function isSshDiagnostic(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('ssh:')) return true;
  return SSH_SELF_DIAGNOSTICS.some((pattern) => pattern.test(trimmed));
}

/** `-o ConnectTimeout=` for a real exec. */
const EXEC_CONNECT_TIMEOUT_SEC = 10;

/** `-o ConnectTimeout=` for the availability probe (plan §5). */
const PROBE_CONNECT_TIMEOUT_SEC = 5;

/**
 * Hostnames, IPv4, IPv6 literals (`[::1]`, `fe80::1%eth0`) and `~/.ssh/config`
 * aliases. Excludes whitespace, control characters, `@`, `/`, and every shell
 * metacharacter — a destination is an argv word, not a command.
 */
const SSH_HOST_GRAMMAR = /^[A-Za-z0-9._:%[\]-]+$/;

/** POSIX-shaped login names. Same exclusions as the host grammar. */
const SSH_USER_GRAMMAR = /^[A-Za-z0-9._-]+$/;

/**
 * `UserKnownHostsFile` values that keep nothing (see
 * {@link SshKnownHostsInvalidError}). `none` is an OpenSSH literal, not a path;
 * the rest are null devices — `/dev/null` on POSIX, `nul` on Windows. Compared
 * lower-cased: OpenSSH's own `none` is case-sensitive, but refusing `None` too
 * costs only a file literally named that, and nobody keeps host keys in one.
 */
const NON_PERSISTENT_KNOWN_HOSTS = new Set(['none', '/dev/null', 'nul']);

/**
 * Why `ssh.user`/`ssh.host` cannot be spelled into a destination, or `null`
 * when they can. A leading `-` is called out separately from the grammar
 * because it is the ACTUAL attack (see {@link SshDestinationInvalidError}) and
 * an operator reading `invalid characters` would not learn that.
 *
 * Duplicated — not imported — in `packages/config/src/index.ts`
 * (`sshDestinationError`), which applies the same grammar at config-parse time
 * so a bad target is fatal at boot rather than at first tool call. `config` is
 * a lower layer than `extensions` and cannot import from one (ARCHITECTURE.md
 * §II); the two copies MUST change together.
 */
export function sshDestinationError(ssh: SshTarget): string | null {
  if (ssh.host.startsWith('-')) {
    return `execution.ssh.host: must not begin with '-' (got '${ssh.host}'); ssh would parse it as a local option.`;
  }
  if (!SSH_HOST_GRAMMAR.test(ssh.host)) {
    return `execution.ssh.host: contains characters that are not valid in a hostname (got '${ssh.host}').`;
  }
  const user = ssh.user;
  if (user !== undefined) {
    if (user.startsWith('-')) {
      return `execution.ssh.user: must not begin with '-' (got '${user}'); ssh would parse it as a local option.`;
    }
    if (!SSH_USER_GRAMMAR.test(user)) {
      return `execution.ssh.user: contains characters that are not valid in a login name (got '${user}').`;
    }
  }
  return null;
}

/**
 * Why `ssh.knownHostsFile` cannot hold a pinned host key, or `null` when it
 * can. See {@link SshKnownHostsInvalidError} for why a destination that keeps
 * nothing is host-key verification switched off.
 *
 * `UserKnownHostsFile` takes a whitespace-separated LIST, so every token is
 * checked, not just the first: a list is only as trustworthy as what ssh
 * actually consults, and no legitimate list names a null device. A value that
 * tokenises to nothing (all whitespace) is the same hole spelled emptily.
 *
 * A path that does not exist YET is fine and must stay fine — `accept-new`
 * creates the file on the first connection, which is the ordinary way an
 * operator adopts a dedicated `knownHostsFile`.
 *
 * Duplicated — not imported — in `packages/config/src/index.ts`
 * (`sshKnownHostsError`), which applies the same rule at config-parse time so a
 * non-persistent target is fatal at boot rather than silently trusting whatever
 * key is offered at the first tool call. `config` is a lower layer than
 * `extensions` and cannot import from one (ARCHITECTURE.md §II); the two copies
 * MUST change together.
 */
export function sshKnownHostsError(ssh: SshTarget): string | null {
  const raw = ssh.knownHostsFile;
  if (raw === undefined) return null;
  const paths = raw.split(/\s+/).filter((p) => p.length > 0);
  if (paths.length === 0) {
    return `execution.ssh.knownHostsFile: must not be blank; omit the key to use ssh's own known_hosts.`;
  }
  for (const path of paths) {
    if (NON_PERSISTENT_KNOWN_HOSTS.has(path.toLowerCase())) {
      return (
        `execution.ssh.knownHostsFile: '${path}' cannot persist a learned host key, ` +
        'so every connection would be a first connection and accept any key offered. ' +
        "Point it at a writable file path, or omit the key to use ssh's own known_hosts."
      );
    }
  }
  return null;
}

/**
 * OpenSSH's default `UserKnownHostsFile`, and where a newly learned key lands
 * when the operator sets no `knownHostsFile` — the common case, and the one
 * most likely to be unwritable in a container. ssh_config(5): "The default is
 * ~/.ssh/known_hosts, ~/.ssh/known_hosts2". A learned key is written to the
 * FIRST file listed, so `known_hosts2` is a read-only fallback and never this
 * probe's subject.
 */
const DEFAULT_KNOWN_HOSTS = '~/.ssh/known_hosts';

/** Wall-clock ceiling for the {@link runSshDashG} subprocess. */
const SSH_CONFIG_TIMEOUT_MS = 5_000;

/**
 * `ssh -G` output for a target, or `null` when this process could not obtain
 * it. Injectable so the parse and the decision built on it can be exercised
 * without a real ssh binary; the production default is {@link runSshDashG}.
 */
export type SshConfigResolver = (ssh: SshTarget) => Promise<string | null>;

/**
 * Resolve ssh's EFFECTIVE configuration for this destination without
 * connecting.
 *
 * The argv is the one a real exec would use, not a reduced one: a command-line
 * `-o` outranks the config file and `Match` blocks can key on the user, host
 * and port, so resolving a different argv would answer a question nobody
 * asked. `-G` prints the result and exits; no connection is opened.
 *
 * ASYNCHRONOUS, and it has to be. `-G` evaluates the operator's `Match exec`
 * blocks — arbitrary commands on the Ethos host — and reads a `~/.ssh/config`
 * that may live on a slow or hung filesystem. This ran as `spawnSync` until it
 * was noticed that the justification for that ("once per exec and once per
 * probe, beside an ssh connection that costs orders of magnitude more")
 * compared against the wrong thing: the ssh connection in `exec` is `spawn`,
 * which yields, so it costs the process nothing while it waits. A blocking
 * call here stalls the WHOLE process — every bot, every lane, every stream in
 * a gateway — for up to {@link SSH_CONFIG_TIMEOUT_MS}. No caller needs it
 * synchronous: `exec` is an async generator and `probe` already returns a
 * promise, so both simply await.
 *
 * That is not new exposure — the operator's `~/.ssh/config` is already trusted
 * input and a real connection evaluates the same blocks (see
 * {@link buildSshArgs} on the `ProxyCommand` residue) — but it is why the
 * timeout exists. stdin is closed so nothing it spawns can block waiting for
 * input, and stderr is DISCARDED rather than piped: nothing here reads it, and
 * an unread pipe is a 64 KiB buffer a chatty `Match exec` block could fill and
 * then block on, which is the hang the timeout would have to clean up.
 *
 * `null` on ANY failure — no ssh binary, non-zero status, timeout. The caller
 * treats that as "cannot determine" (see {@link sshKnownHostsUnwritableError}).
 */
function runSshDashG(ssh: SshTarget): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('ssh', ['-G', ...buildSshArgs(ssh, ['true'], PROBE_CONNECT_TIMEOUT_SEC)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, SSH_CONFIG_TIMEOUT_MS);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf-8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out : null));
  });
}

/**
 * The `UserKnownHostsFile` list in `ssh -G` output, or `null` when the output
 * names none this process can read.
 *
 * `-G` prints one lower-cased keyword per line followed by its resolved value;
 * `userknownhostsfile` carries the whitespace-separated LIST ssh will consult,
 * with the learned key going to the first entry.
 *
 * WHITESPACE IS THE ONLY SEPARATOR `-G` OFFERS, and it is ambiguous. This used
 * to reject any value containing `"` on the stated ground that "OpenSSH quotes
 * paths that contain spaces" — it does not. Verified against the same
 * OpenSSH_9.6p1 Ubuntu-3ubuntu13.18 the rest of this file cites, `-G` STRIPS
 * the quoting it was given and prints the resolved value raw:
 *
 *     config:  UserKnownHostsFile "/tmp/my hosts" /tmp/second
 *     output:  userknownhostsfile /tmp/my hosts /tmp/second
 *
 * A single-quoted value, a backslash-escaped space, and a command-line
 * `-o UserKnownHostsFile="…"` all come back the same way, and multiple spaces
 * and tabs are collapsed to one space each. So the old guard never fired on
 * the case it was written for, and the ONE thing it did fire on was a path
 * that genuinely contains a `"` (`UserKnownHostsFile /tmp/wei\"rd` →
 * `userknownhostsfile /tmp/wei"rd`) — a legitimate path this then declined to
 * read. It is gone.
 *
 * Nothing replaces it, because nothing can: `/tmp/my hosts /tmp/second` is
 * indistinguishable here from a two-entry list, and there is no `-G` flag that
 * disambiguates. The tokens are returned and the caller splits the difference
 * by NAMING the whole resolved value in its refusal — see
 * {@link sshKnownHostsUnwritableError} — so an operator whose path contains a
 * space is told what ssh actually resolved and which entry was probed, instead
 * of being refused over a fragment.
 */
export function knownHostsFromSshConfig(gOutput: string): readonly string[] | null {
  for (const line of gOutput.split('\n')) {
    const [keyword, ...paths] = line.trim().split(/\s+/);
    if (keyword?.toLowerCase() !== 'userknownhostsfile') continue;
    if (paths.length === 0) return null;
    return paths;
  }
  return null;
}

function knownHostsRedirectedMessage(destination: string, path: string): string {
  return (
    `execution.ssh: ssh's own configuration resolves UserKnownHostsFile to '${path}' for ` +
    `'${destination}', and that destination cannot persist a learned host key. With ` +
    "strictHostKeys 'accept-new' every connection would then be a first connection and would " +
    'accept whatever key is offered, while this config claims the key is pinned. Remove that ' +
    'setting from your ssh config, or point execution.ssh.knownHostsFile at a writable path — ' +
    'Ethos passes that on the command line, where it outranks the config file.'
  );
}

type Writability = 'writable' | 'unwritable' | 'missing';

function writability(path: string): Writability {
  try {
    accessSync(path, fsConstants.W_OK);
    return 'writable';
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return 'missing';
    return 'unwritable';
  }
}

/**
 * `path` with a leading `~` resolved, or `null` when this process cannot say
 * what the path is.
 *
 * `UserKnownHostsFile` also accepts the `%`-tokens and `${ENV}` expansions
 * ssh_config(5) describes, and `~user` needs a passwd lookup. None of those can
 * be resolved here, so the probe DECLINES rather than guessing at a path that
 * may not be the one ssh writes — refusing a target on a mis-resolved path
 * would be worse than the gap it closes.
 */
function expandHome(path: string): string | null {
  if (path.includes('%') || path.includes('$')) return null;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  if (path.startsWith('~')) return null;
  return path;
}

function knownHostsUnwritableMessage(
  file: string,
  problem: string,
  fix: string,
  ambiguity = '',
): string {
  return (
    `execution.ssh: with strictHostKeys 'accept-new' the learned host key is written to ` +
    `'${file}', but ${problem}. ssh WARNS AND CONTINUES when it cannot record a key, so ` +
    'every connection would be a first connection and would accept whatever key is ' +
    `offered. ${fix}, or set execution.ssh.strictHostKeys: yes with the key already in place.` +
    ambiguity
  );
}

/**
 * The sentence appended when the probed path is the first entry of a
 * MULTI-ENTRY `ssh -G` value.
 *
 * It exists because that split can be wrong and the operator is the only one
 * who can tell. `-G` separates entries with whitespace and prints a
 * space-containing path raw (see {@link knownHostsFromSshConfig}), so
 * `userknownhostsfile /etc/ssh known_hosts` is either a two-entry list or one
 * path named `/etc/ssh known_hosts`. Ethos reads it the first way — which is
 * right for every path without a space, including ssh's own two-entry default
 * — and then fails closed on `/etc/ssh` if that is not writable.
 *
 * Failing closed on the wrong reading is still the safer half of the trade: the
 * cost of being wrong here is a refused execution the operator can fix, and the
 * cost of guessing the other way is a target that silently pins nothing. What
 * is NOT acceptable is a refusal naming only `/etc/ssh`, a path the operator
 * never configured and cannot find in any file. So the whole resolved value is
 * named, the entry probed is named, and the escape hatch is named.
 */
function knownHostsAmbiguityNote(destination: string, value: string, probed: string): string {
  return (
    ` (ssh's own configuration resolves UserKnownHostsFile to '${value}' for '${destination}'; ` +
    `Ethos read that as a whitespace-separated list and probed its first entry, '${probed}'. ` +
    'If it is instead ONE path containing a space, `ssh -G` gives no way to say so — it strips ' +
    'the quoting from the config file — so set execution.ssh.knownHostsFile to the real path, ' +
    'which Ethos passes on the command line where it outranks the config file.)'
  );
}

/**
 * Why the effective known-hosts destination cannot PERSIST a learned key on
 * this machine, or `null` when it can.
 *
 * {@link sshKnownHostsError} refuses the values that keep nothing by
 * construction. This is the other half of the same promise: `accept-new` means
 * "learn the key on first sight, refuse it if it ever changes", and the second
 * clause is bought entirely by the write succeeding. It often does not — and
 * OpenSSH does not treat that as an error. Verified against OpenSSH 9.6p1
 * against a real sshd, for an unwritable destination and for a missing parent
 * directory alike:
 *
 *     Failed to add the host to the list of known hosts (…/known_hosts).
 *     REMOTE_OK
 *     exit=0
 *
 * The remote command RAN, ssh exited 0, and nothing was pinned. Repeat that and
 * every connection is a first connection: silent MITM exposure, while
 * `config.yaml` and the character sheet both say the host key is pinned. So the
 * refusal has to happen BEFORE ssh is spawned, not be inferred afterwards from
 * a warning line buried in the tool's stderr.
 *
 * Only `accept-new` is probed. Under `yes` nothing is ever learned — an unknown
 * host is refused outright — so whether a key COULD be written is irrelevant,
 * and a deliberately read-only known_hosts is a legitimate `yes` deployment
 * this must not break.
 *
 * A file that does not exist yet is fine and must stay fine: `accept-new`
 * creates it on the first connection, which is exactly how an operator adopts a
 * dedicated `knownHostsFile`. What must hold in that case is the DIRECTORY.
 * Same OpenSSH 9.6p1 run: a missing directory is not created and the write
 * fails — with one exception, `~/.ssh` itself, which ssh makes for itself
 * (`hostfile_create_user_ssh_dir`, and the "Could not create directory" string
 * is in the shipped binary) and only there. A missing `~/.ssh` therefore defers
 * to the home directory, so a fresh container is not refused for a directory
 * ssh would have created.
 *
 * WHICH file is itself a question this cannot answer lexically when
 * `knownHostsFile` is unset — the common case. Ethos then passes no
 * `-o UserKnownHostsFile`, so the operator's `~/.ssh/config` decides, and a
 * `Host build-01` block setting `UserKnownHostsFile /dev/null` makes a probe of
 * `~/.ssh/known_hosts` PASS on a file ssh never opens: nothing is pinned, which
 * is the exact state this check exists to refuse. `ssh -G` answers the real
 * question — it resolves the effective config for a destination without
 * connecting — so that is what the unset case consults
 * ({@link runSshDashG}). A configured `knownHostsFile` needs no such lookup:
 * it is passed as a command-line `-o`, which outranks the config file.
 *
 * FAIL OPEN on not knowing; fail closed only on knowing. No ssh binary, a
 * non-zero `-G`, a timeout, or output with no `userknownhostsfile` line — all
 * fall back to {@link DEFAULT_KNOWN_HOSTS}, which is the behaviour that shipped
 * before `-G` was consulted, so an ssh that formats its resolved config
 * differently is no worse off than it was. Refusing every execution on an
 * unrecognised subprocess result would take working deployments down over a
 * check that is advisory. A `-G` that DOES name a destination keeping nothing
 * is positive evidence, and is refused.
 *
 * The ONE place it fails closed without knowing is a multi-entry `-G` value,
 * whose entry boundaries `-G` does not express unambiguously. It is read as a
 * list and the first entry is probed — right for every path without a space,
 * including ssh's own two-entry default — and the refusal then carries
 * {@link knownHostsAmbiguityNote}, which names the whole resolved value, the
 * entry probed, and how to override it. A refusal naming only a fragment of a
 * path the operator never typed was the bug that made this note necessary.
 *
 * Not cached. It runs only under `accept-new` with `knownHostsFile` unset, once
 * per exec and once per probe; the `-G` subprocess is asynchronous
 * ({@link runSshDashG}) so waiting on it costs the process nothing. A cache
 * would have to be invalidated on `~/.ssh/config` edits, which is the same
 * live-filesystem staleness this check already refuses to accept for the
 * writability half.
 *
 * Deliberately NOT duplicated into `packages/config` the way the lexical check
 * is. That one refuses a VALUE, which is as true at boot as it ever will be;
 * this one reads the filesystem, which a `chmod`, a mount, or a container's
 * first run can change under a process that is already up.
 */
export async function sshKnownHostsUnwritableError(
  ssh: SshTarget,
  resolveConfig: SshConfigResolver = runSshDashG,
): Promise<string | null> {
  if ((ssh.strictHostKeys ?? 'accept-new') !== 'accept-new') return null;

  let subject = ssh.knownHostsFile?.split(/\s+/).filter((p) => p.length > 0)[0];
  // Non-empty only when `subject` came from a MULTI-ENTRY `ssh -G` value, i.e.
  // when the split that produced it could have been the wrong reading.
  let ambiguity = '';
  if (subject === undefined) {
    const output = await resolveConfig(ssh);
    const effective = output === null ? null : knownHostsFromSshConfig(output);
    // Every entry is checked, not just the first, for the same reason
    // {@link sshKnownHostsError} checks every entry of the configured list: a
    // list is only as trustworthy as what ssh actually consults.
    for (const path of effective ?? []) {
      if (NON_PERSISTENT_KNOWN_HOSTS.has(path.toLowerCase())) {
        return knownHostsRedirectedMessage(sshDestination(ssh), path);
      }
    }
    subject = effective?.[0] ?? DEFAULT_KNOWN_HOSTS;
    if (effective !== null && effective.length > 1) {
      // `-G` collapses runs of whitespace to a single space (verified 9.6p1),
      // so re-joining the tokens reproduces the value it printed.
      ambiguity = knownHostsAmbiguityNote(sshDestination(ssh), effective.join(' '), subject);
    }
  }
  const file = expandHome(subject);
  if (file === null) return null;

  const fileState = writability(file);
  if (fileState === 'writable') return null;
  if (fileState === 'unwritable') {
    return knownHostsUnwritableMessage(
      file,
      'that file is not writable',
      `Make it writable (chmod u+w '${file}')`,
      ambiguity,
    );
  }

  const parent = dirname(file);
  const sshDir = join(homedir(), '.ssh');
  const dir = parent === sshDir && writability(parent) === 'missing' ? homedir() : parent;
  const dirState = writability(dir);
  if (dirState === 'writable') return null;
  if (dirState === 'missing') {
    return knownHostsUnwritableMessage(
      file,
      `its directory '${dir}' does not exist and ssh will not create it`,
      `Create it (mkdir -p '${dir}')`,
      ambiguity,
    );
  }
  return knownHostsUnwritableMessage(
    file,
    `its directory '${dir}' is not writable`,
    `Make it writable (chmod u+w '${dir}')`,
    ambiguity,
  );
}

function sshDestination(ssh: SshTarget): string {
  return ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host;
}

/**
 * The ssh argv for one invocation, up to and including the destination and the
 * remote words.
 *
 * `-o BatchMode=yes` — never prompt; a passphrase prompt on a background exec
 * hangs forever. `-T` — no pseudo-tty, so remote output is not line-disciplined
 * and stdout/stderr stay separable.
 *
 * `-o PermitLocalCommand=no` — the operator's own `~/.ssh/config` is TRUSTED
 * input, but it is also the one place where a command this backend calls REMOTE
 * can be made to run locally without anything here being wrong. A `Host`/`Match`
 * block matching the destination may set `LocalCommand`, which ssh runs ON THE
 * ETHOS HOST with the user's shell after every successful connection. This pins
 * it off: a command-line `-o` is read before any config file and ssh keeps the
 * FIRST value it obtains for an option, so a `PermitLocalCommand yes` in the
 * config file cannot win. Verified against OpenSSH 9.6p1 — with a config file
 * setting `PermitLocalCommand yes`, `ssh -F cfg -o PermitLocalCommand=no -G`
 * resolves `permitlocalcommand no`.
 *
 * It closes `LocalCommand` and the `!command` escape and NOTHING ELSE
 * (ssh_config(5): "Allow local command execution via the LocalCommand option or
 * using the !command escape sequence in ssh(1)"). `ProxyCommand`, `ProxyJump`
 * and `Match exec` still execute on the Ethos host and are still reachable from
 * the operator's config. That is deliberate: `-F none` would close them by
 * disabling the config file wholesale, taking the jump hosts and host aliases a
 * large share of real deployments need in order to reach anything. The residue
 * is documented for operators in `docs/content/using/how-to/run-tools-over-ssh.md`
 * rather than papered over here.
 *
 * Host keys default to `accept-new` (TOFU:
 * unknown hosts are learned, CHANGED ones still refused); `strictHostKeys` is
 * forwarded verbatim when the operator set it. The "changed ones refused" half
 * only holds if the learned key is KEPT, so `knownHostsFile` is refused before
 * this point when it names a destination that keeps nothing — see
 * {@link sshKnownHostsError} — and when the effective destination is one this
 * machine cannot write (see {@link sshKnownHostsUnwritableError}). There is no
 * argv-level neutralisation for that
 * the way `--` neutralises a hostile destination: `UserKnownHostsFile=none`
 * means exactly what it says.
 *
 * The `--` goes BEFORE the destination, which is where ssh honours it. A
 * TRAILING `--` would be wrong for the reason an earlier lane removed one: ssh
 * ends option parsing at the destination, so anything after it is sent to the
 * remote verbatim and a trailing `--` runs as the remote command's argv[0].
 *
 * Verified against OpenSSH 9.6p1:
 *   - `ssh -G -- '-oProxyCommand=touch /tmp/x' true` → `hostname contains
 *     invalid characters`; the option is NOT applied and nothing runs locally.
 *     Without the `--` the same argument resolves to `proxycommand touch
 *     /tmp/x`, i.e. local execution.
 *   - `ssh -G -- deploy@build-01 <words>` and the same line without `--`
 *     produce byte-identical resolved config, so the terminator costs an
 *     ordinary destination nothing.
 *   - Remote words after a `--`'d destination are still remote words: `ssh -G
 *     -- build-01 -o ProxyCommand=touch` sets no local proxycommand.
 */
export function buildSshArgs(
  ssh: SshTarget,
  remoteWords: readonly string[],
  connectTimeoutSec: number = EXEC_CONNECT_TIMEOUT_SEC,
): string[] {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    `ConnectTimeout=${connectTimeoutSec}`,
    '-T',
    '-o',
    `StrictHostKeyChecking=${ssh.strictHostKeys ?? 'accept-new'}`,
  ];
  if (ssh.knownHostsFile) args.push('-o', `UserKnownHostsFile=${ssh.knownHostsFile}`);
  if (ssh.port !== undefined) args.push('-p', String(ssh.port));
  if (ssh.identityFile) args.push('-i', ssh.identityFile);
  args.push('--', sshDestination(ssh), ...remoteWords);
  return args;
}

/**
 * The remote words for `cmd` (plan §5, D8).
 *
 * ssh joins its remote words with spaces and hands the result to the remote
 * LOGIN shell, which parses it — so the script is quoted once here and arrives
 * as a single `sh -c` argument.
 *
 * cwd policy (D8): the host's `ctx.workingDir` is never sent anywhere near this
 * function. The remote cwd is `opts.cwd` when the tool call supplied one (used
 * verbatim as a REMOTE path), else `ssh.remoteWorkdir`, else nothing — in which
 * case the remote login directory stands.
 *
 * `shell: false` means ONE thing here: do not put a QUOTING layer around `cmd`.
 * The caller composed `cmd` as a ready remote command line for a stdin-driven
 * runner (`python3 -`, `node --input-type=module`, `bash -s`), so it is
 * interpolated raw and parsed by exactly one shell — the same single parse the
 * unwrapped form gets from the remote login shell.
 *
 * It does NOT mean "no remote cwd", which is what it used to mean by accident.
 * `sh -c` does not consume its child's stdin — the runner inherits the
 * descriptor and still reads the program from it — so the cwd can and must be
 * applied to `run_code` too, which otherwise ran in the remote LOGIN directory
 * while `config.yaml`, the character sheet and the injected prompt all said
 * `remoteWorkdir`. Verified: `printf 'import os; print(os.getcwd())' | sh -c
 * "cd '/tmp/x' && exec python3 -"` prints `/tmp/x`, and the same shape carries
 * stdin to `node --input-type=module` and `bash -s`.
 *
 * `exec` is why the wrap is free: the runner REPLACES the wrapping shell, so
 * its pid, its signal disposition and its exit status are the remote command's
 * own (`sh -c "cd /tmp/x && exec python3 -"` on a script calling `sys.exit(7)`
 * exits 7). With no workdir to apply there is nothing to wrap and `cmd` is sent
 * as-is.
 */
export function buildRemoteWords(ssh: SshTarget, cmd: string, opts: ExecOpts): string[] {
  const workdir = opts.cwd ?? ssh.remoteWorkdir;
  if (opts.shell === false) {
    if (!workdir) return [cmd];
    return ['sh', '-c', shellQuote(`cd ${shellQuote(workdir)} && exec ${cmd}`)];
  }
  const script = workdir ? `cd ${shellQuote(workdir)} && ${cmd}` : cmd;
  return ['sh', '-c', shellQuote(script)];
}

/**
 * Queue-backed async generator that streams interleaved stdout/stderr chunks
 * from a spawned ssh client. Self-contained per backend (duplicated, not
 * shared) so each execution package has zero cross-package coupling.
 *
 * Timeout (plan D6): the timer kills the LOCAL ssh client only. There is no
 * remote `timeout(1)` wrapper — it is GNU coreutils, not POSIX, and this
 * backend targets POSIX remotes. Killing the client drops the connection and
 * sshd normally hangs up the remote session, but a remote process that ignores
 * SIGHUP, or has detached from it, MAY SURVIVE the timeout. Same for abort.
 */
async function* streamChild(child: ChildProcess, opts: ExecOpts): AsyncIterable<ExecChunk> {
  const chunks: ExecChunk[] = [];
  let done = false;
  let error: Error | null = null;
  let resolveNext: (() => void) | null = null;
  let exitCode: number | null = null;
  const stderrHead = createDiagnosticBuffer();

  child.stdout?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stdout', data: c.toString('utf-8') });
    resolveNext?.();
  });
  child.stderr?.on('data', (c: Buffer) => {
    stderrHead.push(c);
    chunks.push({ stream: 'stderr', data: c.toString('utf-8') });
    resolveNext?.();
  });
  // ssh propagates the remote command's exit status as its own exit code, and
  // uses 255 for its OWN failures. Exit 255 with a diagnostic ssh wrote about
  // itself on stderr ({@link isSshDiagnostic}) is ssh failing; exit 255 without
  // one is the remote command genuinely exiting 255, which is passed through as
  // an ordinary exit chunk.
  child.on('close', (code) => {
    exitCode = code ?? null;
    if (code === 255) {
      const diagnostic = stderrHead.text().split('\n').filter(isSshDiagnostic).join('; ').trim();
      if (diagnostic) error = new SshTransportError(diagnostic);
    }
    done = true;
    resolveNext?.();
  });
  child.on('error', (err: Error) => {
    error = err;
    done = true;
    resolveNext?.();
  });

  const timeoutMs = opts.timeoutMs ?? 30000;
  const timer = setTimeout(() => {
    error = new ExecTimeoutError();
    child.kill();
    done = true;
    resolveNext?.();
  }, timeoutMs);

  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) {
      error = new ExecAbortedError();
      done = true;
    } else {
      signal.addEventListener(
        'abort',
        () => {
          error = new ExecAbortedError();
          child.kill();
          done = true;
          resolveNext?.();
        },
        { once: true },
      );
    }
  }

  if (opts.stdin !== undefined) child.stdin?.write(opts.stdin, 'utf-8');
  child.stdin?.end();

  try {
    while (true) {
      while (chunks.length > 0) {
        const c = chunks.shift();
        if (c) yield c;
      }
      if (error) throw error;
      if (done) {
        while (chunks.length > 0) {
          const c = chunks.shift();
          if (c) yield c;
        }
        yield { stream: 'exit', code: exitCode ?? -1 };
        break;
      }
      await new Promise<void>((r) => {
        resolveNext = r;
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Byte-ceiling wrapper. Counts bytes yielded by `inner`; once the running total
 * exceeds `maxBytes` it kills the ssh client, emits a final stderr truncation
 * marker, and stops. The cap is enforced HERE — inside the exec stream — so
 * host memory stays bounded regardless of downstream result trimming.
 *
 * Copied — not imported — from `extensions/execution-docker/src/index.ts:465`,
 * per the repo's cross-package rule. The only difference is what `onCeiling`
 * kills: docker kills the container, this kills the local client (the remote
 * process may survive, exactly as for a timeout — see {@link streamChild}).
 */
export async function* withByteCeiling(
  inner: AsyncIterable<ExecChunk>,
  maxBytes: number,
  onCeiling: () => void,
): AsyncIterable<ExecChunk> {
  let total = 0;
  for await (const chunk of inner) {
    // The terminal exit chunk carries no payload — pass it through untouched so
    // the exit code survives truncation, and don't count it toward the ceiling.
    if (chunk.stream === 'exit') {
      yield chunk;
      continue;
    }
    total += Buffer.byteLength(chunk.data, 'utf-8');
    if (total > maxBytes) {
      onCeiling();
      yield { stream: 'stderr', data: `\n[output truncated at ${maxBytes} bytes]\n` };
      return;
    }
    yield chunk;
  }
}

/**
 * SSH execution backend.
 *
 * NOTE: the ssh backend provides remote-host trust ONLY; it does NOT enforce
 * fs_reach mount-confinement and is EXCLUDED from the Phase-2a
 * Success-Criterion-1 containment guarantee (review A3). Commands run on a
 * remote host's real filesystem; there is no per-personality mount allowlist.
 */
export class SshExecutionBackend implements ExecutionBackend {
  readonly name = 'ssh';
  private readonly config: ExecutionBackendConfig;
  private readonly logger: Logger;
  /**
   * Retained for a later passphrase-less `${secrets:}` key feature (plan D3).
   * v1 authenticates with a key PATH or a running ssh-agent and never reads
   * this — no vault materialisation, no temp files, no cleanup lifecycle.
   */
  readonly secrets: SecretsResolver;
  /** Epoch ms until which a successful probe is trusted. Failures never set it. */
  private availableUntil = 0;
  /**
   * stderr from the most recent FAILED probe, so a caller that got `false` from
   * {@link isAvailable} can say why without opening a second connection.
   */
  lastProbeError: string | undefined;
  /**
   * The ssh target this instance was CONSTRUCTED with — a frozen copy taken in
   * the constructor, never re-read.
   *
   * The registry MEMOISES: once `resolve('ssh', ctx)` has built one of these,
   * every later caller gets this same object, whatever config they passed. So
   * after an operator edits `execution.ssh.*` the running backend — the one the
   * tools actually execute on — still points at the OLD machine until the
   * process restarts. A surface that pairs freshly-read config with this
   * instance would name one host and contact another; comparing against this
   * field is how it can tell instead. Frozen, and a copy, because the identity
   * has to be the thing this backend will really dial for the rest of its life.
   */
  readonly configuredTarget: Readonly<SshTarget> | undefined;

  constructor(ctx: { config: ExecutionBackendConfig; secrets: SecretsResolver; logger: Logger }) {
    this.config = ctx.config;
    this.secrets = ctx.secrets;
    this.logger = ctx.logger;
    this.configuredTarget = ctx.config.ssh ? Object.freeze({ ...ctx.config.ssh }) : undefined;
  }

  /**
   * Asynchronous because the known-hosts probe consults `ssh -G`, which is a
   * subprocess this process must not block on — see {@link runSshDashG}. Its
   * only caller is {@link exec}, an async generator, so awaiting is free.
   */
  private async target(): Promise<SshTarget> {
    const ssh = this.config.ssh;
    if (!ssh?.host) throw new SshHostMissingError();
    const invalid = sshDestinationError(ssh);
    if (invalid) throw new SshDestinationInvalidError(invalid);
    const knownHosts = sshKnownHostsError(ssh) ?? (await sshKnownHostsUnwritableError(ssh));
    if (knownHosts) throw new SshKnownHostsInvalidError(knownHosts);
    return ssh;
  }

  /**
   * One uncached reachability check: `ssh -o BatchMode=yes -o ConnectTimeout=5
   * <target> true`. Returns the failure's stderr verbatim — `Permission denied
   * (publickey)` and `Connection timed out` need different fixes and only the
   * real line says which.
   */
  async probe(): Promise<{ ok: boolean; error?: string }> {
    const ssh = this.config.ssh;
    if (!ssh?.host) {
      return { ok: false, error: new SshHostMissingError().message };
    }
    // Mirrors the missing-host guard rather than throwing: `isAvailable` must
    // still answer false (uncached) for an unusable target, not reject. The
    // writability probe belongs here too — a probe connection under
    // `accept-new` is itself a first connection that learns and pins a key, so
    // it must not run against a destination that cannot keep one.
    const invalid =
      sshDestinationError(ssh) ??
      sshKnownHostsError(ssh) ??
      (await sshKnownHostsUnwritableError(ssh));
    if (invalid) return { ok: false, error: invalid };
    const args = buildSshArgs(ssh, ['true'], PROBE_CONNECT_TIMEOUT_SEC);
    return new Promise((resolve) => {
      const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const stderr = createDiagnosticBuffer();
      child.stderr?.on('data', (c: Buffer) => {
        stderr.push(c);
      });
      child.on('close', (code) => {
        if (code === 0) resolve({ ok: true });
        else
          resolve({ ok: false, error: stderr.text().trim() || `ssh exited with status ${code}` });
      });
      child.on('error', (err: Error) => resolve({ ok: false, error: err.message }));
    });
  }

  /**
   * Reachability of the configured target — NOT whether an ssh binary exists
   * locally. A success is trusted for 60 s; a FAILURE is never cached, so a
   * transient network blip does not pin the backend to `not_available` for a
   * minute. The failing stderr is kept in {@link lastProbeError}.
   */
  async isAvailable(): Promise<boolean> {
    if (Date.now() < this.availableUntil) return true;
    const result = await this.probe();
    if (result.ok) {
      this.availableUntil = Date.now() + AVAILABILITY_TTL_MS;
      this.lastProbeError = undefined;
      return true;
    }
    this.lastProbeError = result.error;
    this.logger.debug(`ssh backend unavailable: ${result.error}`);
    return false;
  }

  async *exec(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk> {
    const ssh = await this.target();
    const envKeys = Object.keys(opts.env ?? {});
    if (envKeys.length > 0) throw new SshEnvUnsupportedError(envKeys);
    const args = buildSshArgs(ssh, buildRemoteWords(ssh, cmd, opts));
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    yield* withByteCeiling(streamChild(child, opts), MAX_EXEC_OUTPUT_BYTES, () => {
      child.kill();
    });
  }

  /**
   * Thin session — the same shape `execution-local` uses, and the one
   * `ExecSession.stop?` in `@ethosagent/types` names explicitly ("local/ssh
   * thin sessions"). Each `exec` opens its OWN ssh connection, so nothing
   * persists across calls: no shared shell, no surviving cwd or exported
   * variables, and no in-session pid to signal (hence no `stop`). A persistent
   * remote shell would need ControlMaster, which is out of scope; nothing wraps
   * this backend in `SessionManager` (plan D5).
   */
  spawnSession(personalityId: string): ExecSession {
    return {
      personalityId,
      exec: (cmd: string, opts: ExecOpts = {}) => this.exec(cmd, opts),
      dispose: () => Promise.resolve(),
    };
  }

  mountsFor(_p: PersonalityConfig): MountSpec[] {
    // ssh "mounts" are remote paths, NOT mount-confined. Lane B may revisit;
    // this backend is not part of the Phase-2a containment claim (review A3).
    return [];
  }

  attest(): SandboxAttestation {
    // SSH is remote-host trust, NOT mount-confined (review A3).
    // Commands run on a remote host's real filesystem with no per-personality
    // mount allowlist. Only noDockerSocket is true — the remote host's docker
    // socket is not mounted via SSH.
    return {
      readonlyRootFs: false,
      noHostMounts: false,
      egressControlled: false,
      noDockerSocket: true,
      nonRoot: false,
      noPrivileged: false,
      noCapAdd: false,
      capDropAll: false,
      noNewPrivs: false,
    };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
