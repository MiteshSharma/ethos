export interface InjectionVerdict {
  containsInstructions: boolean;
  confidence: number;
  reason?: string;
  source: 'llm' | 'pattern-fallback';
}

export type InjectionClassifier = (input: { content: string }) => Promise<InjectionVerdict>;

export interface InjectionDefenseKit {
  prelude: string;
  /** §2 — shorter prelude variant used when a model's `promptBudget.compactPrelude`
   *  is set. Optional; context assembly falls back to `prelude` when absent. */
  preludeCompact?: string;
  downgradeRejectionMessage: string;
  sanitize(content: string): string;
  wrapUntrusted(input: { content: string; toolName: string; source?: string }): {
    content: string;
    strippedTokens: number;
  };
  shortPatternCheck(content: string): {
    containsInstructions: boolean;
    hits: Array<{ rule: string }>;
  };
  c2PatternCheck(content: string): { containsInstructions: boolean };
  resolveDowngradedTools(names?: string[] | 'auto'): Set<string>;
  classifier?: InjectionClassifier;
}

export interface RedactionKit {
  redactPii(text: string, extraPatterns?: string[]): string;
  redactString(text: string): string;
  detectSecrets(text: string): Array<{ label: string }>;
}

export type ScopedStorageFactory = (
  base: import('./storage').Storage,
  scope: { read: string[]; write: string[] },
) => import('./storage').Storage;

export type WatcherDecision =
  | { action: 'allow' }
  | { action: 'pause' | 'force_approval' | 'terminate'; rule: string; reason: string };

export interface WatcherEvent {
  type: string;
  toolName?: string;
  ok?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  args?: unknown;
}

export interface AgentWatcher {
  observe(event: WatcherEvent): WatcherDecision;
  resetTurn(): void;
}

/**
 * G4 — the composition root's declaration of whether tool calls are gated by an
 * approval policy. Core owns the enforcement *point* (the `before_tool_call`
 * modifying hook) but cannot see whether a policy was registered behind it, and
 * an embedder that registers nothing gets a fully working loop with no gating
 * and no signal. The posture is declared rather than inferred: `gated` is a
 * claim core verifies, `ungated` is an explicit, logged opt-out.
 */
export type ApprovalPosture =
  | { kind: 'gated'; policy: string }
  | { kind: 'ungated'; reason: string };

/**
 * Thrown when a loop declares `approvalPosture: { kind: 'gated' }` but no
 * `before_tool_call` modifying handler is registered by the time the first tool
 * call is dispatched. This is a wiring bug, not a user error — the declared
 * policy has no enforcement behind it. Per ARCHITECTURE.md §V S7 a boundary
 * violation surfaces as a typed error to the operator rather than failing
 * silently.
 */
export class ApprovalPostureError extends Error {
  readonly code = 'approval-posture' as const;
  readonly policy: string;

  constructor(policy: string) {
    super(
      `approval posture declared "gated" (policy: ${policy}) but no before_tool_call handler is registered — the declared policy has no enforcement behind it`,
    );
    this.name = 'ApprovalPostureError';
    this.policy = policy;
  }
}

export interface AgentSafety {
  injection: InjectionDefenseKit;
  redaction: RedactionKit;
  scopedStorageFactory: ScopedStorageFactory;
  /**
   * Required — see `ApprovalPosture`. Not optional by design: an optional field
   * defaults silently, which is the exact gap this declaration closes.
   */
  approvalPosture: ApprovalPosture;
  watcher?: AgentWatcher;
}

/**
 * The row identities of the published guarantee register
 * (`docs/content/security/security-boundary.md`), in register order.
 *
 * WHY HERE. The register's *prose* lives in the doc and its *citations* live in
 * `.architecture-state.yaml` (`register_anchors`), which the architecture
 * validator already ties to the doc in both directions. Neither is importable
 * by code, so a surface that reports per-personality register status — the
 * character sheet — needs the identities in TypeScript. `@ethosagent/types` is
 * the only package every layer may import, and the register is a contract about
 * the boundary, which is what this package holds.
 *
 * WHY IT IS NOT A SECOND COPY. This list carries identities ONLY — no claims,
 * no enforcement points, no prose. `guarantee-register-ids.test.ts` asserts it
 * equals the `register_anchors` keys in `.architecture-state.yaml`, so
 * doc ↔ sidecar ↔ code is one validated chain rather than three lists that
 * agree today. Adding or withdrawing a guarantee fails that test until this
 * list is updated in the same commit — the same discipline as
 * `.personality-field-count`.
 */
export const GUARANTEE_IDS = [
  'G-TOOLS',
  'G-CAP',
  'G-FS',
  'G-NET',
  'G-INJ',
  'G-SEC',
  'G-RED',
  'G-APP',
  'G-EXEC',
  'G-WATCH',
  'G-CHAN',
  'G-AUDIT',
] as const;

/** One published guarantee's id. See {@link GUARANTEE_IDS}. */
export type GuaranteeId = (typeof GUARANTEE_IDS)[number];
