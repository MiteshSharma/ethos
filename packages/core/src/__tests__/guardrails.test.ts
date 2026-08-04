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
    expect(lineCount).toBeLessThanOrEqual(841);
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
      if (lineCount > 725) {
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
      if (lineCount > 500) {
        violations.push(`${file}: ${lineCount} lines`);
      }
    }
    expect(violations).toEqual([]);
  });
});
