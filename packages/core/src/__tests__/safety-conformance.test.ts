import type { AgentSafety, Storage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { runAgentSafetyConformance } from '../safety-conformance';
import { createTestSafety } from './helpers/test-safety';

// ---------------------------------------------------------------------------
// G2 — the point of this file.
//
// A conformance suite that only ever passes is decoration. The load-bearing
// test is `noOpSafety` FAILING: that bundle satisfies `AgentSafety` in every
// structural respect (every method present, every return type correct) and
// defends nothing. If the suite ever green-lights it, the suite is worthless
// and the `safety: AgentSafety` field is back to being a receipt that a value
// was passed.
// ---------------------------------------------------------------------------

/** The exact shape the G2 gap describes: types satisfied, policy absent. */
function noOpSafety(): AgentSafety {
  return {
    injection: {
      prelude: '',
      downgradeRejectionMessage: '',
      sanitize: (s) => s,
      wrapUntrusted: ({ content }) => ({ content, strippedTokens: 0 }),
      shortPatternCheck: () => ({ containsInstructions: false, hits: [] }),
      c2PatternCheck: () => ({ containsInstructions: false }),
      resolveDowngradedTools: () => new Set<string>(),
    },
    redaction: {
      redactPii: (t) => t,
      redactString: (t) => t,
      detectSecrets: () => [],
    },
    scopedStorageFactory: (base) => base,
    approvalPosture: { kind: 'ungated', reason: 'no-op fixture' },
  };
}

function failuresMatching(failures: string[], prefix: string): string[] {
  return failures.filter((f) => f.startsWith(prefix));
}

describe('runAgentSafetyConformance', () => {
  it('fails the no-op bundle, naming every absent defense', async () => {
    const result = await runAgentSafetyConformance(noOpSafety());

    expect(result.passed).toBe(false);

    // Each named failure corresponds to one control the no-op removed.
    expect(failuresMatching(result.failures, 'injection.prelude')).toHaveLength(1);
    expect(failuresMatching(result.failures, 'injection.sanitize')).toHaveLength(1);
    expect(failuresMatching(result.failures, 'injection.wrapUntrusted').length).toBeGreaterThan(1);
    expect(failuresMatching(result.failures, 'injection.shortPatternCheck')).toHaveLength(1);
    expect(failuresMatching(result.failures, 'redaction.redactString')).toHaveLength(1);
    expect(failuresMatching(result.failures, 'redaction.detectSecrets')).toHaveLength(1);
    expect(failuresMatching(result.failures, 'scopedStorageFactory')).toHaveLength(1);

    // And the messages say what was expected, not just "failed".
    expect(result.failures.join('\n')).toContain('chat-template token');
    expect(result.failures.join('\n')).toContain('adversarial line');
    expect(result.failures.join('\n')).toContain('outside its allowlist');
  });

  it('passes a bundle assembled from the real safety kit', async () => {
    const result = await runAgentSafetyConformance(createTestSafety());
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  // One sabotage per control, each starting from the REAL kit. This is what
  // proves the suite is checking that specific control rather than tripping on
  // some unrelated property of the no-op bundle above.
  it('catches a sanitize that leaves chat-template tokens intact', async () => {
    const result = await runAgentSafetyConformance(
      createTestSafety({ injection: { sanitize: (s) => s } }),
    );
    expect(result.passed).toBe(false);
    expect(failuresMatching(result.failures, 'injection.sanitize')).toHaveLength(1);
  });

  it('catches a wrapUntrusted that drops the provenance fence', async () => {
    const result = await runAgentSafetyConformance(
      createTestSafety({
        injection: { wrapUntrusted: ({ content }) => ({ content, strippedTokens: 0 }) },
      }),
    );
    expect(result.passed).toBe(false);
    expect(failuresMatching(result.failures, 'injection.wrapUntrusted').length).toBeGreaterThan(0);
  });

  it('catches a wrapUntrusted that fences but discards the content', async () => {
    const result = await runAgentSafetyConformance(
      createTestSafety({
        injection: {
          wrapUntrusted: ({ toolName }) => ({
            content: `<untrusted tool="${toolName}"></untrusted>`,
            strippedTokens: 0,
          }),
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('does not preserve the original content');
  });

  it('catches a pattern check that never fires', async () => {
    const result = await runAgentSafetyConformance(
      createTestSafety({
        injection: { shortPatternCheck: () => ({ containsInstructions: false, hits: [] }) },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('did not flag a known injection string');
  });

  it('catches a pattern check that always fires', async () => {
    const result = await runAgentSafetyConformance(
      createTestSafety({
        injection: {
          shortPatternCheck: () => ({ containsInstructions: true, hits: [{ rule: 'always' }] }),
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('flagged benign prose');
  });

  it('catches redaction that passes a known credential through', async () => {
    const result = await runAgentSafetyConformance(
      createTestSafety({ redaction: { redactString: (t) => t, detectSecrets: () => [] } }),
    );
    expect(result.passed).toBe(false);
    expect(failuresMatching(result.failures, 'redaction.redactString')).toHaveLength(1);
    expect(failuresMatching(result.failures, 'redaction.detectSecrets')).toHaveLength(1);
  });

  it('catches a scopedStorageFactory that ignores its scope', async () => {
    const result = await runAgentSafetyConformance(
      createTestSafety({ scopedStorageFactory: (base: Storage) => base }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('the scope is not enforced');
  });

  it('catches a scopedStorageFactory that denies everything', async () => {
    const result = await runAgentSafetyConformance(
      createTestSafety({
        scopedStorageFactory: () =>
          new Proxy({} as Storage, {
            get: () => () => {
              throw new Error('denied');
            },
          }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('INSIDE its allowlist');
  });
});
