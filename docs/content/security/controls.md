---
title: Security controls
description: Catalogue of shipped, partial, and planned security controls — channel, tool, filesystem, network, injection, watcher, redaction, install, audit.
kind: reference
audience: shared
slug: security-controls
updated: 2026-09-05
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

The reach check does two things, and both are needed. First it normalises the path lexically — `normalize(resolve(path))` — so `..`, `.`, and redundant-slash traversal cannot walk out of an allowed prefix. Then it walks **every segment** of the path with `lstat` and refuses any segment that is a symbolic link. A symlink at `~/proj/notes.md → ~/.ssh/id_rsa` planted inside an allowed directory is refused at the link, before anything opens the target.

The walk is per-segment rather than leaf-only because **a symlinked parent escapes with a non-symlink leaf**: `<allowed>/data → /etc` makes `<allowed>/data/passwd` a perfectly ordinary file whose link path passes any prefix test. Checking only the last component misses the whole attack.

Normalisation alone does not close this. `resolve()` is a string operation and a symlink is a filesystem fact — the lexically-resolved link path is neither under a denied prefix nor outside the allowed one, so it passes the always-deny floor and the allow check both. The floor's guarantee is *"this path string is not a sensitive path"*, not *"this read does not reach a sensitive file."* The segment walk is what supplies the second property.

The check lives at the boundary, not in each tool, so file tools, vision, web-api, gateway, and any future consumer inherit it from one place.

What this does **not** close is the check-then-open TOCTOU race: an attacker who can swap a path between the walk and the `open()` can still redirect the read. Closing that race requires kernel-tied operations (`openat`-style directory handles plus no-follow semantics) that Node does not expose — designed for, tracked separately, not yet wired in, and realistically a container-level remediation rather than a framework one.

- Source: `packages/core/src/scoped/scoped-fs.ts` (`checkReach`)
- Tests: `extensions/tools-file/src/__tests__/boundary.test.ts`
- History: this defense was originally implemented as a path-canonicalisation call inside the file tools and was dropped during a refactor that centralised normalisation at the boundary, without this page being updated. It is re-implemented at the boundary as the segment walk described above. See [Pre-launch hardening pass, entry 8](./security-fixes.md#8-symlink-misdirection) for the dated correction.

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

### The browser SSRF guard does not survive an upstream proxy {#ssrf-browser-proxy}

*Status: Not covered. Read this before setting [`browser.proxy.server`](../using/reference/config-yaml.md#browser).*

Browser sessions carry their own SSRF guard: `installRouteGuard` puts a `context.route('**/*')` handler on every Playwright context, and each request is checked by the same `validateUrl` the fetch path uses, with hostnames resolved through `node:dns/promises#lookup`.

That resolution happens in the **Ethos process**. A proxied navigation is never resolved there. Chromium sends `CONNECT <host>:<port>` to the proxy and the **proxy** resolves the name, on its own resolver, inside its own network. So the guard checks an address the connection does not use, and a hostname that answers with a public IP here can answer with `10.0.0.5` inside the proxy's LAN. Ethos cannot see that and does not block it.

Literal IPs are unaffected — a URL with a private address in it is rejected before any resolution happens, proxy or not. The gap is names only, and it is not a bug we can close from this side: the resolver that matters belongs to the proxy.

Deploy a proxy you trust not to act as an SSRF pivot — one that cannot reach your internal network, or that enforces its own egress policy. The browser route guard is not that control and must not be relied on as one.

- Source: [`extensions/tools-browser/src/session-route.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/session-route.ts)

### A takeover hands a human the agent's live browser {#browser-takeover-exposure}

*Status: Shipped, opt-in per personality.*

`browser_request_takeover` pauses the agent and hands the **live browser session** to whoever answers the request. That session is not a blank window: it holds every cookie and every logged-in tab the agent accumulated, and when [`browser.profiles.enabled`](../using/reference/config-yaml.md#browser) is on it is signed into whatever that personality's persistent profile is signed into — across turns, and across `/new`.

Two things follow. The window itself is open on the machine running Ethos, so anyone at that machine can drive it. And the request is raised with `answerableBy: 'anyone'`, so in a group chat any member — not only the person the agent was talking to — may cancel it or follow the link into the web chat to hand it back.

Grant the tool in `toolset.yaml` only to personalities whose browser you are willing to hand over, and keep a persistent profile signed into accounts you would put in front of that audience.

- Source: [`extensions/tools-browser/src/browser-takeover.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/browser-takeover.ts)

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
- Per-personality knob: `safety.injectionDefense.postReadDowngrade` — `{ enabled, turns, tools }`. The block narrows the downgrade; there is no master switch that turns the injection pipeline off. ARCHITECTURE.md §V S6 makes the inbound safety pipeline non-opt-out-able by personality, channel, or tool.

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

The scanner is **pre-install and advisory**. It reads text before the code is installed; it sandboxes nothing, constrains nothing at runtime, and is evaded by string concatenation. It is published as a non-boundary — see [What is not a boundary](./security-boundary.md#non-boundaries) — and nothing on this page should be read as strengthening that.

- Source: `packages/safety/scanner/src/skill-scanner.ts`, `packages/safety/scanner/src/plugin-scanner.ts`
- Audit category: `install.scan`

### Trust tiers {#trust-tiers}

*Status: Shipped.*

There are four tiers. A tier is **derived from the source string** the skill or plugin was installed from, on every scan. It is not assigned per skill, cannot be promoted, and produces no audit event — there is no promotion action to record.

| Tier | Derived from | Yellow findings | Red findings |
|---|---|---|---|
| `builtin` | The literal source `builtin` — code shipped inside this repository | Auto-acknowledged | Installs with `--force` |
| `trusted-repo` | `github.com/<org>/<repo>` where `<org>` is listed in `security.trusted_github_orgs` | Acknowledgment required; `--force` stands in for it | Installs with `--force` |
| `community` | Any other `github.com/…`, `clawhub/…`, or `hermeshub/…` source | Acknowledgment required; `--force` stands in for it | Blocked; `--force` is ignored |
| `untrusted` | A local path or a raw URL | Acknowledgment required; `--force` stands in for it | Blocked; `--force` is ignored |

`builtin` is the only tier that auto-acknowledges yellow findings. Overriding a red finding with `--force` is the only privilege `trusted-repo` holds over `community`.

`security.trusted_github_orgs` is operator-configurable and **replaces** the shipped default (`ethosagent, anthropic`) rather than extending it. Set it to a different list to trust different organizations, or to an empty value to trust no organization by name. Organization matching is exact on the path segment; a source containing `.` or `..` is refused. See [`security.trusted_github_orgs`](../using/reference/config-yaml.md#security-trusted-github-orgs).

Residual risk: a red finding in a configured organization is overridable with `--force`.

- Source: `packages/safety/scanner/src/trust-tiers.ts`

### Plugin capability grants {#plugin-capability-grants}

*Status: Shipped.*

A grant is a **consent record, not runtime enforcement**. It is not a boundary and it does not confine a plugin.

`PluginLoader` `import()`s a plugin's entry module directly into the Ethos process. The plugin shares the process, the environment, the filesystem, and your API keys. Installing a plugin is equivalent to running arbitrary code as your user. This is an accepted, documented Tier 1 property — see [Gaps, disclosed](./security-boundary.md#gaps).

At install the operator is shown what the plugin **declares** in `ethos.permissions` (`shell` — intent to shell out; `network` — declared hosts, or none), told in plain words what installing it means, and their agreement is recorded durably alongside the scan findings as they stood at that moment. The record's field is named `capabilities`, and there are no per-capability toggles: it records what was declared and what was agreed to. Nothing checks a plugin against its declaration while it runs, and an undeclared capability is not blocked.

| Command | What it does |
|---|---|
| `ethos plugin grants` | Lists every recorded grant — package, version, source, what was declared, the scan result at install, and any revocation date |
| `ethos plugin revoke <pluginId>` | Withdraws the grant. The record is kept with a `revokedAt` date rather than deleted |

Revocation prevents the **next** load and blocks lockfile auto-install. It cannot claw back anything an already-loaded plugin did — that code has already run as the user.

- Source: `extensions/plugin-loader/src/grants.ts`
- Record: `<pluginsDir>/grants.json`
- Load-path gate: `extensions/plugin-loader/src/index.ts`

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

## Read-only plugin data source access {#read-only-sql}

*Status: Shipped (read-only connection). Partial (statement guard).*

Plugin data sources expose SQLite databases to the dashboard. Read-only enforcement lives at the SQLite connection, not in a keyword filter: both query paths open the database with `new Database(dbPath, { readonly: true })`, so the engine refuses every write regardless of what the statement text says.

Connection-level read-only is the stronger property. A denylist of write keywords is a guess about what a string means, and SQL offers cheap ways to make a write not look like one — a leading comment, unexpected casing, a `WITH` prefix, or a keyword that never appears at the position the filter inspects. A connection opened read-only does not interpret intent; SQLite refuses the write at execution. A filter has to be right on every statement it will ever see; the connection has to be right once.

| Layer | Where | What it does |
|---|---|---|
| Read-only connection | `dashboards.service.ts:1035`, `dashboard-refresh.ts:127` | Engine-level refusal of all writes. Covers both query paths. |
| SELECT-only statement guard | `interpolate-params.ts:128` (`assertSelectOnlySql`) | Write-time. Requires a single statement beginning with `SELECT`, and rejects embedded `;`. |
| Param allowlist | `interpolate-params.ts:106` (`findInvalidParamKeys`) | Values interpolated into panel SQL must match a declared `select`/`options` option or a `YYYY-MM-DD` date. Template positions cannot be `?`-bound, so this allowlist is the injection defense on that path. |
| Keyword prefix denylist | `dashboards.service.ts:1026` | Ad-hoc `dashboards.runQuery` RPC only. Rejects eight leading keywords. It tests only the statement's first word — a usability guard, not a boundary. |

Both paths that read a plugin data source carry the read-only connection: `runPluginQuery`, behind the ad-hoc `dashboards.runQuery` RPC, and `refreshSinglePanel`, behind scheduled and manual panel refresh. There is no third path — `getDataSourcePath` in `extensions/plugin-loader/src/index.ts` has exactly these two callers.

The statement guard does not have that coverage, which is why the status is split. `addPanel` guards every SQL panel it stores, but `updatePanel` applies the guard only when the patch also sets `queryType: 'sql'` (`dashboards.service.ts:551`). A patch that changes `sqlQuery` alone on a panel that is already of type `sql` persists unvetted text, and the refresh path executes it. The read-only connection is what keeps that from being a write primitive. Until the guard condition is corrected, read the connection as the load-bearing control and the statement guard as the layer above it, not the reverse.

Registration itself is not validated. `PluginApi.registerDataSource(id, path)` records whatever identifier and filesystem path the plugin passes, with no path containment, extension check, or identifier constraint. A plugin can therefore point a data source at any SQLite file the host process can open. That is consistent with the plugin trust model — plugin code already runs in-process — but it means the boundary here is read-only access, not restricted reach.

- Source: `extensions/dashboard/src/dashboards.service.ts`, `extensions/dashboard/src/dashboard-refresh.ts`, `extensions/dashboard/src/interpolate-params.ts`
- Cross-ref: [Register a plugin data source](../building/how-to/register-plugin-data-source.md)

## Desktop remote connection security {#desktop-remote-connection}

*Status: Shipped.*

When Mission Control connects to a remote Ethos instance, the web token is stored in the OS keychain (Electron `safeStorage`) rather than in plaintext config, and is never exposed to the renderer. The main process writes it onto the remote origin as the `ethos_auth` cookie before navigating; the window then loads the remote server's own SPA same-origin, so there is no cross-origin request to authorize. `/auth/exchange` is deliberately not used — it rotates the token, which would invalidate the stored value on every launch.

- Source: `apps/desktop/src/main/connection.ts`
- Cross-ref: [Deploy Mission Control with a remote Ethos](../building/how-to/deploy-mission-control-remote.md)

## Removed empty safety stubs {#removed-empty-safety-stubs}

Five directories under `extensions/` carried safety-package names and shipped no code: `safety-injection/` and `safety-scanner/`, removed earlier, and `safety-channel/`, `safety-network/`, and `safety-watcher/`, removed in this release. All five are gone. The real implementations live under `packages/safety/` — `injection/`, `scanner/`, `channel/`, `network/`, `watcher/`, and `redact/` — which are the source paths listed throughout this page and the Tier 0 members named in [the security boundary](./security-boundary.md#tiers).

Empty directories with kernel names in the extensions tree are not cosmetic. They point a reader looking for the kernel at the wrong tier, which is the one thing the tier roster exists to prevent.

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

- [What does Ethos guarantee, and what is outside its security boundary?](./security-boundary.md) — which of these controls are published guarantees, and which are not.
- [How does Ethos defend against the threats it knows about?](./overview.md) — the layered model and runtime precedence.
- [What is the threat model?](./threat-model.md) — what each control is defending against.
- [Pre-launch hardening pass](./security-fixes.md) — the issues a pre-launch review surfaced and how each was folded in.
- [Responsible disclosure](./responsible-disclosure.md) — how to report a control bypass.
- [Personality config reference](../using/reference/personality-yaml.md) — the `safety:` nested block.
