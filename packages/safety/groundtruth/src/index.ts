/**
 * `@ethosagent/safety-groundtruth` — does what the agent SAID match what its
 * tools DID? (plan/phases/ground-truth-verification.md)
 *
 * Three pieces, in the order the data moves:
 *   1. `createEvidenceCollector` — an `after_tool_call` handler filling a
 *      per-turn `LedgerStore` with what each tool reported.
 *   2. `createClaimsAuditor` — a `TurnAuditor` holding the final text against
 *      that ledger and returning findings.
 *   3. `parseChecks` — the kanban `check:` DSL, so a ticket can state a fact a
 *      probe settles rather than prose a judge weighs.
 *
 * Security-kernel layer: `@ethosagent/types` is the ONLY import in this
 * package. Everything from outside — whether a pid is alive, where the
 * workdir is, what the config says — arrives as an injected port. That is not
 * ceremony: a verifier that reaches for its own facts is a second actor, and
 * the invariant the whole feature rests on is that the checker is never the
 * acting model.
 */

export {
  type ClaimsAuditorOptions,
  CONTRADICTED,
  createClaimsAuditor,
  formatGroundingMessage,
  NO_TOOLS_AT_ALL,
  UNSUPPORTED,
  type Verdict,
} from './auditor';
export { type GroundTruthCheck, isCheckLine, type ParsedChecks, parseChecks } from './checks';
export {
  createEvidenceCollector,
  createLedgerReset,
  type EvidenceCollectorOptions,
  type EvidenceKind,
  type EvidenceRecord,
  LedgerStore,
  type LedgerStoreOptions,
} from './evidence';
export {
  type AuditableSentence,
  type ClaimCode,
  type ExtractedClaim,
  extractAuditableSentences,
  extractClaims,
  type SentenceSplitter,
} from './extraction';

/** The pseudo tool name a finding travels under on `tool_progress`. Surfaces
 *  match on it to tell a finding from ordinary progress text. */
export const GROUNDING_TOOL_NAME = '_grounding';
