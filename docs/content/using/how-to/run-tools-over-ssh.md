---
title: Run agent tools on a remote host
description: Route terminal, run_code, run_tests and lint to a remote machine over ssh — the config, the host-key policy, and what the remote host is exposed to.
kind: how-to
audience: user
slug: run-tools-over-ssh
time: 15 min
updated: 2026-09-05
---

Point one agent's shell tools at a build box, a GPU node, or a staging server instead of the machine Ethos runs on. The remote target is yours to pick once, per deployment; which agents reach for it is a property of each [personality](../../getting-started/glossary.md#personality) (a directory of files that decides an agent's tools, memory, and model).

## Task

Route a personality's execution tools to a remote host over ssh.

## Result

`terminal`, `run_code`, `run_tests` and `lint` run on the remote host. `read_file` and `write_file` keep running on the Ethos host. `ethos personality show` reports the `ssh` posture.

## Read this before you enable it

**`terminal` gives the model unrestricted file access on the remote host, by design.** Only the four execution tools are routed. File tools stay on the Ethos machine, confined by that personality's `fs_reach` allowlist and the non-overridable deny floor in [`scoped-fs.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/scoped/scoped-fs.ts) — and **there is no remote equivalent of either**. Nothing re-implements the path allowlist or the deny floor on the other side of the connection. Enabling `execution: remote` hands the agent a shell on another machine with exactly the reach of the login user, and the framework will not narrow it for you.

Narrow it yourself, on the remote host: a dedicated unprivileged user, a key restricted to that user, and no sudo. Treat the target as a machine the agent owns, not as a machine you also use. An exec-backed remote filesystem with its own deny floor is planned, not shipped.

**Your `~/.ssh/config` is trusted input, and it can pull a "remote" command back onto this machine.** Ethos connects with `-o PermitLocalCommand=no`, which pins off `LocalCommand` and the `!command` escape — a `Host` block setting `LocalCommand` would otherwise run a command on the Ethos host after every successful connection while the posture reports the work as remote. A command-line `-o` beats a config-file value, so a `PermitLocalCommand yes` in your config cannot re-enable it.

`ProxyCommand`, `ProxyJump` and `Match exec` are **not** closed. They run on the Ethos host by design — it is how a deployment reaches a target through a bastion — and disabling the config file wholesale to close them would take your jump hosts and host aliases with it. Read the `ssh` posture's claim precisely: the *command* runs remotely, not "nothing runs locally." A config block matching your target is code you are choosing to run; if it is not yours to trust, the target is not one to route an agent at.

**`process_*` tools are not routed over ssh.** A personality on the ssh posture cannot start, list, watch, or stop long-running processes on the remote host. The remote lifecycle design (signalling, environment, reconnection) is deferred.

**A constitution that requires a sandbox still refuses remote execution.** ssh is remote-host trust, not confinement, so a personality under `execution.requireSandbox` or `execution.forbidLocal` gets its execution tools refused rather than routed. The refusal is an unconditional rule about the ssh posture — either flag being `true` refuses it, in [`resolve-execution-posture.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/resolve-execution-posture.ts) — not a judgement about a particular target's security. Nothing you can configure on the remote host will satisfy it. See [Recover from constitution safe mode](safe-mode.md) for where the constitution lives.

## Prerequisites

- An `ssh` client on the Ethos host.
- Key-based authentication to the target that succeeds with no prompt. Ethos connects with `BatchMode=yes`, so a passphrase prompt does not appear — it fails. Use an unencrypted key file or a loaded `ssh-agent`.
- Write access to `~/.ethos/config.yaml` and to the personality directory.

## Steps

### 1. Confirm the target answers without a prompt

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 deploy@build-01.internal true; echo "exit=$?"
```

```
exit=0
```

Any other exit code means Ethos cannot connect either. Fix it here, before touching config.

### 2. Declare the target in `~/.ethos/config.yaml`

The target is operator config: one host per deployment, no roster, no per-personality override.

```yaml
execution.ssh.host: build-01.internal
execution.ssh.user: deploy
execution.ssh.identityFile: ~/.ssh/id_ed25519_ethos
execution.ssh.strictHostKeys: accept-new
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `execution.ssh.host` | string | — | Hostname or IP of the target. **Its presence is the switch**: without it the whole block is absent and an `execution: remote` personality has its execution tools refused. Must not be empty. |
| `execution.ssh.user` | string | ssh's own resolution | Remote login user. Absent means the local username, or whatever `~/.ssh/config` matches for this host. |
| `execution.ssh.port` | integer | `22` | Remote sshd port. Must be 1–65535. |
| `execution.ssh.identityFile` | string | ssh-agent or ssh's default key search | Private key **path**, passed as `ssh -i`. Never key material, and passphrase-protected keys are not supported. |
| `execution.ssh.knownHostsFile` | string | `~/.ssh/known_hosts` | Passed as `-o UserKnownHostsFile=`. Use it to keep the agent's pinned host keys out of your own file. A destination that cannot *persist* a learned key — `none`, `/dev/null`, or a whitespace-separated list containing either — is rejected: nothing is written back, so every connection is a first connection and accepts whatever key it is offered. That is `strictHostKeys: no` by another route. A path that does not exist yet is fine; `accept-new` creates it on the first connection. Under `accept-new` Ethos also checks, before it connects, that the file — or the directory it would be created in — is writable by this process, and refuses the connection naming the path if it is not. That check runs on ssh's own `~/.ssh/known_hosts` when this key is unset. |
| `execution.ssh.strictHostKeys` | `accept-new` \| `yes` | `accept-new` | Passed verbatim as `-o StrictHostKeyChecking=`. `accept-new` learns an unknown host key once and then pins it; a *changed* key is still refused. `yes` requires the key to be in the known-hosts file already, and skips the writability check — nothing is learned, so nothing has to be persisted, and a deliberately read-only known-hosts file works. `no` is deliberately not accepted — it turns host-key verification off, and this surface will not spell that. |
| `execution.ssh.remoteWorkdir` | string | the remote login directory | The working directory **on the remote host**. Absent means the backend does not `cd` at all — not `/`, and never the Ethos host's own working directory, which is not sent to the remote. |

Two failure shapes are worth knowing before you save:

- **A malformed value is fatal.** Once `host` is present, a bad `port` or a `strictHostKeys` value outside the two accepted ones is a config parse error. `ethos boot` and `ethos gateway` print it and exit non-zero rather than start with a weaker guarantee than you wrote down.
- **A misspelled key is silent.** `execution.ssh.workdir` is not `remoteWorkdir`; it is an unrecognised key, and stray keys are dropped with no diagnostic at all. Copy the names from the table.

### 3. Set the requirement on the personality

Add one line to `~/.ethos/personalities/<id>/config.yaml`:

```yaml
execution: remote
```

The personality states a *requirement* — this agent's work belongs on another machine — and never names the transport or the machine. Never put the hostname, user, or key path here. See [`execution`](../reference/personality-yaml.md#execution) for both values.

:::note Upgrading from `execution: ssh`
`execution: ssh` is no longer accepted and fails the load with an error naming `remote`. Change the line; the `execution.ssh.*` block in `~/.ethos/config.yaml` is unchanged.
:::

### 4. Restart Ethos

Posture is resolved when a loop is composed, so an already-running process keeps the posture it started with.

## Verify

Ask for the character sheet:

```bash
ethos personality show remote-hands
```

The `## Execution` block names the posture (excerpt):

```
## Execution
- Posture:    ssh (remote host)
```

Then ask the agent to run `terminal: hostname` in chat. The answer is the remote host's name, not yours. Ask it to `read_file` something under its `fs_reach` and you get a file from *this* machine — that split is the design, not a bug.

## Troubleshoot

### `Permission denied (publickey)` reported as exit 255

ssh prints authentication refusals without its usual `ssh:` prefix, so Ethos cannot tell them apart from a remote command that genuinely exited 255. They surface as a remote failure rather than a transport error. The text is the diagnosis: re-run step 1 by hand and fix the key, the user, or the remote `authorized_keys`.

### The tool timed out but the remote command kept running

The timeout kills the **local ssh client only**. There is no remote `timeout` wrapper — `timeout(1)` is GNU coreutils, not POSIX, and the backend targets POSIX remotes. Dropping the connection normally makes sshd hang up the remote session, but a process that ignores `SIGHUP` or has detached from it **may survive**. The same is true of an aborted call and of the 1,000,000-byte output ceiling, which ends the stream with `[output truncated at 1000000 bytes]`. If a remote command must be killed for certain, kill it on the remote host.

### `the learned host key is written to <path>, but ...`

The tool call is refused before ssh runs, because the known-hosts destination cannot be written: the file is read-only, its directory is read-only, or its directory does not exist. `accept-new` promises to refuse a *changed* key, and that promise is only as good as the key being recorded — OpenSSH prints `Failed to add the host to the list of known hosts` and **continues**, so an unwritable path would leave every connection unpinned while the config claimed otherwise.

The message names the path and the fix (`mkdir -p` or `chmod u+w`). Run it, or point `execution.ssh.knownHostsFile` at a path the Ethos process owns. With the key already in place, `strictHostKeys: yes` is the other valid answer.

### Commands run in the wrong directory

`remoteWorkdir` is a path on the target. If it is absent the commands run wherever the ssh login lands, which is usually the remote user's home directory — not the directory you started Ethos in.

### Environment variables do not reach the remote

They cannot: `AcceptEnv` is sshd-side operator config the backend cannot see, and inlining assignments into the command string would change its quoting. Set them inside the command instead (`FOO=bar ./script.sh`).

### The character sheet says `execution refused: … no execution.ssh.host is configured`

The personality requires `remote` and this deployment has no target, so its execution tools are unavailable. They are **not** run here instead: `remote` is a requirement, and the host is the one machine it excludes. Complete step 2.

## See also

- [Personality config reference — `execution`](../reference/personality-yaml.md#execution)
- [What does Ethos guarantee, and what is outside its security boundary?](../../security/security-boundary.md#g-exec)
- [Recover from constitution safe mode](safe-mode.md)
- [What is the threat model?](../../security/threat-model.md)
