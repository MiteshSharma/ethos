# Security policy

## Reporting

Use **[GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)** ("Report a vulnerability" button on this repo's Security tab). We aim to acknowledge within 5 business days.

Before you write the report, you can decide the outcome yourself. This page carries the same decision table a triager uses. If your finding crosses a published guarantee, it is a security report and gets the full process. If it does not, it is an ordinary bug and goes on the normal queue. Nothing about that determination is private to us.

## Scope

Scope is defined by **what we published as a guarantee**, not by which directory the bug lives in.

<!-- register-claim
     ids: G-TOOLS, G-CAP, G-FS, G-NET, G-INJ, G-SEC, G-RED, G-APP, G-EXEC, G-WATCH, G-CHAN, G-AUDIT
-->
- **The guarantee register** — twelve named guarantees, each with the `file:line` that enforces it, in [docs/content/security/security-boundary.md](docs/content/security/security-boundary.md#register). Anything not in the register is not guaranteed.
- **The tier roster** — every workspace package carries a tier in [`.architecture-state.yaml`](.architecture-state.yaml), committed and dated before any report arrives. 119 packages: 10 at Tier 0, 23 at Tier 1, 86 at Tier 2.

| Tier | What we promise | Disclosure treatment |
|---|---|---|
| **0 — security kernel** | The named guarantee holds, or it is a vulnerability | CVE-eligible; 90-day coordinated disclosure |
| **1 — guarded surfaces** | We review this on a trust boundary and respond to reports | In disclosure scope; fix-or-ETA commitment, **no correctness guarantee** |
| **2 — extensions** | Nothing beyond what the kernel enforces | Out of scope; triaged as a normal bug |

**Tier 0** is `@ethosagent/types`, the six `@ethosagent/safety-*` packages, the named enforcement files in `@ethosagent/core` and `@ethosagent/wiring`, and `@ethosagent/storage-fs`. **Tier 1** is the gateway and its seven platform adapters, the reachable execution backends (`execution-docker`, `execution-local`) and the exec-bearing tools, the third-party-code loaders (`tools-mcp`, `skills`, `skill-evolver`, `plugin-loader`), `apps/web-api`, the credential and data-at-rest packages (including `plugin-sdk`, which writes plugin credential material), and the audit and delivery stores. Everything else is **Tier 2**. The sidecar is authoritative per package.

> **A Tier 2 finding that reaches a Tier 0 guarantee is a Tier 0 finding.** The tiers bound what we promise to be *correct*, not what we promise to *look at*. When an extension bug composes into a kernel breach, the extension is not the vulnerability — the kernel's failure to contain it is, and that is where the fix lands.

## Out of scope

- **Tier 2 modules**, where no guarantee in the register is crossed. Real bugs, ordinary queue.
- **Published non-boundaries** — the approval gate against an adversarial LLM, credential redaction, the skill and plugin static scanner, the injection classifier's regex tier, and `observability.db`'s lack of tamper-evidence. See the [non-boundary list](docs/content/security/security-boundary.md#non-boundaries).
- **The threat model's out-of-scope column** — OS-level RCE, network MITM, physical access, malicious owner, deep transitive-dependency CVEs, adversarially-iterated prompt injection, and insider threat among co-operators sharing a profile. See [threat-model.md](docs/content/security/threat-model.md).
- **User-installed plugins, MCP servers, or skills** — report to those projects. Note that installing a plugin is equivalent to running arbitrary code as your user; the static scanner is pre-install and advisory, not a boundary.
- Issues only reproducible with experimental flags or `--no-safety`.

## The decision table

Four verdicts. A triager reaches one in a single pass from the report plus two artefacts — the guarantee register and the tier assignment in `.architecture-state.yaml`. You can run it yourself before you write.

| Verdict | Condition | What we owe | Disclosure treatment |
|---|---|---|---|
| **1 — In scope, kernel** | The finding defeats a named Tier 0 guarantee from the register — **wherever the bug lives**, Tier 0, 1, or 2 | Fix commitment, with the root cause fixed in the kernel rather than at the reporting site | Full disclosure process; CVE-eligible; 90-day coordinated disclosure |
| **2 — In scope, guarded surface** | The finding is in a Tier 1 module and does **not** reach a Tier 0 guarantee | Fix intent and a stated response time; explicitly **no** correctness guarantee | Coordinated disclosure with a stated response commitment |
| **3 — Out of scope, extension** | Tier 2, no Tier 0 guarantee crossed | Ordinary bug triage on the normal queue, same as any other bug | Filed in public immediately; no embargo, no CVE, no security-response SLA |
| **4 — Out of scope, published non-goal** | The finding lands on something already published as not-a-boundary — the non-boundary list, or the out-of-scope column of the threat model | A link and a courteous close | Closed with a citation to the published statement that already said so |

Verdict 1 is what keeps the table honest. If it could only ever return verdict 3 for a Tier 2 file, this would be a shield rather than a filter, and it would deserve the reputation shields get.

The [response we send for each verdict](docs/content/security/security-boundary.md#triage-responses) is published too, so you know what a close looks like before you get one. None of them says "not a security issue" — a Tier 2 bug can be a real bug with real consequences.

## Known gaps

Gaps ship disclosed, with the field named, the contradiction named, the fix named, and the phase it lands in — see [Gaps, disclosed](docs/content/security/security-boundary.md#gaps). A published gap is a roadmap item; an unpublished one is a finding. If you find one we have not published, that is a report we want.

## Disclosure

We follow 90-day coordinated disclosure with fix-or-ETA acknowledgement, for Tier 0 and Tier 1 findings. Tier 2 findings carry no embargo obligation in either direction: we file them publicly, and you are free to publish on your own timeline.
