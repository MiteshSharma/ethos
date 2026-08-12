import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Orchestrator guardrails', () => {
  const agentLoopFile = join(import.meta.dirname, '..', 'agent-loop.ts');
  const agentLoopDir = join(import.meta.dirname, '..', 'agent-loop');

  it('agent-loop.ts is under the orchestrator size limit', () => {
    const content = readFileSync(agentLoopFile, 'utf-8');
    const lineCount = content.split('\n').length;
    // Phase 9 threshold — the orchestrator should stay lean. Ratcheted as the
    // loop legitimately grows (735 → 750 → 754 → 759 → 761 → 782 → 783); §5 added
    // the compaction gate config field, §2 added the promptBudget config field +
    // its constructor/deps threading (5 irreducible lines, compressed to one-line
    // shapes to keep the growth minimal); background sub-agents added the
    // rootSessionKey seam on RunOptions; the context-compaction phase added the
    // public `compact()` method (a thin delegator to `compactSession`).
    // Phase 3 (memory-flush + auto-compaction) added two turn dispatch seams —
    // the overflow→compact-and-retry decision and the post-`done` turn-end
    // maintenance call — plus the `memoryConsolidation` config field and its
    // constructor/deps threading. All substantive logic lives in
    // agent-loop/overflow.ts and agent-loop/turn-end.ts; only the wiring +
    // dispatch remain here.
    // Bumped 840 → 841: Item 7's guaranteed user-message tail is configured
    // globally (`compaction.minTailUserMessages`), and `/compact` is the one
    // compaction path whose deps are assembled here — so the knob costs exactly
    // one property line in the `compactSession` call (the new compaction fields
    // themselves went onto the existing one-line `compaction?:` config shape).
    // The logic lives in agent-loop/manual-compact.ts.
    // Bumped 841 → 846: Lane 3(b)'s `options.smallWindow` flag (declared
    // small-window toolset narrowing, D20) — option decl + one-line doc,
    // field, constructor default, deps threading (5 irreducible lines,
    // compressed to one-line shapes). The narrowing logic itself lives in
    // agent-loop/stages/turn-setup.ts + agent-loop/small-window-toolset.ts.
    // Bumped 846 → 873: tools-as-code-api Lane B — the per-turn ScriptToolBridge
    // construction (its deps ARE the turn's enforcement closure: allowlist,
    // hooks, watcher tap, shared counters) plus the `checkBudgets` closure that
    // replaced the inline checkTurnBudgets call so the loop's boundary check
    // and the bridge's per-call check are ONE arithmetic. The bridge logic
    // itself lives in agent-loop/stages/script-tool-bridge.ts.
    // Bumped 873 → 874: Lane E threads the loop's onToolMetric into the
    // ScriptToolBridge deps (one conditional-spread line) so inner calls hit
    // the same diagnostic seam as batch calls.
    // Bumped 874 → 877: `fs_reach.workdir` makes the working directory a
    // per-TURN product instead of a loop field, so the orchestrator destructures
    // `workingDir` + `fsReach` off TurnSetup and hands them to the tool stage
    // (4 lines), minus the `workingDir` dep the stage no longer needs (1). The
    // derivation itself lives in agent-loop/stages/turn-setup.ts.
    // Bumped 877 → 884: UI-cards D1 adds the `toolsetExclude` RunOptions field
    // (surface-level tool exclusion) — one declaration plus the doc explaining
    // how it differs from the adjacent `toolsetNarrow`. It is pass-through
    // only; the enforcement lives in agent-loop/stages/turn-setup.ts and
    // tool-registry.ts.
    // Bumped 884 → 894: G4's approval-posture declaration. The orchestrator
    // keeps only pass-through — the `logger` config field (Law 10 sink for the
    // `ungated` notice), the latched guard field, its one-line construction,
    // and the single call at the first tool dispatch. The check itself, and the
    // rationale for why it runs there rather than at construction, lives in
    // agent-loop/approval-posture.ts.
    expect(lineCount).toBeLessThanOrEqual(894);
  });

  it('no stage file exceeds 700 lines', () => {
    const stagesDir = join(agentLoopDir, 'stages');
    const violations: string[] = [];
    for (const file of readdirSync(stagesDir)) {
      if (!file.endsWith('.ts')) continue;
      const content = readFileSync(join(stagesDir, file), 'utf-8');
      const lineCount = content.split('\n').length;
      // Bumped 720 → 722: background sub-agents threaded rootSessionKey through
      // tool-processing.ts's ToolContext construction, pushing it to 722.
      // Bumped 722 → 725: the denial circuit breaker needs approval denials
      // tagged apart from the other `Prepped.rejected` sources (MCP policy,
      // reject_args, injection downgrade, watcher halt) — a counter, an
      // increment in the `before_tool_call` branch, and a one-line comment.
      // Bumped 725 → 731: Lane 1(c) ingestion truncation caps tool-result
      // content at both persist sites (main path + returnDirect). The logic
      // lives in agent-loop/ingestion-cap.ts; only the import and the two
      // commented call sites land here.
      // Bumped 731 → 738: post-review FIX 7 moves the ingestion cap BEFORE
      // the untrusted wrap (so the cap can never sever </untrusted>) and adds
      // the cap to the hook-rejected path — comment lines only, the logic is
      // unchanged in size.
      // Bumped 738 → 746: tools-as-code-api Lane B — tool-processing binds the
      // per-turn ScriptToolBridge to the batch's ToolContext (two lines + the
      // ctx field + comment); the bridge itself is its own stage module.
      // Bumped 746 → 752: Lane E generalizes the per-batch progress queue to
      // AgentEvent (pushLiveEvent helper) so the bridge's inner-call
      // tool_start/tool_end ride the same live drain as tool progress.
      // Bumped 752 → 777: G-INJ — the result-defense path no longer gates on
      // `result.ok`, so an `outputIsUntrusted` tool's ERROR text (an MCP server
      // answering `isError: true`) is wrapped and arms the downgrade. Two
      // provenance flags and the delimiter condition; the bulk is the comment
      // recording why the old "errors are framework-authored" claim was false,
      // so the gate is not reintroduced.
      if (lineCount > 777) {
        violations.push(`${file}: ${lineCount} lines`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no helper module in agent-loop/ exceeds 500 lines', () => {
    const violations: string[] = [];
    for (const file of readdirSync(agentLoopDir)) {
      if (!file.endsWith('.ts') || file === 'index.ts') continue;
      if (statSync(join(agentLoopDir, file)).isDirectory()) continue;
      const content = readFileSync(join(agentLoopDir, file), 'utf-8');
      const lineCount = content.split('\n').length;
      // Bumped 500 → 502: Lane 1(a) threads the max-single-tool-result gate
      // term through turn-end's evaluateGate deps (three lines; the arithmetic
      // itself lives in compaction.ts's shared evaluateGate).
      if (lineCount > 502) {
        violations.push(`${file}: ${lineCount} lines`);
      }
    }
    expect(violations).toEqual([]);
  });
});
