import { runAgentSafetyConformance } from '@ethosagent/core';
import {
  c2PatternCheck,
  DOWNGRADE_REJECTION_MESSAGE,
  INJECTION_DEFENSE_PRELUDE,
  INJECTION_DEFENSE_PRELUDE_COMPACT,
  resolveDowngradedTools,
  sanitize,
  shortPatternCheck,
  wrapUntrusted,
} from '@ethosagent/safety-injection';
import { detectSecrets, redactPii, redactString } from '@ethosagent/safety-redact';
import { defaultAlwaysDeny, ScopedStorage } from '@ethosagent/storage-fs';
import type { AgentSafety } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// G2, wiring half — the shipped bundle must pass the conformance suite.
//
// This test lives in `packages/wiring/` rather than `packages/core/` because
// core imports contracts only (Law 2) and must not reach for wiring.
//
// The bundle is assembled here from direct `@ethosagent/safety-*` imports
// rather than by calling `buildAgentLoop`, which is legal in wiring (Law 3)
// and is the only practical option: `buildAgentLoop` is a full composition
// root — it opens SQLite stores, constructs an LLM provider, loads plugins,
// and reads `~/.ethos/`. It builds its `AgentSafety` from exactly the symbols
// imported below (`build-agent-loop.ts`, "Build the AgentSafety bundle"), so
// this is the same kit reaching core, minus the LLM classifier, which is
// optional on `InjectionDefenseKit` and has no conformance assertion.
//
// Known limit, stated rather than papered over: this is a REPLICA of the
// shipped bundle, not the bundle itself. Swap a symbol in
// `build-agent-loop.ts` for a weaker one and this test still passes. Closing
// that would mean extracting the bundle assembly out of `buildAgentLoop` into
// a pure factory both this test and the composition root call — worth doing,
// and out of scope here. Until then: keep the two lists in step.
// ---------------------------------------------------------------------------

function buildShippedSafety(): AgentSafety {
  return {
    injection: {
      prelude: INJECTION_DEFENSE_PRELUDE,
      preludeCompact: INJECTION_DEFENSE_PRELUDE_COMPACT,
      downgradeRejectionMessage: DOWNGRADE_REJECTION_MESSAGE,
      sanitize,
      wrapUntrusted,
      shortPatternCheck,
      c2PatternCheck,
      resolveDowngradedTools,
    },
    redaction: {
      redactPii,
      redactString,
      detectSecrets,
    },
    scopedStorageFactory: (base, scope) =>
      new ScopedStorage(base, { ...scope, alwaysDeny: defaultAlwaysDeny() }),
    approvalPosture: { kind: 'gated', policy: 'danger-predicate' },
  };
}

describe('shipped AgentSafety bundle', () => {
  it('passes the core conformance suite', async () => {
    const result = await runAgentSafetyConformance(buildShippedSafety());
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('declares a gated approval posture', () => {
    expect(buildShippedSafety().approvalPosture).toEqual({
      kind: 'gated',
      policy: 'danger-predicate',
    });
  });
});
