---
title: What does Ethos guarantee, and what is outside its security boundary?
description: The three security tiers, the twelve published guarantees with their enforcement points, what is explicitly not a boundary, and how a report is triaged.
kind: explanation
audience: shared
slug: security-boundary
updated: 2026-08-13
---

You are about to deploy an agent that reads your filesystem, makes network calls, runs commands, and speaks on channels your users can see. Before you do, you need one thing this page exists to give you: a list of what the framework promises to be correct about, so you know what is left for you to add.

Most security documentation answers *which controls exist*. That is not the question. The question is **which controls are promises** — the ones where a bypass is a vulnerability we own, rather than a bug we will fix on the normal queue. Until that list is written down, every reader assembles their own version of it from a threat model, a controls catalogue, and the source. Nobody outside the repo can do that assembly.

This page is the list. It has three parts: the **tiers** (which code is held to a promise), the **guarantee register** (the twelve promises, each with the file and line that enforces it), and the **non-boundaries** (the things you would most reasonably mistake for a promise and should not).

## Context

Ethos partitions its own source into three tiers of ownership, and publishes a closed list of guarantees that the top tier is held to. One rule makes the partition real rather than decorative:

> **A Tier 2 extension must not be able to weaken a Tier 0 guarantee. If it can, either the extension is wrong or the guarantee was never in Tier 0.**

Everything below is that rule's application. The corollary is what keeps it honest: **a narrow boundary is only defensible if everything inside it is actually true.** A wide, vague scope absorbs over-claims — nobody can hold us to "bundled extensions under `extensions/`" because nobody, including us, knows what it promised. A narrow published boundary has the opposite property: it converts every over-claim inside it into a valid external finding on the day it is published. That is the trade we are making deliberately.

Four readers use this page for four different decisions:

| Reader | The decision | What they read |
|---|---|---|
| Operator | What must I add myself before I can deploy this? | The register's *If you need more* field, plus the [production hardening checklist](./production-hardening-checklist.md) |
| Buyer or auditor | What can I put in a security questionnaire and defend? | The register, plus the tier roster |
| Security researcher | Is my finding in scope? | The decision table in [SECURITY.md](https://github.com/ethosagent/ethos/blob/main/SECURITY.md) |
| Contributor | What bar is my PR held to? | The tier roster and [`.architecture-state.yaml`](https://github.com/ethosagent/ethos/blob/main/.architecture-state.yaml) |

## Discussion

### The three tiers {#tiers}

Tiers are assigned **per workspace package**, committed and dated in [`.architecture-state.yaml`](https://github.com/ethosagent/ethos/blob/main/.architecture-state.yaml) at the repo root. That file is authoritative for any individual package; the roster below names the members so you can read the shape without opening it. 119 packages: 10 at Tier 0, 23 at Tier 1, 86 at Tier 2.

The assignment is committed **before** any report arrives. A tier decided in the same week a report lands against that module is evidence of nothing, and a reporter reading `git log` can say so with a timestamp.

**Tier 0 — the security kernel.** Guaranteed. CVE-eligible. No exception path under [ARCHITECTURE.md §VIII](https://github.com/ethosagent/ethos/blob/main/ARCHITECTURE.md).

- `@ethosagent/types` — the contracts that shape the boundary
- The six safety packages: `@ethosagent/safety-injection`, `safety-network`, `safety-redact`, `safety-channel`, `safety-scanner`, `safety-watcher`
- `@ethosagent/core` — **enforcement points only**, not all of core: the tool registry, the per-call enforcement, tool-processing and tool-rejection stages, the injection prelude and post-read downgrade sites in `agent-loop.ts` and `context-assembly.ts`, the approval-posture guard, result defense, the `scoped/*` decorators, `fs-reach.ts`, `path-boundary.ts`, `url-validator.ts`, the capability validator and resolver, the hook registry, `script-safe.ts`
- `@ethosagent/storage-fs` — `ScopedStorage` and the always-deny floor
- `@ethosagent/wiring` — **safety composition only**: the `AgentSafety` bundle assembly, `danger-predicate.ts`, `approval-seams.ts`, `smart-approver.ts`, `resolve-execution-posture.ts`

The per-file lists for core and wiring are in the sidecar under `kernel_paths`. The rest of each package is Tier 1 by default — including two files a reader might expect here and will not find. `sanitize-output.ts` (`stripAnsiEscapes`) is a pure string utility every caller opts into rather than a chokepoint anything guarantees runs; `safety-conformance.ts` *tests* the injected safety bundle and sits on no request path. The sidecar records both exclusions with their reasons.

**Tier 1 — guarded surfaces.** Not the kernel; they *sit on* a trust boundary. They get kernel-adjacent review and they are in disclosure scope, but the promise is *"we review this hard"*, not *"we guarantee this"*.

| Group | Modules |
|---|---|
| Ingress | `gateway` and the seven adapters — `platform-discord`, `platform-email`, `platform-meeting`, `platform-slack`, `platform-telegram`, `platform-voice`, `platform-whatsapp` |
| Execution | `tools-terminal`, `tools-code`, `execution-docker`, `execution-local` |
| Third-party code | `tools-mcp`, `skills`, `skill-evolver`, `plugin-loader` |
| Network surface | `apps/web-api` |
| Data at rest and credentials | `session-sqlite`, `storage-crypto`, `secrets-aws`, `plugin-sdk` |
| Audit and delivery | `observability-sqlite`, `delivery-ledger` |

**Tier 2 — extensions, not owned.** The remaining 86 packages. Best-effort. A bug is a bug, not a CVE. They inherit exactly what the kernel enforces and nothing more.

> **The way to make a Tier 2 extension safe is not to review it harder. It is to make the kernel enforce the property.**

### The tier contract {#tier-contract}

| Tier | What we promise | Disclosure treatment | Change control | Test bar |
|---|---|---|---|---|
| **0** | The named guarantee holds, or it is a vulnerability | CVE-eligible; 90-day coordinated disclosure | Unanimous maintainers; no §VIII exception path | Conformance suite, adversarial tests, validator rule |
| **1** | We review this on a trust boundary and respond to reports | In disclosure scope; fix-or-ETA commitment, no correctness guarantee | Two maintainers; §VIII exception permitted with expiry | Adversarial tests for the boundary it sits on |
| **2** | Nothing beyond what the kernel enforces | Out of scope; triaged as a normal bug | Normal review | Normal tests |

Tier location tells you where a bug *lives*. The register tells you whether it *matters*. Triage reads the second, not the first — **a Tier 2 finding that reaches a Tier 0 guarantee is a Tier 0 finding**, and the vulnerability is the kernel's failure to contain it, not the extension.

### The guarantee register {#register}

Twelve guarantees. Each carries five fields, and all five are required: a **claim** an operator can act on, the **`file:line`** that enforces it, the adjacent thing that is **explicitly not covered**, how to **verify it yourself**, and what to do **if you need more**. A register with only the first two fields is marketing. With the first three it is a disclaimer. The fourth makes it falsifiable; the fifth makes it worth your time.

**Anything not in this register is not guaranteed.** It is a closed list, not a highlight reel — if it were a selection of our best controls, absence would mean nothing and you would be back to assembling the boundary by hand.

### G-TOOLS — Tool allowlist {#g-tools}

- **Claim.** A [personality](../getting-started/glossary.md#personality) (a directory of files that decides an agent's tools, memory, and model) can only call the [tools](../getting-started/glossary.md#tool) listed in its `toolset`. The list is enforced twice: the model is never shown a tool outside it, and a call to a tool outside it is refused at execution. A refusal is always *signalled* — every rejected call still emits a terminal error result, so a blocked tool can never be mistaken for one that ran. The surface a sandboxed script may call is the same list intersected with a static exclusion policy: a subset, never a superset.
- **Enforced at.** [`tool-registry.ts:206`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/tool-registry.ts#L206) — `toDefinitions` filters what the LLM sees — and [`tool-registry.ts:371`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/tool-registry.ts#L371), where `executeParallel` re-checks the identical condition. The intent is stated in the source at [`:274`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/tool-registry.ts#L274): *"allowedTools + filterOpts enforce tool access at execution time (belt-and-suspenders)."* The shared refusal path is [`tool-rejection.ts:56`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop/stages/tool-rejection.ts#L56) (`emitToolRejection`), and the script surface is derived at [`script-safe.ts:96`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/script-safe.ts#L96) (`scriptCallableFor`).
- **Explicitly not covered.** What an allowed tool then does with its authority. The allowlist decides *which* tools run, never *what* they may do once running — a personality granted `terminal` has the authority of `terminal`. The closest thing to a bound on that authority is G-CAP, and it bounds only the capabilities a tool takes through its injected context.
- **Verify it yourself.** `packages/core/src/__tests__/tool-registry.test.ts`, `tool-registry-exclude.test.ts`, and `script-safe.test.ts`; or read the two call sites, which are 150 lines apart and check the same thing.
- **If you need more.** Narrow the toolset, or run the exec-bearing tools under a container posture so the tool's authority is bounded by something other than the agent process's.

### G-CAP — Tool capability scoping {#g-cap}

- **Claim.** A tool reaches only the capabilities it **declared**, intersected with the personality's policy. Five capabilities are scoped this way — filesystem reach, network hosts, spawnable binaries, named secrets, and inbound attachments — and the intersection has **one derivation**, computed per call, so the surface a tool is given cannot drift from the surface the personality granted. A tool declaring more than the personality permits is rejected at registration rather than at first use, and an unknown or absent personality id resolves to deny-all, never to a wider set.
- **Enforced at.** [`capability-validator.ts:19`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/capability-validator.ts#L19) (`validateRegistration`, the registration-time intersection check), [`capability-resolver.ts:60`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/capability-resolver.ts#L60) (`resolveCapabilities`, the single derivation), and the three scoped decorators that carry the refusals: [`scoped-process.ts:8`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/scoped/scoped-process.ts#L8) (`BINARY_NOT_ALLOWED`), [`scoped-secrets.ts:12`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/scoped/scoped-secrets.ts#L12) (`SECRET_NOT_DECLARED`, with the segment-wise prefix match that refuses `..` traversal), and [`scoped-attachments.ts:22`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/scoped/scoped-attachments.ts#L22) (ref, URL and scheme confinement). Filesystem reach and network egress have their own rows — G-FS and G-NET — because their floors hold regardless of what was declared.
- **Explicitly not covered.** Three things, and the first is the big one. **(a)** This scopes what a tool takes through its **injected context**, not what a tool's own module does. A tool that imports `node:child_process` or `globalThis.fetch` directly bypasses every decorator here; keeping tools on the injected seams is Law 7's job and it is enforced by review and a lint test, not by this boundary. **(b)** A wildcard declaration is a declaration, not a bound — a tool declaring `allowedBinaries: ['*']` or `allowedHosts: ['*']` is scoped to everything the always-on floors still permit, which for network means G-NET's floor and for process means nothing beyond the OS. **(c)** The authority *inside* a granted capability: a tool permitted to spawn `bash` has the authority of `bash`.
- **Verify it yourself.** `packages/core/src/__tests__/capability-validator.test.ts`, `capability-resolver.test.ts`, `capability-integration.test.ts`, and `scoped-attachments.test.ts`; or run `ethos personality show <id>` and compare the resolved reach against the tool declarations.
- **If you need more.** Audit the capability declarations of the tools you actually grant — a `*` in a declaration is where this guarantee stops narrowing — and run exec-bearing tools under a container posture, which bounds the process rather than the declaration.

### G-FS — Filesystem reach {#g-fs}

- **Claim.** A personality cannot read or write outside its declared [`fs_reach`](../getting-started/glossary.md#fs-reach) (the per-personality filesystem allowlist). The allowlist has **one derivation**, feeding both the app-layer `ScopedStorage` prefixes and the container's bind mounts, so the two cannot disagree. The check normalises the path lexically **and** walks every path segment with `lstat`, refusing any segment that is a symbolic link — per-segment, because a symlinked parent escapes with a non-symlink leaf.
- **Enforced at.** [`fs-reach.ts:105`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/fs-reach.ts#L105) (`deriveFsReachPaths`, the single derivation), [`scoped-fs.ts:102`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/scoped/scoped-fs.ts#L102) (`checkReach` — the deny floor, the lexical prefix test, and the segment walk) with the symlink refusal at [`:136`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/scoped/scoped-fs.ts#L136), [`scoped-storage.ts:79`](https://github.com/ethosagent/ethos/blob/main/packages/storage-fs/src/scoped-storage.ts#L79), and [`path-boundary.ts:17`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/path-boundary.ts#L17) (`assertWithinBase`).
- **Explicitly not covered.** **TOCTOU between check and use.** An attacker who can swap a path between the walk and the open still wins. Closing that requires fd-level `openat` semantics that Node does not expose — which is why remediation has to move to the container. This is the same class Snyk used for roughly 25% arbitrary read/write against OpenClaw, and their fix had to move to the container too.
- **Verify it yourself.** `packages/core/src/__tests__/fs-reach.test.ts` and the symlink cases in `extensions/tools-file/src/__tests__/boundary.test.ts`; or run `ethos personality show <id>` and read the `## Filesystem reach` block, which prints the resolved allowlist.
- **If you need more.** Container posture. `fs_reach` is a correctness boundary against a mistaken agent, not a containment boundary against a hostile one; the container is the layer that survives a symlink race.

### G-NET — Network egress {#g-net}

- **Claim.** Outbound HTTP from tools goes through `safeFetch`, which resolves the hostname, validates the **resolved IP** against private-network and cloud-metadata rules, enforces an `http`/`https` scheme allowlist, and **revalidates on every redirect hop** rather than trusting the platform's automatic redirect follow. The floor is not overridable from above it: a tool's declared host allowlist narrows the destination set, and a URL that clears the allowlist still goes through the floor. Operator-supplied base URLs that are literals rather than runtime destinations — LLM endpoints, webhook targets — are checked at construction time by the same rules minus DNS resolution.
- **Enforced at.** [`safe-fetch.ts:66`](https://github.com/ethosagent/ethos/blob/main/packages/safety/network/src/safe-fetch.ts#L66), with the per-hop revalidation loop at [`:77`](https://github.com/ethosagent/ethos/blob/main/packages/safety/network/src/safe-fetch.ts#L77), auto-redirect disabled at [`:85`](https://github.com/ethosagent/ethos/blob/main/packages/safety/network/src/safe-fetch.ts#L85) (`redirect: 'manual'`), the scheme gate at [`scheme.ts:21`](https://github.com/ethosagent/ethos/blob/main/packages/safety/network/src/scheme.ts#L21), and cross-origin auth-header stripping at [`safe-fetch.ts:300`](https://github.com/ethosagent/ethos/blob/main/packages/safety/network/src/safe-fetch.ts#L300). The per-tool allowlist that sits over the floor is at [`scoped-fetch.ts:57`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/scoped/scoped-fetch.ts#L57) (`HOST_NOT_ALLOWED`), and the synchronous construction-time validator is [`url-validator.ts:135`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/url-validator.ts#L135) (`validateUrl`).
- **Explicitly not covered.** Exfiltration through an **allowed** destination. DNS-over-HTTPS. Encrypted side channels. Full DNS-rebinding defence — the module's own header at [`:11`](https://github.com/ethosagent/ethos/blob/main/packages/safety/network/src/safe-fetch.ts#L11) states the v1 honesty: it resolves and validates, it does not pin the resolved address through to connect. And one deliberate widening: `safety.network.allow_private_urls` opts a personality into RFC1918, loopback, and link-local destinations. It is off by default, per-personality, and flagged by `ethos security-audit`; it cannot reach cloud metadata, which stays blocked regardless.
- **Verify it yourself.** `packages/safety/network/src/__tests__/`; `packages/core/src/__tests__/url-validator.test.ts`.
- **If you need more.** Egress filtering at the network layer — a proxy or firewall with a destination allowlist. An SSRF guard bounds *where* a request may go, never *what* it may carry.

### G-INJ — Injection defense {#g-inj}

- **Claim.** Untrusted content reaching the model is wrapped in provenance markers, run through a two-tier classifier (regex tier always, LLM tier by policy), and followed by a post-read downgrade that withdraws dangerous tools for a bounded number of turns after untrusted content enters context. No personality field can switch this off.
- **Enforced at.** [`wrap.ts:35`](https://github.com/ethosagent/ethos/blob/main/packages/safety/injection/src/wrap.ts#L35) (`wrapUntrusted`), [`classifier.ts:60`](https://github.com/ethosagent/ethos/blob/main/packages/safety/injection/src/classifier.ts#L60) (`createLLMClassifier`), [`downgrade.ts:23`](https://github.com/ethosagent/ethos/blob/main/packages/safety/injection/src/downgrade.ts#L23) (`resolveDowngradedTools`); applied at [`context-assembly.ts:418`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop/stages/context-assembly.ts#L418) (the prelude, pushed unconditionally), [`agent-loop.ts:600`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop.ts#L600) (the post-read downgrade tool set), and [`tool-processing.ts:703`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop/stages/tool-processing.ts#L703) (`handleUntrustedResult` on every untrusted tool result), whose wrap-then-two-tier-classify body is [`result-defense.ts:26`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop/result-defense.ts#L26).
- **Explicitly not covered.** **Adversarially-iterated injection.** Bluntly: the regex tier is a published **v1 floor** and it is not the load-bearing half. The structural defences — provenance wrapping and post-read tool downgrade — are what constrain a successful injection, because they change what the model *can do* rather than guessing what the text *means*. A classifier operating on an attacker-controlled string loses to an attacker who can iterate.
- **Verify it yourself.** `packages/safety/injection/src/__tests__/`; or grep your personalities for `injectionDefense` and confirm no field disables the pipeline. For the injected bundle as a whole, `runAgentSafetyConformance` in `packages/core/src/safety-conformance.ts` feeds the kit input it must change and asserts it changed — a no-op implementation that satisfies the types fails it; `packages/wiring/src/__tests__/safety-conformance-wiring.test.ts` runs it against the shipped composition.
- **If you need more.** Assume injection succeeds and bound the blast radius: narrow the toolset, run under a container posture, and keep the approval gate on for consequential tools.

### G-SEC — Secrets {#g-sec}

- **Claim.** `SecretsResolver` is the **sole** storage and retrieval path for credential material. No secret value is written to a config file, personality file, MCP server config, export archive, or any storage path outside it. Config may reference a secret by name, never by value. And where a credential *name* is propagated into a third-party subprocess's environment — the `mcp_env_passthrough` path, by which a [skill](../getting-started/glossary.md#skill) asks for an env var to reach an MCP server — the propagation is gated twice: only skills the active personality admits contribute names, and only MCP servers that personality has **attached** receive them. The attached set is a whitelist, so an empty one propagates nothing.
- **Enforced at.** [`secrets.ts:18`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/secrets.ts#L18) — the four-method contract — and [ARCHITECTURE.md §V S9](https://github.com/ethosagent/ethos/blob/main/ARCHITECTURE.md), which states *"No exception path exists for this rule"*, with no exception entry in the sidecar. The passthrough gate is [`skill-passthrough.ts:31`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/skill-passthrough.ts#L31) (`applySkillPassthrough`, the attached-server whitelist), fed by `deriveSkillPassthrough` at [`:9`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/skill-passthrough.ts#L9), which admits only skills that clear `filterSkill` for the personality.
- **Explicitly not covered.** A secret the **operator pastes into a prompt**. Once a credential is conversation text it is history, context, and — subject to the observability policy — a stored row. The resolver governs where secrets are *kept*, not what a human types. Nor does the passthrough gate bound what an **attached** server does with a var it legitimately received: the whitelist decides *which* subprocess gets the credential, never what that third-party process then does with it.
- **Verify it yourself.** `rg -n 'apiKey|api_key|token' ~/.ethos/config.yaml` should return refs, not values; `packages/storage-fs/src/__tests__/` covers the resolver paths, and `packages/wiring/src/__tests__/skill-passthrough.test.ts` covers both halves of the passthrough gate.
- **If you need more.** An external secrets backend — `@ethosagent/secrets-aws` exists — and operator discipline about prompts, which no framework can enforce for you.

### G-RED — Credential redaction {#g-red}

- **Claim.** Values matching the known credential pattern set are replaced before they reach `observability.db`, and before the Slack and Discord **approval cards** render tool args into a channel.
- **Enforced at.** [`redact/index.ts:39`](https://github.com/ethosagent/ethos/blob/main/packages/safety/redact/src/index.ts#L39) (`detectSecrets`), [`:51`](https://github.com/ethosagent/ethos/blob/main/packages/safety/redact/src/index.ts#L51) (`redactString`), [`:68`](https://github.com/ethosagent/ethos/blob/main/packages/safety/redact/src/index.ts#L68) (`redactJson`), applied on the write path at [`store.ts:114`](https://github.com/ethosagent/ethos/blob/main/extensions/observability-sqlite/src/store.ts#L114), [`:156`](https://github.com/ethosagent/ethos/blob/main/extensions/observability-sqlite/src/store.ts#L156), [`:193`](https://github.com/ethosagent/ethos/blob/main/extensions/observability-sqlite/src/store.ts#L193), and [`:234`](https://github.com/ethosagent/ethos/blob/main/extensions/observability-sqlite/src/store.ts#L234); and on the approval surface at [`platform-slack/blocks/approval.ts:118`](https://github.com/ethosagent/ethos/blob/main/extensions/platform-slack/src/blocks/approval.ts#L118) and [`platform-discord/blocks/approval.ts:77`](https://github.com/ethosagent/ethos/blob/main/extensions/platform-discord/src/blocks/approval.ts#L77) (`formatArgs` in each).
- **Explicitly not covered.** Say it plainly: **this is a leak-reducer, not a containment boundary.** A credential in a format the pattern set does not know is not redacted. The set covers Anthropic and OpenAI key shapes, generic bearer tokens, and AWS access keys; your internal token format is not in it unless you add it. And the channel coverage is the **approval card's tool args only** — not the model's own message text, tool results, or error strings, which reach a channel unredacted. An adapter surface is covered when it is named above and not otherwise.
- **Verify it yourself.** `packages/safety/redact/src/__tests__/`; or write a known key shape into a tool error and read the row back out of `observability.db`. For the approval surface, `extensions/platform-slack/src/__tests__/approval.test.ts` and `extensions/platform-discord/src/__tests__/approval.test.ts`.
- **If you need more.** Add your own patterns through the extra-patterns seam the store already threads, and treat `observability.db` as credential-adjacent storage regardless.

### G-APP — Approval gating {#g-app}

- **Claim.** Tool calls classified as dangerous are held in front of an approval surface before execution. The smart reviewer is **fail-closed**: an unparseable verdict, a timeout, or a thrown error all resolve to `ask`, never to `approve`. Approval modes only ever make the flagged set **stricter** — the composition is a union, never an override. The gate is also not silently omissible: a composition root that declares its loop gated while registering no policy behind the framework's fire site is refused with a typed error at dispatch, rather than running ungated.
- **Enforced at.** [`danger-predicate.ts:274`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/danger-predicate.ts#L274), [`smart-approver.ts:144`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/smart-approver.ts#L144) (`{ decision: 'ask', reason: 'reviewer gave no usable verdict' }`) and [`:149`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/smart-approver.ts#L149) (`'reviewer error (fail-closed): …'`), with the union at [`danger-predicate.ts:241`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/danger-predicate.ts#L241). The single fire site every tool call passes through is [`per-call-enforcement.ts:40`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop/stages/per-call-enforcement.ts#L40) (`enforceBeforeToolCall`, where a handler error *blocks* the call), over the sequential execution model at [`hook-registry.ts:94`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/hook-registry.ts#L94) (`fireModifying`). The two seams that make the mode dispatch and `safety.denyRules` actually consulted are bound at [`approval-seams.ts:106`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/approval-seams.ts#L106), and the posture guard that refuses an unbacked `gated` claim is [`approval-posture.ts:38`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop/approval-posture.ts#L38).
- **Explicitly not covered.** **An approval gate is a heuristic over an attacker-influenced string. It is not a boundary against an adversarial LLM.** It reduces accidental damage and gives the model a clear stop signal. It does not sandbox a hostile or compromised agent. And the posture guard checks *consistency*, not *quality*: an embedder may legitimately declare its loop `ungated`, which is permitted and logged once — never silent, but also never blocked.
- **Verify it yourself.** `packages/wiring/src/__tests__/` for the fail-closed paths, `approval-seams.test.ts` for the seam binding; `ethos personality show <id>` for the resolved execution posture the gate sits over.
- **If you need more.** Do not treat the gate as containment. Bound the tools instead — toolset, container posture, and an operator who reads what they are approving.

### G-EXEC — Execution posture honesty {#g-exec}

- **Claim.** The resolved execution posture never claims containment it is not providing. A personality holding an exec-bearing tool resolves to one of exactly three outcomes: a **sandboxed** backend; an **honestly labelled un-sandboxed** `local` posture carrying `hostFallback` with the reason; or a **refusal** that makes the exec tools unavailable, taken when the constitution forbids the host fallback. There is no fourth path where code runs on the host while the character sheet says *sandboxed*. Where the Docker daemon is merely down, the posture stays `docker` and produces a typed decision the operator must answer — it never auto-downgrades to the host behind their back.
- **Enforced at.** [`resolve-execution-posture.ts:197`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/resolve-execution-posture.ts#L197) (`resolveExecutionPosture`, the posture selection), with the build-impossible branch at [`:252`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/resolve-execution-posture.ts#L252), the `hostFallback` labelling at [`:289`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/resolve-execution-posture.ts#L289), and the daemon-unavailable decision at [`:338`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/resolve-execution-posture.ts#L338).
- **Explicitly not covered.** **This is an honesty guarantee, not a containment one.** It promises the posture describes reality; the containment itself is Docker's, and the `local` posture provides none at all. It says nothing about what an exec tool does *inside* a container — network mode, mounts, and memory are resolved here, but a tool with a shell in a container has a shell. It also does not cover a surface that renders the posture incorrectly: the resolver's output is the boundary, and a UI that mislabels it is a bug in that UI.
- **Verify it yourself.** `packages/wiring/src/__tests__/resolve-execution-posture.test.ts`; or run `ethos personality show <id>` and read the execution-posture block, which prints the backend, the network mode, and any `hostFallback` reason.
- **If you need more.** Run the whole agent process inside a container you control. The posture tells you truthfully whether the framework sandboxed the tool; it cannot sandbox the process it is running in.

### G-WATCH — Watcher {#g-watch}

- **Claim.** An out-of-band observer reads the agent event stream **across turns** and halts the turn on rate-limit, token-budget, compounding-error, and suspicious-sequence rules. It is out-of-band by design: it does not depend on the in-loop checks getting the classification right.
- **Enforced at.** [`rules.ts:20`](https://github.com/ethosagent/ethos/blob/main/packages/safety/watcher/src/rules.ts#L20) (`rateLimitRule`), [`:79`](https://github.com/ethosagent/ethos/blob/main/packages/safety/watcher/src/rules.ts#L79) (`tokenBudgetRule`), [`:110`](https://github.com/ethosagent/ethos/blob/main/packages/safety/watcher/src/rules.ts#L110) (`compoundingErrorRule`), [`:161`](https://github.com/ethosagent/ethos/blob/main/packages/safety/watcher/src/rules.ts#L161) (`suspiciousSequenceRule`), composed at [`:205`](https://github.com/ethosagent/ethos/blob/main/packages/safety/watcher/src/rules.ts#L205); constructed in wiring at [`build-agent-loop.ts:259`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/build-agent-loop.ts#L259).
- **Explicitly not covered.** **It observes and halts; it does not prevent the first bad call.** By construction it fires on a pattern, and a pattern needs at least one instance. A single catastrophic call inside budget is exactly what it does not catch.
- **Verify it yourself.** `packages/safety/watcher/src/__tests__/`; the `halt` events in `observability.db` after tripping a rule deliberately.
- **If you need more.** Per-turn budgets you set yourself, and the approval gate for the first-call case the watcher structurally cannot cover.

### G-CHAN — Channel admission {#g-chan}

- **Claim.** Inbound platform messages pass an admission filter before reaching the agent: a sender allowlist (owner plus configured recipients), a one-time DM pairing flow for unknown senders, a mention gate in group channels, and a context-visibility filter that strips quoted or threaded content from non-allowlisted senders — including the channel-history backfill an adapter attaches to the first message in a lane.
- **Enforced at.** [`channel-filter.ts:111`](https://github.com/ethosagent/ethos/blob/main/packages/safety/channel/src/channel-filter.ts#L111) (`checkMessage`, whose header documents the eight-step order), [`:79`](https://github.com/ethosagent/ethos/blob/main/packages/safety/channel/src/channel-filter.ts#L79) (`isSenderAllowed`), [`:24`](https://github.com/ethosagent/ethos/blob/main/packages/safety/channel/src/channel-filter.ts#L24) (`dmPolicy`), [`:33`](https://github.com/ethosagent/ethos/blob/main/packages/safety/channel/src/channel-filter.ts#L33) (`contextVisibility`), with pairing codes in [`pairing-store.ts`](https://github.com/ethosagent/ethos/blob/main/packages/safety/channel/src/pairing-store.ts).
- **Explicitly not covered.** Three things. **(a)** An allowlisted sender who is themselves the attacker — admission answers *who may speak*, never *what they may say*; that is G-INJ's problem, and G-INJ concedes the hard case. **(b)** The filter is **per-platform opt-in**: no platform config, or `enabled: false`, means allow-everything by design. An unconfigured platform is an ungated platform. **(c)** The quoted-content half of the context-visibility filter needs the adapter to name the quoted message's author. Slack and Discord do; an adapter that cannot leaves that half inert, because a missing author is indistinguishable from no quote at all. The history half takes the opposite posture — history an adapter does not attribute line by line is dropped whole.
- **Verify it yourself.** `packages/safety/channel/src/__tests__/`; the `channel.deny` events in `observability.db`.
- **If you need more.** Configure every platform you actually run — and remember that in a group channel the mention gate is a routing decision, not an authorization one.

### G-AUDIT — Audit substrate {#g-audit}

- **Claim.** Every safety decision — channel denials, watcher halts, approval verdicts, boundary refusals — lands as a queryable event in `observability.db`, with G-RED's credential redaction applied on the write path.
- **Enforced at.** [`observability-sqlite/src/store.ts:114`](https://github.com/ethosagent/ethos/blob/main/extensions/observability-sqlite/src/store.ts#L114) — the single write path, with redaction applied at `:114`, `:156`, `:193`, and `:234`.
- **Explicitly not covered.** **There is no tamper-evidence.** An operator with disk access can edit the rows. This is an audit **substrate**, not an audit **log** in the compliance sense — no hash chain, no append-only enforcement, no external anchor.
- **Verify it yourself.** Open `observability.db` with any SQLite client and edit a row. That is the demonstration.
- **If you need more.** Mirror the event stream to an off-host target at wiring time. The integrity property has to come from somewhere the operator of the box cannot reach.

### What is not a boundary {#non-boundaries}

The register is a closed list, which leaves you to notice absences. These are the absences you would most reasonably assume are covered. Naming them is cheaper than being corrected in public.

| **IS a boundary** | **Is NOT a boundary** |
|---|---|
| The personality toolset — double-enforced at definition and execution | The approval gate against an adversarial LLM — a heuristic over an attacker-influenced string |
| `ScopedStorage` plus the `fs_reach` check — lexical normalisation and the per-segment symlink walk | Credential redaction — a leak-reducer, not a containment |
| `safeFetch` plus DNS validation on every redirect hop | The [skill](../getting-started/glossary.md#skill) and plugin static scanner — pre-install, advisory, trivially evaded by string concatenation |
| The OS and the container | The injection classifier's regex tier — an explicit v1 floor |
| The capabilities a tool takes through its injected context | A tool's own imports — `node:child_process` or `globalThis.fetch` inside a tool module bypass every scoped decorator |
| The execution posture's *honesty* about where code runs | The `local` posture as containment — it is the label for running un-sandboxed on the host |
| | `observability.db` — no tamper-evidence; the operator with disk access can edit rows |

A second published list sits alongside this one: the **out-of-scope column** of [What is the threat model?](./threat-model.md) — OS-level RCE, network MITM, physical access, malicious owner, deep transitive-dependency CVEs, adversarially-iterated injection, and insider threat among co-operators sharing a profile. The register points at both rather than duplicating them, so there is one copy of each statement to keep true.

### Gaps, disclosed {#gaps}

A published gap is a roadmap item. An unpublished one is a finding. The difference is entirely in whether we named the field, the contradiction, the fix, and the date — so that is the form every gap takes here. A weasel clause (*"some controls may be configurable in certain deployments"*) earns none of this; it reads as a pre-emptive excuse and invites the reporter to go looking for what it is hiding.

**Closed in this release.** Three contradictions between a published claim and the code were closed in the same change that published this page.

- **The `fs_reach` symlink hole.** The reach check was a normalised **lexical** prefix test with no symlink resolution, while [Security controls](./controls.md#symlink-misdirection-handling) published symlink misdirection as *Shipped*. A symlink planted inside an allowed prefix, pointing outside it, passed both the always-deny floor and the allow check — the floor compares the same lexically-resolved string, so it never compensated. Two other surfaces had independently discovered this and each patched it locally, and neither patch reached the boundary. It is now fixed at the chokepoint: `checkReach` walks every path segment with `lstat` and refuses any segment that is a symbolic link, so every consumer — file tools, vision, web-api, gateway, and any future one — inherits the fix once. The residual is TOCTOU, which G-FS states plainly and which container-level remediation is the only real answer to.
- **The injection-defense opt-out.** The personality schema shipped an `injectionDefense.enabled` master switch that skipped wrapping, pattern check, and post-read downgrade — contradicting ARCHITECTURE.md §V S6 (`opt_out: forbidden`) and the published claim that per-personality knobs only ever *narrow* policy. In a multi-personality process, one personality setting it to `false` was exactly the composition hazard that claim promised could not happen. The field has been removed from the personality schema. A test-only need is a test-harness concern, not a personality field.
- **Enforcement reachable only through the shipped composition root.** Approval gating and the watcher were assembled in `@ethosagent/wiring`, so an embedder consuming `@ethosagent/core` with its own composition root got a fully functional agent loop with no approval gate and no error saying so. Enforcement now sits behind a policy seam that core requires: wiring still decides *what is dangerous*, core now requires that *something decided*. An embedder who omits it gets a typed refusal at construction rather than a silently ungated loop.

**Closed since publication.** Two gaps this section listed as open have since closed. Saying so is part of the same discipline as listing them.

- **The kernel now has a layer in the constitution.** ARCHITECTURE.md §II names `security-kernel` as a layer with its own dependency rules, and §IX carries the machine-readable form the validator reads. The safety packages are no longer governed by a single hand-written test.
- **The register is now mechanically tied to the code.** `scripts/check-architecture.mjs` fails CI in both directions: a row whose citation stops resolving to the enforcement point it names, a Tier 0 enforcement point published by no row, and a row that disagrees with the tier roster about what is kernel. Each citation is anchored to a **symbol**, not only a line number — so code that *moves* under a claim fails the same check as code that is deleted, which is the quieter half of the failure mode that produced this section.

**Open and tracked.** These are live today, with the phase they close in.

| Gap | What is true today | Fix | Phase |
|---|---|---|---|
| Plugins execute in-process with full Node privileges | The loader `import()`s a plugin entry directly into the process. A loaded plugin shares the process, the environment, the filesystem, and your API keys. The static scanner is pre-install and advisory. | Accepted, documented Tier 1 property, plus a recorded per-plugin capability grant at install time. Out-of-process isolation is a later phase. | Phase 5 |
| Two GitHub orgs are privileged in compiled code | A red scanner finding in anything under `ethosagent` or `anthropic` is operator-overridable by default, and yellow findings auto-acknowledge. | Make the trusted-org set operator-configurable; drop auto-acknowledge for everything except `builtin`. | Phase 5 |

### Triage responses {#triage-responses}

Four verdicts, four responses, written in advance by someone who is not annoyed. The verdict is not negotiable; the tone is entirely ours to choose, and it costs nothing. None of them says *"not a security issue"* — that phrasing is untrue (a Tier 2 bug can be a real bug with real consequences) and it is the fastest way to convert a courteous reporter into a public one.

**Verdict 1 — in scope, kernel.** The finding defeats a named Tier 0 guarantee, wherever the bug lives.

> Thank you. This crosses **G-\<ID\>** in our published guarantee register, so it is in scope and we are treating it as a security issue. We are handling it under 90-day coordinated disclosure and will confirm a fix commitment within \<N\> business days. The root cause will be fixed in the kernel rather than at the site you reported it against — the guarantee is ours to hold, wherever the composition chain runs. We will keep you on the thread through disclosure and credit you unless you ask us not to.

**Verdict 2 — in scope, guarded surface.** Tier 1, and it does not reach a Tier 0 guarantee.

> Thank you. `<module>` is **Tier 1** in our published tier roster — a guarded surface, in disclosure scope. We are committing to a fix and will give you a target date by \<date\>. To be precise about what that commits us to: Tier 1 carries a response commitment, not a correctness guarantee, and this finding does not cross a Tier 0 guarantee in the register. We will coordinate disclosure with you on that basis.

**Verdict 3 — out of scope, extension.** Tier 2, no Tier 0 guarantee crossed.

> Thank you for the report — this is a real bug and we have filed it as \#\<N\>. It is **out of scope under our published security boundary**: `<module>` is Tier 2 in the tier roster, and the finding does not cross a guarantee in the register. Concretely, that means it goes on the ordinary bug queue rather than the security-response queue: no embargo, no CVE, and no security SLA. You are under no obligation to hold it. If you think it composes into one of the register's guarantees through a step we missed, tell us how and we will re-triage — that path is what makes verdict 1 available regardless of which tier the bug lives in.

**Verdict 4 — out of scope, published non-goal.**

> Thank you for the report. This lands on something we publish as explicitly not a boundary: \<the non-boundary list entry, or the threat-model out-of-scope row\>, at \<link\>. That statement predates your report and is the reason we are closing this rather than a judgement we are forming now. If you can show a path from here to one of the guarantees in the register, that is a different report and we would like to see it.

## Trade-offs

### A narrow boundary raises the truth bar inside it {#truth-bar}

The wide scope this replaced quietly absorbed every over-claim. Publishing *"the personality toolset is a guarantee, and injection defense cannot be opted out"* converts an internal inconsistency into a valid external finding on day one. That is the single biggest cost of publishing a boundary — and it is also the argument for it, because it is the only mechanism that has reliably forced these fixes. An inconsistency nobody can cite is an inconsistency nobody prioritises. The three gaps closed in this release were all found by writing the register.

### Out-of-scope invites unilateral publication {#unilateral-publication}

A Tier 2 reporter owes us no embargo, and they owe it to us *because we told them the finding is not a security issue to us*. That is the deal, stated in both directions. Expect Tier 2 findings to appear on a blog before they appear in the issue tracker. It is the price of the filter and it is worth paying — the alternative is an embargo obligation over 87 extension directories, which is the promise this boundary replaced.

### A boundary used as a shield decays into a reflex {#dismissal-hazard}

The decay is invisible from inside: each individual close looks correct. The structural defence is verdict 1 — because a Tier 2 bug reaching a Tier 0 guarantee is a Tier 0 finding, *"it's in an extension"* is never a complete argument. That is necessary and not sufficient, which is why reports closed as out-of-scope get a quarterly review read specifically for a composition chain someone missed. A filter with no audit is an opinion with a table.

### Stability of the register {#stability}

> **Weakening or removing a published guarantee is a breaking change.**

It requires the [ARCHITECTURE.md §VI](https://github.com/ethosagent/ethos/blob/main/ARCHITECTURE.md) amendment class matching its blast radius — **Substantive** for narrowing a claim, **Structural** for removing one or changing which layer enforces it, **Schema** where a frozen schema field carries it — **plus a release-note entry naming what stopped being true.** Not "security hardening in 0.7": the sentence that is no longer accurate, and the sentence that replaces it.

Adding a guarantee is additive and cheap — one row, one enforcement point, ordinary review. **The asymmetry is deliberate and it is the entire reason the register can be relied on.** A list that can quietly shrink is a list you have to re-read before every upgrade, which is the same as having no list.

## See also

- [Security policy](https://github.com/ethosagent/ethos/blob/main/SECURITY.md) — the triage decision table and how to report.
- [What is the threat model?](./threat-model.md) — the in-scope threats and the out-of-scope column this page cites.
- [Security controls](./controls.md) — the full control catalogue with source paths and status tags.
- [Pre-launch hardening pass](./security-fixes.md) — the historical fix log, including the symlink entry this release corrects.
- [Production hardening checklist](./production-hardening-checklist.md) — what the register's *If you need more* fields turn into operationally.
