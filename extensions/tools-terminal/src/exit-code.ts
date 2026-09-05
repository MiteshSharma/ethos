/**
 * Exit-code evidence for command results (plan `ground-truth-verification`, R6).
 *
 * `ToolResult.structured` never reaches the model: `tool-processing.ts` hands
 * the LLM `result.ok ? result.value : result.error` and nothing else. The
 * failure paths already name the code ("Command exited with error (code 3)");
 * the success paths did not, so a model reporting "it exited 0" was reporting
 * something it could not see. The suffix puts it where the model reads.
 */

/** Appended to a command result whose backend reported an EXPLICIT exit 0.
 *  A run that reported no exit code at all gets no suffix: unknown is not
 *  zero, and a suffix is an assertion about what was observed. */
export const EXIT_SUFFIX = '\n(exit 0)';

/**
 * Re-attach the suffix when a rewrite dropped it. Same hazard
 * `preserveSpillPath` guards one stage earlier: `bashReducer`'s summarizers
 * replace the value outright, which takes the exit code with it.
 *
 * Skipped when `rewritten` already ends with the suffix, so a result can never
 * carry two.
 */
export function preserveExitSuffix(original: string, rewritten: string): string {
  if (!original.endsWith(EXIT_SUFFIX) || rewritten.endsWith(EXIT_SUFFIX)) return rewritten;
  return rewritten + EXIT_SUFFIX;
}
