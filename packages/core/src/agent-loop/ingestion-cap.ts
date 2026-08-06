// Lane 1(c) — ingestion-time cap on tool-result content, applied by
// stages/tool-processing.ts BEFORE a result is persisted to history.
//
// `executeParallel` already trims successful results to the split per-call
// budget; what escapes it is the error path (`result.error` is never trimmed
// there — the unbounded hole). This cap is the backstop: the FULL per-turn
// budget, not the per-call split, so it can never fight `executeParallel`'s
// tighter trim. It runs BEFORE the untrusted wrap (post-review FIX 7 — a cap
// applied after wrapping could sever the closing </untrusted> tag), so the
// wrapper is the only growth past the budget — a small constant. The
// truncation happens once at write time and the persisted bytes are frozen
// thereafter — the stored bytes are the replay bytes (Lane 2b, #4555) — so
// the #111085 live-budget-jitter concern does not apply here. A spill pointer
// that fell in the cut region is re-attached per the string contract.

import { preserveSpillPath } from './tool-result-aging';

/** Truncate `content` to `budgetChars`, marking the cut and keeping any
 *  spill-file pointer reachable. In-budget content is returned unchanged. */
export function capIngestedResult(content: string, budgetChars: number): string {
  if (budgetChars <= 0 || content.length <= budgetChars) return content;
  return preserveSpillPath(
    content,
    `${content.slice(0, budgetChars)}\n[truncated — ${content.length} chars total]`,
  );
}
