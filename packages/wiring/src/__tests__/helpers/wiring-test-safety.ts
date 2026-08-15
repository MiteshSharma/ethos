// The `AgentSafety` bundle a wiring test drives a real `AgentLoop` with.
//
// Same shape `build-agent-loop.ts` assembles, minus the classifier and the
// watcher: those need live config, and a test that needs them wires its own.
// The point of building the REAL bundle rather than a stub is that the loop
// under test then runs the real injection prelude and the real scoped storage,
// so a test asserting what reached the model is asserting about the prompt a
// deployment would actually send.

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

export function createTestSafety(): AgentSafety {
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
    redaction: { redactPii, redactString, detectSecrets },
    scopedStorageFactory: (base, scope) =>
      new ScopedStorage(base, { ...scope, alwaysDeny: defaultAlwaysDeny() }),
    // A test fixture genuinely has no approval flow. Declaring it is the point:
    // `ungated` is honest, an omitted field would be a silent default.
    approvalPosture: { kind: 'ungated', reason: 'test fixture — no approval policy is registered' },
  };
}
