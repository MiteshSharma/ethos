---
title: Security controls
description: Catalogue of shipped, partial, and planned security controls — channel, tool, filesystem, network, injection, watcher, redaction, install, audit.
kind: reference
audience: shared
slug: security-controls
updated: 2026-06-09
---

Most controls on this page are shipped — code in `packages/` and `extensions/`, tests next to it, audit trail in `observability.db`. A small number are **partial** or **planned** with a designed interface but the enforcement not yet wired; those are tagged inline so customers can plan around them.

Where a control has a per-[personality](../getting-started/glossary.md#personality) knob, the default is the safer option and the override is documented inline.

The controls fire in the order documented in the [runtime precedence diagram](./overview.md#discussion). If two controls conflict, the earlier one wins.

## Source {#source}

| Layer | Source |
|---|---|
| Channel controls | [`packages/safety/channel/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/channel/src/) |
| Tool boundary | [`packages/core/src/tool-registry.ts`](../../../packages/core/src/tool-registry.ts) |
| Filesystem boundary | [`packages/storage-fs/src/scoped-storage.ts`](../../../packages/storage-fs/src/scoped-storage.ts) |
| Network reach | [`packages/safety/network/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/network/src/) |
| Injection defenses | [`packages/safety/injection/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/injection/src/) |
| Watcher | [`packages/safety/watcher/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/watcher/src/) |
| Install scanner | [`packages/safety/scanner/src/`](https://github.com/ethosagent/ethos/tree/main/packages/safety/scanner/src/) |
| Redaction + audit | [`extensions/observability-sqlite/src/`](https://github.com/ethosagent/ethos/tree/main/extensions/observability-sqlite/src/) |
| Personality schema | [`packages/types/src/personality.ts`](../../../packages/types/src/personality.ts) (`PersonalitySafetyConfig`) |

## Status legend {#status-legend}

| Tag | Meaning |
|---|---|
| *Shipped* | Code lives at the linked path, tests cover it, audit events flow through `observability.db`. Customers can rely on enforcement today. |
| *Partial* | Core path implemented, some sub-cases (e.g. transport-level integration, config-load gate) still landing. |
| *Planned* | Interface and design in place; enforcement not yet wired. Documented here so the eventual landing is not a surprise. |

## Channel-level controls {#channel-level-controls}

A channel adapter is the front door. If anyone who knows your bot's handle can DM it, every other layer has to clean up after the first compromise.

### Channel allowlist {#channel-allowlist}

*Status: Shipped.*

Per-platform sender allowlists. A Telegram numeric user ID, a Discord snowflake, a Slack `U…` ID, or an email glob. Senders not on the list are dropped before the message reaches the [agent loop](../getting-started/glossary.md#agent-loop).

- Source: `packages/safety/channel/src/channel-filter.ts`
- Tests: `packages/safety/channel/src/__tests__/channel-filter.test.ts`
- Audit category: `channel.allow` / `channel.deny`

### One-time DM pairing codes {#one-time-dm-pairing-codes}

*Status: Shipped.*

To add a new sender, the operator issues a one-time pairing code. The code is sender-bound (only redeemable by the sender it was issued to), nonce-bound (cryptographic random; never reused), atomically consumed (the consume is the only allowed transition; replay fails), and rate-limited.

- Source: `packages/safety/channel/src/pairing-store.ts`
- Tests: `packages/safety/channel/src/__tests__/pairing-store.test.ts`
- Audit category: `channel.pairing`

### Mention-gate (groups only) {#mention-gate}

*Status: Shipped.*

In a multi-user channel (group chat, Slack workspace), the agent only responds when explicitly mentioned. Drive-by hijacking by pasting a wall of text into a public channel doesn't reach the LLM at all. The owner can bypass the gate (the `/allow` flow needs to work from any channel) — non-owners cannot.

- Source: `packages/safety/channel/src/channel-filter.ts`

### Context-visibility filter {#context-visibility-filter}

*Status: Shipped.*

Quoted text and forwarded content are treated as untrusted by default — they enter the LLM context with provenance markers (see [Provenance wrapping](#provenance-wrapping)) so the LLM and the runtime classifier both know "this is content the user did not author." The mode is per-channel: `all` (everything visible), `allowlist` (only allowlisted senders' content visible), `allowlist_quote` (allowlisted senders + their quoted context).

- Source: `packages/safety/channel/src/channel-filter.ts`

## Tool-level controls {#tool-level-controls}

### Per-personality toolset enforcement {#per-personality-toolset-enforcement}

*Status: Shipped.*

The personality's `toolset.yaml` is a hard allowlist enforced at the framework layer, not advisory. `DefaultToolRegistry.toDefinitions(allowedTools)` filters the [tool](../getting-started/glossary.md#tool) list the LLM sees, and `executeParallel` rejects calls outside the allowlist with a `tool_result` carrying `is_error: true` (preserving the Anthropic message contract).

- Source: `packages/core/src/tool-registry.ts`
- Example: the `researcher` personality cannot suddenly run `bash` because a [skill](../getting-started/glossary.md#skill) instructed it to; the tool isn't in its toolset, so it never reaches the model.

### Hardline blocklist {#hardline-blocklist}

*Status: Shipped.*

A small set of operations is always-deny, regardless of personality, regardless of approval. The danger predicate fires before any approval check.

- Source: `apps/web-api/src/services/approval-hook.ts`
- Audit category: `audit.block`

### Risk classifier (mode-aware, per-call) {#risk-classifier}

*Status: Shipped (engine). Partial (sandbox attestation gating).*

Every tool call is scored against a pattern-based classifier (regex floor) and an LLM-based classifier (Tier-2). The score determines whether the call goes through, requires approval, or is blocked. Sandbox attestation can relax the classifier for execution backends that declare strict confinement properties (read-only root, no host mounts, egress controls, no docker socket, non-root) — but only attested-strict backends earn the relaxation.

- Pattern source: `packages/safety/injection/src/pattern-check.ts`
- LLM classifier: `packages/safety/injection/src/classifier.ts`
- Sandbox attestation contract: `packages/types/src/sandbox.ts`

### Approval modal {#approval-modal}

*Status: Shipped.*

When any of the previous checks flag a call, the request is held in front of the approval surface (Web UI modal or CLI prompt). The approval is binary, sender-attributable, and persisted as an audit event.

- Source: `apps/web-api/src/services/approval-hook.ts`
- Audit category: `audit.approval`
- Per-personality knob: `safety.approvalMode` — `auto` | `safe-auto` | `manual` | `off`. Default is `safe-auto`.

## Filesystem controls {#filesystem-controls}

### ScopedStorage and BoundaryError {#scoped-storage-and-boundary-error}

*Status: Shipped.*

All filesystem access under `~/.ethos/` flows through the `Storage` interface from `@ethosagent/types`. `ScopedStorage` is a decorator that enforces a per-personality read/write path allowlist with a global always-deny floor for sensitive paths (the `~/.ssh/` pattern, etc.). Out-of-scope reads throw `BoundaryError`, which the surface translates into a user-facing tool error.

- Source: `packages/storage-fs/src/scoped-storage.ts`
- Cross-personality isolation tests: `extensions/tools-file/src/__tests__/boundary.test.ts`
- Example: the `engineer` personality cannot read the `researcher`'s `MEMORY.md`. Verified by test.

### Symlink-misdirection handling {#symlink-misdirection-handling}

*Status: Shipped (misdirection defense). Planned (TOCTOU race closure).*

After path expansion, Ethos calls `realpath()` to resolve symlinks and re-checks the resolved path against the personality's [fs reach](../getting-started/glossary.md#fs-reach). This defends against the symlink-misdirection bypass — a symlink at `~/proj/notes.md → ~/.ssh/id_rsa` planted inside an allowed directory is rejected after resolution, not let through by naive prefix match.

What this does **not** close on its own is the resolve-then-open TOCTOU race: an attacker who can swap a path between the `realpath()` and the `open()` can still redirect the read. Closing that race requires kernel-tied operations (`openat`-style directory handles plus no-follow semantics) — designed for, tracked separately, not yet wired in. The source comments note this explicitly.

- Source: `extensions/tools-file/src/index.ts`

### Bash + filesystem boundary {#bash-filesystem-boundary}

*Status: Planned.*

The intended enforcement: if a personality's toolset includes `bash`, an attested-strict execution backend is **required at config-load time** — not a UI warning, not a runtime check. A personality that wants `bash` without sandbox attestation fails the configuration validation.

The `SandboxAttestation` interface and `isStrictAttestation()` helper ship today, so the gating logic has a stable contract to call. The config-load validator that wires them together is in flight; until it lands, an unsandboxed `bash` produces a runtime warning rather than a config-load failure.

- Interface: `packages/types/src/sandbox.ts`
- Helper: `isStrictAttestation()`

## Network controls {#network-controls}

### Per-personality network policy {#per-personality-network-policy}

*Status: Shipped.*

A personality's `config.yaml` declares its network reach (hosts, ports, protocols). The default is conservative; the override is explicit.

- Source: `packages/types/src/personality.ts`
- Per-personality knob: `safety.networkReach` — list of host globs and ports.

### SSRF protection {#ssrf-protection}

*Status: Shipped.*

The `safe-fetch` wrapper rejects requests to private IP ranges, link-local addresses, loopback, and the cloud metadata endpoints (AWS `169.254.169.254`, GCP `metadata.google.internal`, Azure equivalents).

- Source: `packages/safety/network/src/safe-fetch.ts`
- Cloud metadata blocklist: `packages/safety/network/src/cloud-metadata.ts`

### Scheme allowlist {#scheme-allowlist}

*Status: Shipped.*

URLs must use `http` or `https`. `file://`, `gopher://`, `ftp://`, and `data:` are always rejected. The check fires on the original URL **and on every redirect hop** — a server-side `302` to `file:///etc/passwd` is rejected at the redirect, not at the request.

- Source: `packages/safety/network/src/scheme.ts`

### DNS pinning per HTTP client {#dns-pinning-per-http-client}

*Status: Partial.*

`safe-fetch` resolves the hostname via `node:dns/promises#lookup`, validates the resolved IP against the SSRF rules, and rejects the request before the connection is opened. This blocks the canonical "the URL is allowlisted; the IP it resolves to is private" case at request time.

The transport-level pinning that prevents a re-resolution between the SSRF check and the connect (undici `connect.lookup` override, native `http.request` agent override) is the next step. Designed for, not yet wired in. Documented in the source comments at the linked path.

- Source: `packages/safety/network/src/safe-fetch.ts`

## Prompt-injection defenses {#prompt-injection-defenses}

Tool results that re-enter the LLM context are the dominant vector for indirect prompt injection. Three independent layers handle this.

### Provenance wrapping {#provenance-wrapping}

*Status: Shipped.*

Every tool result is wrapped with provenance markers identifying the source (skill, web fetch, channel quote) before it enters the LLM context. The system prompt instructs the model to treat wrapped content as untrusted.

- Source: `packages/safety/injection/src/wrap.ts`
- System prompt: `INJECTION_DEFENSE_PRELUDE` injected into every personality's prompt

### Two-tier classifier {#two-tier-classifier}

*Status: Shipped.*

Tier 1 is a regex-based pattern check covering the obvious phrases ("ignore previous instructions", "override system prompt", base64-encoded blobs, hidden Unicode). Tier 2 is an LLM-based classifier that runs over longer content with a sampling budget. Short suspicious payloads still get the structured short-pattern check — there's no fixed-threshold gate that lets sub-128-character injections through.

- Sources: `packages/safety/injection/src/classifier.ts`, `packages/safety/injection/src/pattern-check.ts`

### Post-read tool downgrade {#post-read-tool-downgrade}

*Status: Shipped.*

After a read from an untrusted source flags the classifier, a configurable subset of tools is locked out for the next two turns. The hijacked agent can't immediately turn around and call `web_post` to exfiltrate.

- Source: `packages/safety/injection/src/downgrade.ts`
- Audit category: `audit.injection_flag`
- Per-personality knob: `safety.injectionDefense` — `strict` | `balanced` | `off`. Default is `balanced`.

### Memory injection scanning {#memory-injection-scanning}

*Status: Shipped.*

Memory content — `MEMORY.md`, `USER.md`, and team topic files — is sanitized through the same injection-pattern catalog used for context files. Any line matching patterns like "ignore previous instructions", `[SYSTEM]`, or role-override phrases is replaced with `[line removed by injection guard]`.

Memory is a higher-risk surface than context files. A single poisoned line in MEMORY.md re-injects into the system prompt on every subsequent turn and every future session — the attack persists across restarts. A poisoned `USER.md` is worse: it crosses [personality](../getting-started/glossary.md#personality) boundaries, so every personality the user interacts with sees the injected content.

The scan runs at two points: on write (in the memory tools, before `sync()` persists the update) and on read as a backstop (before the system prompt is assembled in AgentLoop Step 5). The write-time scan is the primary defense; the read-time scan catches content that was written before the scanning was deployed or was edited manually on disk.

- Source: `packages/safety/injection/src/`
- Audit category: `audit.injection_flag`

## Watcher (independent observer) {#watcher}

*Status: Shipped.*

Ethos's agent loop is a typed `AsyncGenerator<AgentEvent>` over the [agent event](../getting-started/glossary.md#agent-event) stream. The watcher consumes the event stream out-of-band and applies rules that catch failure modes the in-loop checks can't see: rate-limit (too many tool calls per unit time), token-budget (cumulative tokens this turn), compounding-error (N consecutive failures), suspicious-sequence (read-untrusted → call-network within K turns).

The watcher returns `pause` / `terminate` / `allow` decisions. A pause holds the next tool call for human review; a terminate ends the turn.

- Source: `packages/safety/watcher/src/watcher.ts`, `packages/safety/watcher/src/rules.ts`
- Audit category: `audit.watcher`
- Per-personality knob: `safety.watcher` — `{ enabled, rules: [...] }`.

## Credential redaction {#credential-redaction}

*Status: Shipped.*

Credential redaction is **always on** at the observability store layer. Every value written to `observability.db` flows through `redactString` and `redactJson` first. Per-personality config controls whether tool args / tool bodies / LLM payloads are stored at all (`'none' | 'redacted' | 'full'`), but the redacted-mode pattern set is non-bypassable.

- Source: `extensions/observability-sqlite/src/redact.ts`
- Per-personality knobs: `safety.observability` (`storeToolArgs`, `storeToolBodies`, `storeLlmPayloads`)
- Audit category: `audit.redacted`

The patterns cover Anthropic API keys (`sk-ant-…`), OpenAI API keys (`sk-…`), generic bearer tokens, AWS access keys (`AKIA…`), and a small set of high-confidence secret formats. The redaction is applied **before** the value reaches disk — a `tool_error` containing `sk-ant-…` is replaced with `sk-ant-[REDACTED]` in the audit log, the LLM context (next turn's history), and any user-shared diagnostic bundle.

## Skill and plugin install controls {#skill-and-plugin-install-controls}

### Static-analysis pattern scanner {#static-analysis-pattern-scanner}

*Status: Shipped.*

Newly installed skills and plugins are scanned for prompt-injection patterns (hidden Unicode, base64 blobs, instructions to call sensitive tools), declared-but-unused permissions, and required-tool inflation (a "format-a-date" skill that declares `required_tools: [bash, web_post]`).

- Source: `packages/safety/scanner/src/skill-scanner.ts`, `packages/safety/scanner/src/plugin-scanner.ts`
- Audit category: `install.scan`

### Trust tiers {#trust-tiers}

*Status: Shipped.*

A skill is `community` (third-party) by default. Operators can promote skills to `partner` or `internal` tiers, which relax certain checks (e.g. an internal skill may declare `bash` without a scanner warning). Promotion is a deliberate operator action and is audit-logged.

- Source: `packages/safety/scanner/src/trust-tiers.ts`

### MCP environment minimization {#mcp-environment-minimization}

*Status: Shipped.*

When Ethos spawns an MCP server subprocess, it strips `HOME`, sensitive env vars, and the inherited env tail before the child starts. The MCP server gets a sanitized temp `HOME` per server so credential files (`.npmrc`, `.aws/credentials`, etc.) cannot be read by inheriting the host environment.

- Source: `packages/safety/scanner/src/mcp-env.ts`

### Allowed skill permissions {#allowed-skill-permissions}

*Status: Shipped.*

A personality may declare `allowed_skill_permissions` — the set of tool names skills loaded by this personality are permitted to call. A skill that declares `required_tools` outside this set fails to load with a typed error.

- Source: `extensions/skills/src/`

## Audit substrate — observability.db {#audit-substrate}

*Status: Shipped.*

Every safety decision lands in `observability.db` as a typed event. The schema is documented in `packages/types/src/observability.ts`.

| Category | What it records |
|---|---|
| `audit.transition` | Personality switch, model swap, [session](../getting-started/glossary.md#session) boundary |
| `audit.approval` | Operator approved or denied a tool call (with sender attribution) |
| `audit.block` | Hardline blocklist denied a tool call |
| `audit.watcher` | Watcher paused or terminated a turn |
| `audit.injection_flag` | Classifier flagged a tool result as suspicious |
| `audit.redacted` | Redaction count for a write — how many credential patterns were caught |
| `channel.pairing` | Pairing code issued / consumed / rejected |
| `channel.allow` / `channel.deny` | Sender allowlist match / miss |
| `install.scan` / `install.event` | Skill / plugin install scan result; install completed |

The store uses STRICT mode SQLite, WAL, and FTS5. Retention is configurable per category. Policy snapshots let you reconstruct "what was the personality's network policy at the time the agent fetched this URL" — useful when investigating an incident.

- Source: `extensions/observability-sqlite/src/store.ts`, `extensions/observability-sqlite/src/service.ts`

## Cron output path containment {#cron-output-path-containment}

*Status: Shipped.*

`CronScheduler.readRunOutput()` enforces containment — only paths within the scheduler's `outputDir` are readable. Paths containing `..` or pointing outside the output directory throw. This prevents a caller from using the cron output reader as a general-purpose file read primitive to escape the scheduler's intended sandbox.

## Admin panel token authentication {#admin-panel-token-auth}

*Status: Shipped.*

The admin panel (Mission Control) requires a bearer token for every API request. Generate tokens via `ethos token create`; they are stored in the OS keychain (macOS Keychain, GNOME Keyring, Windows Credential Vault) via `keytar`. Requests without a valid token receive `401 Unauthorized`.

- Source: `apps/web-api/src/middleware/auth.ts`
- Cross-ref: [Authenticate your dashboard users](../building/how-to/authenticate-dashboard-users.md)

## Read-only SQL enforcement {#read-only-sql}

*Status: Shipped.*

Plugin data sources expose SQLite databases to the dashboard for read-only queries. The query executor enforces read-only mode: every query runs inside a read-only transaction, and statements containing write keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`) are rejected before execution.

- Source: `apps/web-api/src/services/data-source.ts`
- Cross-ref: [Register a plugin data source](../building/how-to/register-plugin-data-source.md)

## Desktop remote connection security {#desktop-remote-connection}

*Status: Shipped.*

When Mission Control connects to a remote Ethos instance, the connection token is stored in the OS keychain rather than in plaintext config. The desktop app retrieves the token at connection time via `keytar` and transmits it over TLS. CORS is restricted to the configured origin.

- Source: `apps/desktop/src/remote-auth.ts`
- Cross-ref: [Deploy Mission Control with a remote Ethos](../building/how-to/deploy-mission-control-remote.md)

## Removed empty safety stubs {#removed-empty-safety-stubs}

`extensions/safety-injection/` and `extensions/safety-scanner/` were empty stub directories that shipped no code. They have been removed. The real injection defense and install scanner implementations live at `packages/safety/injection/` and `packages/safety/scanner/` respectively — the source paths listed throughout this page.

## Per-personality vs. global {#per-personality-vs-global}

This table reflects the policy split for each control — which knobs are operator-tunable per personality vs. always-on globally. The status tag on each control above tells you whether the listed knob is enforced today; for *Planned* and *Partial* items the table describes the policy split for when the control fully ships.

| Control | Per-personality | Global (always on) |
|---|:---:|:---:|
| Channel allowlist + pairing | yes | no |
| Toolset enforcement | yes | no |
| Hardline blocklist | no | yes |
| Risk classifier | yes (mode) | yes (engine) |
| `ScopedStorage` boundary | yes | yes (always-deny floor) |
| Network policy | yes | yes (SSRF, scheme, cloud-metadata) |
| Provenance wrapping | no | yes |
| Post-read tool downgrade | yes (which tools) | yes (mechanism) |
| Watcher rules | yes (config) | yes (engine) |
| Credential redaction | yes (modes) | yes (pattern set) |
| Skill / plugin scanner | no | yes |
| Audit substrate | yes (retention) | yes (write path) |
| Admin panel token auth | no | yes |
| Read-only SQL enforcement | no | yes |
| Desktop remote connection security | no | yes |

The pattern is consistent: the *engine* is global and non-bypassable; the *policy* is per-personality so different roles can take different risk postures. A `researcher` personality can be more permissive on network reach than an `engineer` personality without weakening the SSRF or cloud-metadata controls — those apply to both.

## Verifying these controls yourself {#verifying-controls}

Every control above lists a source path. Read the code. Read the tests next to it. Run the test suite:

```bash
pnpm check
```

The tests include adversarial bypass attempts — encoding tricks, redirect chains, symlink races — not just happy-path verification. If a test fails on your branch, you've found a regression in a control we depend on.

## See also {#see-also}

- [How does Ethos defend against the threats it knows about?](./overview.md) — the layered model and runtime precedence.
- [What is the threat model?](./threat-model.md) — what each control is defending against.
- [Pre-launch hardening pass](./security-fixes.md) — the issues a pre-launch review surfaced and how each was folded in.
- [Responsible disclosure](./responsible-disclosure.md) — how to report a control bypass.
- [Personality config reference](../using/reference/personality-yaml.md) — the `safety:` nested block.
