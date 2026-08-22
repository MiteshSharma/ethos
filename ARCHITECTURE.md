Ethos — Architectural Constitution
==================================

> This document is the constitution of the Ethos framework. It defines the
> non-negotiable laws of the system's structure: dependency direction,
> extension boundaries, ownership of critical contracts, and the rules a
> validator mechanically enforces.
>
> This document is intentionally short, intentionally restrictive, and
> intentionally slow to change.

**What belongs here.** Laws. Principles. Invariants. Schemas. Governance.
Boundaries that, if violated, compromise the framework's identity.

**What does not belong here.** Implementation inventory, current state,
package examples, file paths that may move, debugging gotchas, migration
notes, operational how-tos. Those live in [AGENTS.md](./AGENTS.md) (working
manual), [CONTRIBUTING.md](./CONTRIBUTING.md) (process), and the operational
state sidecar that complements §IX.

If a fact would become wrong as the codebase evolves, it does not belong
in this document.

This document changes only by the procedure in §VI. No casual edits.

------------------------------------------------------------------------

## I. Immutable Principles

These five principles do not change by amendment. A change to this
section re-issues the constitution under a new major version; the
previous version remains the authority for code that has not migrated.

**P1 — Contracts before implementations.**
Every replaceable behaviour is defined as an interface before any
implementation of it exists. New behaviours are added by writing a
contract, then writing one or more implementations against the contract.
Never the reverse.

**P2 — Dependency direction is one-way.**
A module may depend on modules in layers below it, and on no module in a
layer above it. The direction is enforced mechanically; it is not a
stylistic preference.

**P3 — Composition is explicit.**
Concrete implementations are assembled in named composition roots,
nowhere else. Code never reaches for siblings, globals, or process
environment at use time.

**P4 — Personality is structure, not prose.**
A personality is a schema-bound component whose fields determine tool
access, memory scope, model routing, filesystem reach, and safety
policy. Personality is not a system prompt string and may not grant any
capability the schema does not express.

**P5 — Safety primitives are non-optional.**
Every inbound message, every outbound message, and every tool invocation
crosses a safety boundary. Removing the boundary, downgrading the
boundary, or routing around the boundary is not within the power of any
extension or app.

------------------------------------------------------------------------

## II. Runtime Boundary

The primary mental model.

```
                          ┌──────────┐
                          │   Apps   │      user-facing entry points
                          └────┬─────┘
                               │
              ┌────────────────▼──────────────────┐
              │              Wiring               │   composition roots
              └─────┬──────────┬──────────┬───────┘
                    │          │          │
      ┌─────────────▼───┐  ┌───▼────┐  ┌──▼─────────┐
      │ Security kernel │  │  Core  │  │ Extensions │
      └───────┬─────────┘  └───┬────┘  └─────┬──────┘
              │                │             │
            ┌─▼────────────────▼─────────────▼──┐
            │             Contracts             │   interfaces, zero
            └───────────────────────────────────┘   internal deps
```

**Contracts** are the floor: pure TypeScript interfaces, value types,
discriminated unions. They have no internal dependencies. Everything
else depends on them.

**Security kernel** is the layer that implements the safety primitives
§V mandates. It depends on contracts only and imports nothing above
itself. Core does not import it at runtime: core consumes kernel
capability through injected contract types, and wiring is the layer that
binds an implementation to that seam. This is a restriction on core, not
a licence for anyone else — a kernel that core could import directly
would make the engine unswappable and the kernel unreplaceable.

**Core** is the framework engine: the agent loop, the registries, the
default context engines, and the enforcement points at which the §V
safety primitives are applied. Core depends on contracts only.

**Extensions** are concrete implementations of contracts: providers,
tools, memory backends, platform adapters, persistence stores, content
bundles. Extensions depend on contracts, on the security kernel, and on
core; they do not assume the presence of sibling extensions outside the
patterns in §IV.

**Wiring** is the composition layer: the only layer that imports
extensions by name, assembles them into a running system, and binds a
security-kernel implementation to the seam core is constructed with.

**Apps** are user-facing entry points: CLIs, TUIs, web clients, IDE
extensions, protocol servers. Apps drive wiring; they do not bypass it.

The layering is total: every module the framework owns belongs to
exactly one layer, and its imports are constrained by the layer's
position in this diagram.

A module that opens a network listener or otherwise serves a protocol is
an app, regardless of which workspace directory it currently occupies.

Layer membership is determined by role, not by directory. The
operational state of the codebase may diverge from layer boundaries
during a refactor; the constitution describes the target.

Apps may carry their own thin wiring adapter, provided the shared
topology lives in `packages/wiring/` and the app adapter only adds
app-specific singletons.

An app belongs in this monorepo only if it is a first-party Ethos
surface. Third-party integrations live in their own repositories against
the published contracts.

------------------------------------------------------------------------

## III. Architectural Laws

Each law is a one-sentence rule with a one-sentence rationale. Laws are
binding and are enforced mechanically by §IX unless explicitly marked
prose-only.

### Law 1 — Contracts are pure
Modules in the contracts layer must not depend on any other internal
workspace package. External runtime dependencies are permitted only when
they author the schema language itself (zod, oRPC, Protobuf-TS).
*Rationale:* a contract that imports a sibling becomes structurally
bound to it; a contract that depends on a typed-DSL library is still a
contract.

### Law 2 — Core does not import concrete implementations
The core layer imports contracts only. It does not import an LLM
provider, a tool, a memory backend, a session store, a platform adapter,
a persistence backend, or any extension that implements an injection
seam. *Rationale:* the engine must be swappable independent of what is
plugged into it.

### Law 3 — Wiring is the only composition root
Only wiring modules import concrete extensions by name and assemble them.
*Rationale:* the system's runtime topology must exist in exactly one
place.

### Law 4 — Extensions implement contracts
An extension is a replaceable module that implements one or more
contracts. Extensions may depend on sibling extensions. The §IV patterns
are guidance for healthy sibling dependencies, not validator-enforced
categories. *Rationale:* requiring contract mediation for every
cross-extension call has higher cost than benefit when the boundary is
not a security boundary.

### Law 5 — Apps do not bypass wiring
An app imports wiring and contracts. An app does not import a concrete
extension directly. *Rationale:* a second composition root re-creates
the topology and breaks the substitution model.

### Law 6 — Personality is schema-bound
A personality's behaviour is fully determined by the fields of the
frozen personality schema. Code does not read personality identity from
prompt text, filename heuristics, or any unschematised source.
*Rationale:* personality is the framework's primary axis of variation;
if the schema does not express a capability, the framework does not
honour it.

### Law 7 — Storage abstraction guards the personality boundary
Modules that read or write user-authored files on a personality's behalf
use the Storage contract. All other filesystem access — internal state,
logs, pidfiles, journals, database-driver files, system paths,
build-time tooling — may use raw `node:fs`. *Rationale:* Storage exists
to make personality `fs_reach` enforceable; outside that boundary it
adds complexity without safety gain.

### Law 8 — Tool execution respects the personality toolset
The tool registry filters tool definitions presented to the model by
personality toolset and rejects calls outside the allowlist at execution
time. Rejected calls produce typed error results that maintain the
model's message contract. *Rationale:* a permissive registry undermines
the personality schema.

### Law 9 — Imports are extensionless internally
Internal relative imports omit the file extension. *Rationale:* the
codebase runs without a build step in development; extensionful imports
break that contract and force a build dependency on every contributor.

### Law 10 — Library code is silent
Library code outside designated app entry points uses the `Logger`
contract for all output. `console.*` is permitted only in app entry
modules and in build/test tooling. *Rationale:* silent libraries
compose; chatty libraries pollute every embedder.

### Law 11 — Kernel guarantees are not weakenable from outside
A module outside the security kernel must not be able to weaken a
guarantee the kernel enforces. *Rationale:* a guarantee an extension can
switch off was never a guarantee, and the failure is silent — which is
how a shipped control claim survived in the documentation after the code
stopped implementing it.

Like §V, this law has no exception path under §VIII: an exception to it
is, by definition, a module that can weaken a kernel guarantee.

------------------------------------------------------------------------

## IV. Extension Patterns

The patterns below are operational guidance — common shapes that
healthy sibling dependencies take. They are recommendations, not
validator-enforced categories. A new pattern does not require an
amendment; it is simply a new common shape.

**Pattern A — Wrapper.**
A tool-layer extension wraps a single service-layer extension to expose
its capability to the model. The wrapper has no behaviour beyond
translating between the service and the tool contract.

**Pattern B — Safety decoration.**
An extension that crosses a trust boundary depends on the safety
extension that polices that boundary. The dependency is structural: the
boundary cannot be optional or runtime-injectable.

**Pattern C — Content bundle.**
An extension that ships static content (skills, prompts, manifests)
depends on the loader extension that interprets that content. The
root-level `skills/` package (`@ethosagent/skills-library`) is the
bundled skill library, organized into category folders
(`software-development/`, `github/`, `framework/`).
`~/.ethos/skills/` is the user's own skill directory.

**Pattern D — Protocol bridge.**
An extension that adapts an external protocol depends on the contract
module for that protocol, not on any sibling implementation of the same
protocol.

### LLM Provider Authoring

A new LLM provider is a thin adapter that maps personality routing to a
transport function. A provider must not contain a streaming loop. If the
wire protocol is already supported by an existing transport, reuse it. If
it is not, extract a new transport first, then write the provider against
it.

**Decision tree — which transport to use:**

- Provider speaks the OpenAI Chat Completions wire format → use
  `streamChatCompletions` from `@ethosagent/llm-openai-compat`.
- Provider speaks the Anthropic Messages wire format → use
  `streamAnthropicMessages` from `@ethosagent/llm-anthropic`.
- Provider speaks the OpenAI Responses API (SSE) → use
  `streamResponsesApi` from `@ethosagent/llm-codex`.
- Provider speaks the AWS Bedrock Converse API → use
  `streamBedrockConverse` from `@ethosagent/llm-bedrock`.
- None of the above → write a new transport, then write the provider.

**Transport table:**

| Transport | Package | Wire protocol |
|---|---|---|
| `streamChatCompletions` | `@ethosagent/llm-openai-compat` | OpenAI Chat Completions |
| `streamAnthropicMessages` | `@ethosagent/llm-anthropic` | Anthropic Messages API |
| `streamResponsesApi` | `@ethosagent/llm-codex` | OpenAI Responses API (SSE) |
| `streamBedrockConverse` | `@ethosagent/llm-bedrock` | AWS Bedrock Converse API |

------------------------------------------------------------------------

## V. Safety Constitution

These rules are absolute. They have no exception path. They predate any
feature and outlive any release. Amendments to this section follow §VI
structural-class rules.

Safety primitives, whether they sit in the security kernel or at a core
enforcement point, follow the same bump procedure as the engine itself;
breaking changes require the unanimous maintainer agreement that core
changes require.

**S1 — Tool allowlist is authoritative.**
The personality toolset is the sole authority on which tools the model
may invoke. Enforcement happens at both definition time (the model sees
only allowed tools) and execution time (the registry rejects disallowed
calls). No code path circumvents the allowlist.

**S2 — Sandbox attestation is binding.**
A tool that executes untrusted code does so inside an attested sandbox.
The attestation declares confinement properties; the framework treats a
failed or absent attestation as untrusted and applies the strictest
classifier.

**S3 — Outbound deduplication is centralised.**
Outbound messages on every channel pass through a single deduplication
chokepoint keyed on session identity and message content. Channel
adapters do not implement their own deduplication. A duplicate is a
silent drop.

**S4 — Tool progress is internal by default.**
Progress events emitted by tools are framework-internal unless the tool
author explicitly opts an event into user visibility. The framework
never promotes an internal event to user visibility on a tool's behalf.

**S5 — Hooks enforce, they do not merely observe.**
A hook that asserts a precondition must prevent the gated action when
the precondition fails. Three execution models exist (parallel observer,
sequential modifier, sequential claimer). Preventing an action requires
the modifier or claimer model. Emitting an event without preventing the
action is a contract violation.

**S6 — Inbound text passes safety injection.**
Every inbound user message and every retrieved memory passes through the
safety injection pipeline before reaching the LLM. The pipeline is
reachable only through the safety seam injected into every agent loop;
no personality, channel, or tool may disable it, and no schema field may
exist whose effect is to disable it. A personality safety block may only
ever narrow what the framework already permits; a field that widens
policy is a violation of this rule, not a configuration of it.

**S7 — Boundary errors are user-facing.**
A boundary violation — storage scope, tool allowlist, sandbox
attestation, safety injection failure — surfaces as a typed error to
the operator. Silent failures are forbidden.

**S8 — Plugin contract compatibility is strict.**
A plugin declares the contract major version it was built against. The
loader rejects mismatches without overlap. *Rationale:* overlap
deprecation has, historically, become permanent compatibility.

**S9 — Secret values are stored exclusively in SecretsResolver.**
A secret value — API key, bearer token, OAuth token, password, or any
credential — must never be written to a config file, personality file,
MCP server config, export archive, or any storage path outside the
`SecretsResolver` interface. Config files may reference a secret by
name (for documentation or manifest purposes) but never by value.
`SecretsResolver` is the sole storage and retrieval path for all
credential material. No exception path exists for this rule.

------------------------------------------------------------------------

## VI. Change Governance

This document changes only by the procedure below.

### Amendment classes

| Class | Examples | Approvals | Validator update | Notes |
|---|---|---|---|---|
| Editorial | typo, wording, broken link | 1 maintainer | none | No semantic change. |
| Clarifying | rephrasing a law without changing its scope | 1 maintainer | none | Owner of the affected contract must sign off. |
| Substantive | adding a law, narrowing a law, adding or expiring an exception, adding an extension pattern | 2 maintainers | required, same PR | CHANGELOG entry naming the class. |
| Structural | adding/removing a layer, changing the runtime boundary, adding a new contract type, changing a frozen-schema ownership | unanimous maintainer agreement, RFC | required, same PR | Migration note for non-compliant code. |
| Constitutional | any change to §I (Immutable Principles) | re-issue under a new constitution version | required, same PR | The previous version remains authoritative for unmigrated code. |
| Schema | adding/removing/renaming a field on a frozen schema | per §VII bump procedure for that schema | required | Mandatory schema drift gate update. |

### Required artefacts for substantive or larger amendments

1. A PR modifying this document.
2. A matching update to §IX rules with passing tests.
3. A CHANGELOG entry naming the amendment class.
4. A migration document when an existing module becomes non-compliant.

### Forbidden modifications

A modification that makes a law unenforceable — by removing its
validator rule without removing the law, by softening the rule's
phrasing to permit the violation, or by adding an exception broader than
a single named module — is itself a constitutional violation and is
treated as a §IX failure.

------------------------------------------------------------------------

## VII. Frozen Schemas

A frozen schema is a contract whose surface is governed beyond ordinary
type changes. Every frozen schema has:

- A canonical contract module.
- A mechanical drift gate (a counter, a constant, or an enumeration test).
- A named owner.
- A bump procedure.

The personality schema is the worked example. [Personality governance](docs/content/building/explanation/personality-governance.md) explains how its freeze rule and the generated character sheet operationalise this section for `PersonalityConfig` — the personality-alignment phase removed four non-identity fields (`skin`, `busyInputMode`, `verbosity`, `metadata`) under exactly the procedure below. [AgentCard governance](docs/content/building/explanation/agent-card-governance.md) explains why the A2A signed card — a peer verifies it once, out of band, and trusts that anchor from then on — needed the same mechanical treatment (added in the a2a-spec-compat phase, D14).

### Roster

| Schema | Owner | Bump trigger | Drift gate kind |
|---|---|---|---|
| Personality schema | Any two repository maintainers | Adding, removing, or renaming a top-level field | Field-count file |
| Plugin contract | Plugin platform maintainers | Any breaking change to a field consumed by external plugin authors | Contract-major constant |
| LLM provider contract | LLM platform maintainers | A change to the streaming chunk union or the provider feature surface | Variant enumeration test |
| Hook execution model | Repository maintainers (unanimous) | Adding, removing, or renaming an execution model | Method-count test |
| Storage contract | Any two repository maintainers | A change to the error contract, the atomicity guarantees, or the boundary model | Method-shape test |
| Memory contract | Any two repository maintainers | Adding, removing, or renaming a method on `MemoryProvider` | Method-count test (`memory-method-count`) |
| Agent event union | Any two repository maintainers | Adding, removing, or renaming a variant | Variant enumeration test |
| Tool contract | Any two repository maintainers | A change that affects already-shipped tool packages | Shape test |
| Context engine contract | Any two repository maintainers | Adding, removing, or renaming a method on `ContextEngine` | Method-count test (`context-engine-method-count`) |
| Content-addressed store (ContentStore) | Any two repository maintainers | Adding, removing, or renaming a method on ContentStore | Method-count test |
| AgentCard (A2A signed card) | Any two repository maintainers | Adding, removing, or renaming a top-level field on `AgentCard` (`packages/types/src/a2a.ts`) | Field-count + field-name test (`agent-card-field-count`) |

Adding an **optional** method to `ContextEngine` is a §VI **Substantive** change:
it needs two-maintainer approval, the drift gate bumped in the same commit, and
a CHANGELOG entry naming the class. It does **not** bump
`PLUGIN_CONTRACT_MAJOR` — per `packages/plugin-contract/src/version.ts`, only a
field rename, a field removal, or a *required*-field addition does. Adding a
**required** method additionally breaks every engine registered out-of-tree via
`EthosPluginApi.registerContextEngine`, so it drags in the Plugin contract row
above and its contract-major bump.

### Bump obligations

Every schema bump requires, in the same commit:

1. The owner's approval per the schema's row.
2. The drift gate updated in lockstep.
3. A migration document or CHANGELOG entry stating the obligation on
   downstream code.
4. No-overlap deprecation: removed fields are removed in the same
   release as their replacement, unless the migration document
   explicitly authorises overlap and bounds it to a single release.

### Categories that may never become frozen-schema fields

These categories belong to skills, tools, memory, or per-channel adapter
configuration. They may not become top-level fields on the personality,
plugin, or provider schemas.

- Voice, speech synthesis, audio output configuration.
- Emotion, mood, sentiment tags.
- Per-channel display affordances or response templates.
- Anything that grants the model a capability the toolset does not
  already express.

------------------------------------------------------------------------

## VIII. Exception Policy

No law in §III, §V, or §VII is overridden by a permanent exception. An
exception is a temporary, named, time-bounded carve-out.

### Required fields on every exception

| Field | Meaning |
|---|---|
| `id` | A stable identifier referenced by validator output. |
| `law` | The article and number of the law being suspended. |
| `scope` | The smallest path, module, or symbol the exception covers. |
| `reason` | A one-sentence explanation, including the cost of not granting it. |
| `owner` | A named maintainer responsible for removal. |
| `created` | The date the exception was opened (ISO-8601). |
| `removal_condition` | The observable condition that closes the exception. |
| `review_by` | The date by which the exception is re-justified or removed. |

### Forbidden exception shapes

- Indefinite exceptions ("until further notice", "TBD").
- Exceptions without a named owner.
- Exceptions whose `removal_condition` is "best effort" or otherwise
  unobservable.
- Exceptions to §V Safety Constitution rules. Safety rules are amended
  through §VI or not at all.
- Exceptions to §III Law 11. An exception permitting a module outside
  the security kernel to weaken a kernel guarantee is the violation the
  law names.
- Exceptions broader than a single named scope. A pattern-wide
  exception is a law change, not an exception.

### Expiry

An exception whose `review_by` date has passed without a renewal PR is
treated as expired. The validator surfaces expired exceptions as
violations. There is no automatic renewal. There is no
permanent-grandfather list anywhere in this constitution.

### Where exceptions live

Active exceptions are tracked in the operational state sidecar referenced
from §IX, not in this document. The constitution defines the policy; the
sidecar holds the entries.

------------------------------------------------------------------------

## IX. Validator-Enforced Rules

The block below is the mechanically-checkable projection of this
constitution. It encodes the *structure* of enforcement, not the
*inventory* of current modules. Inventory (which package is at which
path, which sibling dependency matches which pattern, which exceptions
are currently active) lives in the operational state sidecar
(`.architecture-state.yaml` at the repo root) and is updated freely.

Where this section and the prose above conflict, the prose is
authoritative and the YAML is a bug to be fixed in the next amendment.

```yaml
# ARCHITECTURE-RULES v1
# Parser contract: a single YAML document inside the first ```yaml fence
# whose first non-blank line is `# ARCHITECTURE-RULES v1`.
# The validator reads this block plus `.architecture-state.yaml` and
# exits non-zero on any unmatched violation.

version: 1
state_sidecar: ".architecture-state.yaml"

# ---- Layers (§II) -----------------------------------------------------
# Order is significant. A layer may depend on any layer beneath it and
# on no layer above it. Paths and module identities live in the sidecar.

layers:
  - name: contracts
    role: "Interface definitions and value types. The floor."
    depends_on: []
    forbids:
      - internal_workspace_deps: all

  - name: security-kernel
    role: "Implementations of the §V-mandated safety primitives."
    depends_on: [contracts]
    forbids:
      - imports_outside_layer: [core, extensions, wiring, apps]
      - raw_filesystem_apis: true
      - direct_console_writes: true

  - name: core
    role: "Framework engine. Applies §V safety primitives through injected seams."
    depends_on: [contracts]
    # Core reaches the kernel only through contract types bound by wiring.
    type_only_deps: [security-kernel]
    forbids:
      - imports_outside_layer: [extensions, wiring, apps]
      - runtime_imports_of_layer: [security-kernel]
      - raw_filesystem_apis: true
      - direct_console_writes: true

  - name: extensions
    role: "Concrete implementations of contracts."
    depends_on: [contracts, security-kernel, core]
    sibling_dependencies: permitted
    forbids:
      - direct_console_writes: true
      - raw_filesystem_apis_outside_storage_contract: true

  - name: wiring
    role: "Composition root. Imports concrete extensions by name and binds the kernel."
    depends_on: [contracts, security-kernel, core, extensions]
    composition_root: true

  - name: apps
    role: "User-facing entry points. Drive wiring."
    depends_on: [contracts, wiring]
    forbids:
      - direct_extension_imports: true   # Law 5
    composition_root: "entry modules only"

# ---- Laws (§III) ------------------------------------------------------

laws:
  L1_contracts_pure:
    check: forbid_internal_workspace_deps
    scope: layer:contracts

  L2_core_no_concrete:
    check: imports_only_layers
    scope: layer:core
    allowed_layers: [contracts]

  L3_only_wiring_composes:
    check: imports_concrete_extensions
    allowed_in: [layer:wiring]
    forbidden_elsewhere: true

  L5_apps_through_wiring:
    check: imports_only_layers
    scope: layer:apps
    allowed_layers: [contracts, wiring]

  L7_storage_abstraction:
    check: forbid_raw_filesystem_on_personality_boundary
    scope: "layer:core | layer:extensions | layer:apps"
    contract: storage

  L8_toolset_enforcement:
    check: tool_registry_filters_by_personality_toolset
    enforcement_points: [definition_time, execution_time]
    on_rejection: typed_error_preserving_model_contract

  L9_extensionless_imports:
    check: forbid_internal_extensioned_imports
    scope: "*"

  L10_silent_libraries:
    check: forbid_console_writes
    scope: "*"
    allowed_in: layer:apps/entry
    contract: logger

  L11_kernel_guarantees_not_weakenable:
    check: forbid_external_weakening_of_kernel_guarantee
    scope: "* except layer:security-kernel"
    severity: error
    no_exception_path: true

# ---- Safety constitution (§V) ----------------------------------------
# These have no exception path. A violation here is a release blocker.

safety:
  S1_tool_allowlist:
    authority: personality.toolset
    enforcement: [definition_time, execution_time]
    bypass: forbidden

  S2_sandbox_attestation:
    failed_or_absent_attestation: treat_as_untrusted

  S3_outbound_dedup:
    chokepoint: single_gateway_module
    key: "(session_id, content_hash)"
    adapter_local_dedup: forbidden

  S4_progress_audience:
    default: internal
    promotion: per_event_by_tool_author_only
    framework_promotion: forbidden

  S5_hook_enforcement:
    precondition_hook_model: [modifier, claimer]
    observation_only_model: parallel_observer

  S6_inbound_safety_injection:
    pipeline_position: before_llm
    reachable_only_via: injected_safety_seam
    opt_out: forbidden
    personality_safety_fields: narrowing_only
    # Mechanical: no schema field disables the pipeline, so the rule is
    # enforced by the personality drift gate, not by review.
    enforcement: mechanical

  S7_boundary_errors_surface:
    typed_error: required
    silent_failure: forbidden

  S8_plugin_contract_strict:
    overlap_deprecation: forbidden

  S9_secrets_in_resolver_only:
    rule: "Secret values must never be written outside SecretsResolver"
    checks:
      - "No McpServerConfig.headers contains a literal Authorization token value"
      - "No personality config file or export archive contains a secret value"
      - "SecretsResolver is the only write path for credentials"
    severity: error
    no_exception_path: true

# ---- Frozen schemas (§VII) -------------------------------------------
# Identities listed here; contract module paths live in the sidecar.

frozen_schemas:
  personality:
    owner_class: any_two_maintainers
    drift_gate: counter_file
    forbidden_field_categories:
      - voice_speech_audio
      - emotion_mood_sentiment
      - per_channel_display
      - templates_labels
      - capabilities_outside_toolset
    # §VI amendment, voice V1a (eng-review D2): ONE field is carved out of
    # voice_speech_audio. `voice` carries identity — TTS voice id, language→voice
    # map, tier preference, fast-lane model — on the reasoning that a deployment
    # chooses the voice PROVIDER while the personality chooses how it SOUNDS,
    # the same way it chooses its model. Voice modes, VAD tuning and per-channel
    # speech affordances remain forbidden, and the exception is closed at both
    # ends: `personality-field-count.test.ts` fails if a second speech/audio
    # field appears.
    granted_field_exceptions:
      - field: voice
        category: voice_speech_audio
        rationale: identity_not_setting
        granted_by: voice_v1a_amendment

  plugin_contract:
    owner_class: plugin_platform_maintainers
    drift_gate: contract_major_constant
    overlap_deprecation: forbidden

  llm_provider:
    owner_class: llm_platform_maintainers
    drift_gate: variant_enumeration_test

  hook_models:
    owner_class: maintainers_unanimous
    drift_gate: method_count_test

  storage:
    owner_class: any_two_maintainers
    drift_gate: method_shape_test

  agent_event:
    owner_class: any_two_maintainers
    drift_gate: variant_enumeration_test

  tool_contract:
    owner_class: any_two_maintainers
    drift_gate: shape_test

  memory_contract:
    owner_class: any_two_maintainers
    drift_gate: method_count_test
    frozen_method_count: 5
    frozen_methods: [prefetch, read, search, sync, list]

  context_engine:
    owner_class: any_two_maintainers
    drift_gate: method_count_test
    frozen_method_count: 3
    frozen_methods: [compact, shouldCompact, onTurnComplete]
    optional_method_addition: substantive
    required_method_addition: substantive_plus_plugin_contract_major

  content_store:
    owner_class: any_two_maintainers
    drift_gate: method_count_test
    frozen_method_count: 4
    frozen_methods: [put, get, has, hash]

# ---- Exception policy (§VIII) ----------------------------------------
# Active exceptions live in the sidecar, not here. This block defines
# the shape every entry must take and the validator's failure modes.

exception_policy:
  required_fields: [id, law, scope, reason, owner, created, removal_condition, review_by]
  forbidden_shapes:
    - indefinite_term
    - missing_owner
    - unobservable_removal_condition
    - safety_constitution_carve_out
    - kernel_guarantee_carve_out
    - pattern_wide_scope
  expiry:
    on_review_by_passed: surface_as_violation
    automatic_renewal: false
  source: state_sidecar
```

------------------------------------------------------------------------

## Companion documents

This document is the constitution. The following documents complement it
and may be edited freely; they are not constitutional.

- [AGENTS.md](./AGENTS.md) / [CLAUDE.md](./CLAUDE.md) — working manual:
  conventions, gotchas, runtime quirks, and the "how to use this
  codebase" reference.
- [CONTRIBUTING.md](./CONTRIBUTING.md) — process: PR conventions,
  schema-bump workflows, doc-sync rule.
- [DESIGN.md](./DESIGN.md) — visual and UX design system.
- [.agents/skills/docs/SKILL.md](./.agents/skills/docs/SKILL.md) — documentation information architecture (the `/docs` skill).
- `.architecture-state.yaml` — the operational sidecar referenced from
  §IX: current layer paths, sibling-pattern instances, active exceptions.
  Updated freely as the codebase evolves; never the authority on what is
  allowed, only on what currently exists.

If a question has no answer in this document, the answer is: the
constitution is silent, and the working manual or the codebase decides.
The constitution speaks only on the matters it speaks on.
