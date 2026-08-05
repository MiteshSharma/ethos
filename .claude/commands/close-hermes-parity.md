---
description: Close the seven items in plan/phases/hermes-0.20-parity.md, verify-first, multi-lane, one iteration per invocation
---

Create a new worktree at /Users/mitesh/personal/sandbox/worktree path and create a branch and do changes there. 

# Close Hermes 0.20 parity

You are closing out `plan/phases/hermes-0.20-parity.md` — seven items (1, 2, 5, 7, 9, 10, 11) across two lanes. This command is written to run under `/loop`: **one invocation does one useful unit of work and then stops.** State lives on disk, not in your context, so a fresh iteration can pick up exactly where the last one left off.

The plan document is the specification. It is **not** trusted source-of-truth about the codebase — see "Verify everything" below. It has already been wrong once (it claimed `ContextEngine` was a frozen schema; it is not).

## The ledger

`plan/phases/hermes-0.20-parity-progress.md` is the single source of truth for what is done. `plan/` is gitignored, so this file never enters a commit.

If it does not exist, create it on the first iteration with one row per item, all `not-started`:

```markdown
| Item | Title | Status | Worktree | Last gate | Notes |
|---|---|---|---|---|---|
| 11 | grounded-citations skill | not-started | — | — | |
| 5 | iteration cap | not-started | — | — | |
| 1 | tool self-recovery | not-started | — | — | |
| 2 | smart approvals | not-started | — | — | |
| 7 | context economy | not-started | — | — | |
| 9 | delivery ledger | not-started | — | — | |
| 10 | subagent transcripts | not-started | — | — | |
```

Statuses: `not-started` → `anchors-verified` → `in-progress` → `gate-passed` → `merged` → `done`. Plus `blocked` (needs a human) and `descoped` (the plan was wrong and the item no longer makes sense — requires a note explaining why).

Append a dated line to a `## Log` section at the bottom of the ledger every iteration. Keep it to one or two lines: what you did, what the gate said.

## Each iteration

1. **Read the ledger first.** Then read the plan doc section for whatever you are about to touch. Do not re-read the whole plan every iteration.
2. **If every item is `done`** — run the full gate one final time on the integration branch, write the completion summary (below), and call `ScheduleWakeup` with `stop: true`. The loop is over. Do not invent follow-on work.
3. **Otherwise pick the next work.** Respect the dependency graph in the plan's "Build order" section. The hard ones:
   - **Item 9 must be `merged` before item 10 starts.** Not negotiable — 10's restore-and-deliver needs 9's ownership-checked durability, and doing it backwards means writing a weaker second durability path and deleting it.
   - Item 2's sync→async conversion of `SmartApprovalCallback` and its callsites is a **separate, earlier commit** than the reviewer itself. Do not interleave them.
   - Item 7 stage 1 (thresholds, tail guarantee, pruning) needs no contract change and may proceed. **Item 7 stage 2 is blocked on a human** — see "Hard stops".
   - Items 11, 5, 1 have no blockers and may start immediately.

## Lanes

**One item at a time, end to end.** Owner's instruction: take a single item from `anchors-verified` all the way through `merged` before starting the next one. Do not open a second implementation lane while one is in flight, even when the `Primary touches` look disjoint — a clean sequential history is worth more here than wall-clock.

Order: **11 → 5 → 1 → 2 → 7 (stage 1) → 9 → 10.** That front-loads the two cheap items so the loop proves itself on small work, and it keeps the hard dependency (9 before 10) intact.

Parallelism is allowed *within* an item — verification agents, test-writing, and review can fan out freely. It is the implementation lanes that stay serial.

Every lane works in its own worktree under `/Users/mitesh/personal/sandbox/worktree/<slug>`, created explicitly:

```bash
git -C /Users/mitesh/personal/sandbox/ethos branch <slug> <integration-branch>
git -C /Users/mitesh/personal/sandbox/ethos worktree add /Users/mitesh/personal/sandbox/worktree/<slug> <slug>
```

Use `hermes-item-<N>-<short-name>` as the slug. Do **not** use the Agent tool's `isolation: "worktree"` — it picks its own throwaway path and you would lose track of where the work is. Create the worktree yourself, then name the absolute path in the sub-agent's brief so it edits in the right place. Record the path in the ledger's `Worktree` column.

Per CLAUDE.md rule 11, **the main session does not edit files** — it briefs, reviews, and reports. A fresh worktree needs its own install: run `make prepare` in it before the first gate.

When a lane's gate passes, merge its branch back into the integration branch, re-run the gate on the merged result (a green lane and a green merge are different facts), then mark the item `merged`.

## Verify everything

This is the part the owner cares most about. Two distinct verification passes, both mandatory.

### Pass 1 — before writing any code for an item

**Point the verifier at the integration worktree** (`/Users/mitesh/personal/sandbox/worktree/hermes-parity-integration`), NOT the main checkout at `/Users/mitesh/personal/sandbox/ethos`. The main checkout is still on the pre-parity branch, so a verifier reading it will confidently report that already-merged work does not exist. This has happened once; do not repeat it.

Dispatch a **read-only** verification sub-agent for that item alone. It must:

- Re-check **every** `file:line` anchor in that item's plan section against the current source. Line numbers drift; the plan was written on 2026-08-05.
- Re-check every factual claim — defaults, method counts, "X does not exist", "Y has no handling for Z". Grep for it. Read it. Do not accept a claim because the plan asserts it confidently.
- Report each anchor as `confirmed` / `moved (new location)` / `wrong (what is actually true)`.

If anything comes back `wrong`: **fix the plan document first**, in the main session's next brief, and re-scope the item against reality. Never implement against a premise you just disproved. If the correction removes the item's reason to exist, mark it `descoped` with a note and move on — that is a successful outcome, not a failure.

Only after this pass may the item move to `anchors-verified`.

### Pass 2 — after the code is written

Do not take a sub-agent's word that it works. Sub-agent reports in this repo have hallucinated both bugs and fixes.

- **Read the actual diff.** `git diff` on the lane branch. Every changed line should trace to the item's "Proposed change".
- **Run the gate yourself in the main session**: `pnpm typecheck && pnpm lint && pnpm test`. Never report a gate result from memory or from a sub-agent's summary.
- **Confirm the tests are real.** Each item's plan section has acceptance criteria. For each one, there must be a test that **fails without the change and passes with it** — have the lane demonstrate this, or check out the parent commit and run the new test yourself. A test that passes both ways proves nothing.
- **Smoke it where a human would notice.** Item 1 is about tool ergonomics — actually drive `edit_file` against a mismatched string and read the error. Item 5 is about long runs — confirm the budget halt fires where the plan says it should. A passing unit test is not the same as the feature working.
- Run the `dependency-analyzer` skill if the item added any cross-package import, and `schema-validator` if it touched `packages/types/`.

Only after this pass may the item move to `gate-passed`.

## Hard stops — surface to the user, do not decide these yourself

- **Item 7 stage 2** adds a method to `ContextEngine` and puts it on the ARCHITECTURE.md §VII roster. That is a governance decision (§VI Substantive: two maintainers, one PR, CHANGELOG entry naming the class). Implement stage 1, mark stage 2 `blocked`, and say so in the report. **Do not amend ARCHITECTURE.md on your own authority.**
- Any change that would add a top-level `PersonalityConfig` field. The plan says `.personality-field-count` stays at **27** through all seven items. If an item seems to need field 28, the design is wrong — stop and ask.
- Any new `AgentEvent` variant. Item 2's circuit breaker reuses the existing `halt` event.
- Anything the plan lists under "What is deliberately not in this plan." Those were considered and dropped. Re-litigating them is scope creep, not initiative.
- **Git**: cut one integration branch off the current branch and give it its own worktree under `/Users/mitesh/personal/sandbox/worktree/` too — lane branches merge into it, and the main checkout at `/Users/mitesh/personal/sandbox/ethos` stays untouched. Never commit to `main`. Never push. Never `reset --hard`, `branch -D`, `checkout --`, `clean -f`, or `stash` on tracked work — **this includes proving a test fails on the parent commit.** To demonstrate a parent failure, edit the source in place and edit it back, or assert against a directly-called helper. One lane used `git checkout --` on 11 files for exactly this; it was recoverable only because the commit already existed. Do not remove another worktree to reclaim space — several existing ones are marked prunable but they are not yours to delete. Commit messages get the `Co-Authored-By: Ethos <agent@ethosagent.ai>` trailer.

## Failure handling

If an item's gate fails twice in consecutive iterations, mark it `blocked` with the failing output quoted in the ledger, and move to the next eligible item. Do not spend a third iteration on the same wall — surface it and keep the other lanes moving. A loop that thrashes on one item while six others sit idle is worse than one that reports a blocker.

## Repo rules that bite here

- Extensionless imports (`./foo`, never `./foo.ts`).
- No `console.*` in library code — CLI only (`apps/ethos/src/`).
- Layer direction is `apps → wiring → {core, extensions} → contracts`. Core may not import extensions.
- Tool progress defaults to `audience: 'internal'`; channel adapters must not surface it. Item 10 must respect this — child transcripts are not user-facing chatter.
- **Do not invoke `openai-reviewer` / Codex review in this repo.** The gate is `pnpm typecheck && pnpm lint && pnpm test`.

## Completion summary

When all items are `done`, write `plan/phases/hermes-0.20-parity-outcome.md`: what shipped, what was descoped and why, what is still `blocked` and on whom, every plan anchor that turned out wrong, and the final gate output verbatim. Then update the plan doc's `**Status:**` line from `proposed` to reflect reality.

Report to the user in chat: items closed, items blocked, and anything you found that contradicts the plan. Be plain about what did not get done.

IMP: Review whole code or verify if everything is completed end to end. No need to wait for me for an input. keep taking decisions as needed. 
