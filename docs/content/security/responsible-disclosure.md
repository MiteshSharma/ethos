---
title: Responsible disclosure
description: How to report a security issue in Ethos, what is in scope, what is out of scope, and the response timeline you can expect.
kind: reference
audience: shared
slug: responsible-disclosure
updated: 2026-05-12
---

If you have found a security issue in Ethos, this page tells you how to report it, what we will do with it, and what is in or out of scope. We take security reports seriously — every issue surfaced through this channel gets routed to a maintainer, not a triage queue.

## Source {#source}

| Material | Where |
|---|---|
| Reporting channel | [GitHub private security advisories](https://github.com/ethosagent/ethos/security/advisories/new) |
| In-scope controls catalogue | [Security controls](./controls.md) |
| Out-of-scope reference | [Threat model — out of scope](./threat-model.md#discussion) |

## Reporting {#reporting}

Open a GitHub private security advisory at `https://github.com/ethosagent/ethos/security/advisories/new`. The advisory is private until disclosure — only repo maintainers see it. We will add a dedicated security mailbox once one is set up; until then, the GitHub advisory is the canonical channel.

A good report includes:

- **Summary** — one-paragraph description of the issue.
- **Affected version(s)** — Ethos version (`ethos --version`), and the source commit if you are working from `main`.
- **Reproduction** — the smallest set of steps that reproduces the issue. Stand-alone repros (a config plus a script) are easier to triage than environment-specific traces.
- **Impact** — what an attacker can do with the issue. Map it to a row in the [Threat model](./threat-model.md) if you can.
- **Suggested fix** — optional, but appreciated.

Do not open public GitHub issues for security reports. Public disclosure before a fix is shipped puts other Ethos users at risk.

## What we commit to {#what-we-commit-to}

| Step | Description | Timeline |
|---|---|---|
| Acknowledgement | A human replies confirming receipt | Within 3 business days |
| Triage | Severity assessment plus owner assigned | Within 7 business days |
| Status updates | Progress on the fix | Every 14 days minimum |
| Fix or rejection | Patch shipped, or in-scope rejection with reasoning | Within 90 days for high/critical; 180 days for medium/low |
| Public advisory | GitHub Security Advisory plus release notes | At fix release |
| Credit | Reporter named in the advisory (if they want) | At fix release |

If we miss any of these timelines, the reporter is free to publish — but please give us a chance to land the fix first.

## Severity rubric {#severity-rubric}

We use a simplified rubric mapped to the [Threat model](./threat-model.md):

- **Critical** — Bypass of a control protecting a realistic in-scope threat. Example: an SSRF bypass that reaches `169.254.169.254`. An RCE in the CLI process from a third-party skill. A pairing-flow replay.
- **High** — Bypass of a control with a non-trivial precondition, or a leak that requires multiple operator missteps to exploit. Example: a redirect chain that defeats the network reach check only when a specific header is present.
- **Medium** — Bypass of a control where the impact is informational or contained. Example: a redaction-pattern miss that leaks a non-credential value.
- **Low** — Hardening request, defense-in-depth improvement, or finding outside the runtime path. Example: a config validator that accepts a deprecated form.

Critical and High get patch releases. Medium and Low typically ride the next minor.

## In scope {#in-scope}

Everything in the [Security controls](./controls.md) catalogue. If a control listed there can be bypassed, that is a bug. Specifically:

- Channel allowlist, pairing, mention-gate, context-visibility filter
- Per-[personality](../getting-started/glossary.md#personality) [tool](../getting-started/glossary.md#tool)set enforcement
- Hardline blocklist
- Risk classifier (pattern + LLM tier)
- `ScopedStorage`, `BoundaryError`, symlink-misdirection handling
- Network policy (SSRF, scheme allowlist, cloud-metadata, redirect revalidation, DNS pinning)
- Provenance wrapping, two-tier injection classifier, post-read tool downgrade
- Watcher rules (rate-limit, token-budget, compounding-error, suspicious-sequence)
- Credential redaction
- Skill and plugin install scanner, trust tiers, MCP env minimization
- Audit substrate (`observability.db`)

## Out of scope {#out-of-scope}

These match the [Threat model's out-of-scope column](./threat-model.md#discussion) and will be closed without a fix:

- OS-level RCE on the host running Ethos.
- Network MITM (TLS is the right layer).
- Physical access to the machine.
- "Malicious owner" scenarios — anyone with edit access to `~/.ethos/config.yaml` is sovereign by design.
- Deep transitive-dependency CVEs in npm packages.
- Adversarially-iterated prompt injection bypasses of pattern detection (the structural defenses — provenance plus tool downgrade — are the ones we treat as load-bearing).
- Multi-tenant scenarios in a single `~/.ethos/` profile.

## Third-party LLM provider issues {#third-party-llm-provider-issues}

Ethos is a client to upstream providers (Anthropic, OpenAI-compatible). Issues in the provider's service are the provider's responsibility — we will happily file with them, but the patch ships from their side.

If a provider issue is exploited *through* Ethos in a way the framework should mitigate (e.g. provider-side prompt injection that should be caught by our classifier), that is an Ethos issue and is in scope.

## Coordinated disclosure {#coordinated-disclosure}

For Critical and High issues, we follow this rough sequence:

| Day | Step |
|---|---|
| 0 | Report received; ack within 3 business days |
| 0–14 | Triage, severity assignment, owner |
| 14–60 | Fix developed and reviewed |
| 60–80 | Pre-release coordination with downstream packagers if applicable |
| 80–90 | Patch release plus GitHub Security Advisory plus release notes |

Reporters are kept in the loop at each stage. We can also share the proposed patch for review before release if that helps the reporter validate the fix.

## Bounties {#bounties}

We do not currently run a paid bug bounty program. We do publicly credit reporters in the GitHub Security Advisory and the release notes (with reporter consent). A handful of reports have earned long-form acknowledgements in the changelog.

A bounty program may exist in the future as a partner integration. It will not change the disclosure process described here.

## Hall of fame {#hall-of-fame}

When advisories ship, the reporter is credited (with consent) in the advisory itself and listed here. The list is empty as of this writing — that is a function of the framework's age, not a claim about how secure it is.

## See also {#see-also}

- [How does Ethos defend against the threats it knows about?](./overview.md) — the framing for everything in this section.
- [What is the threat model?](./threat-model.md) — in-scope vs. out-of-scope, in detail.
- [Security controls](./controls.md) — the catalogue, with source paths.
- [Pre-launch hardening pass](./security-fixes.md) — the issues we found and fixed before shipping.
