/**
 * Layer 3's DSL, parsed here so the kanban verifier and the task-form help text
 * read the same grammar from one place.
 *
 * A `check:` line in a ticket's acceptance criteria states a fact a machine can
 * settle, next to the prose an LLM judge reads. Four verbs, no more: every verb
 * is something a probe can answer with a yes or a no, which is the whole point
 * — a criterion that needs judgement belongs in the prose.
 */

export type GroundTruthCheck =
  | { verb: 'file_exists'; path: string }
  | { verb: 'file_min_bytes'; path: string; bytes: number }
  | { verb: 'file_contains'; path: string; substring: string }
  | { verb: 'run'; command: string; exitCode: number };

export interface ParsedChecks {
  checks: GroundTruthCheck[];
  /**
   * `check:` lines that did not parse, verbatim. They are NOT dropped: a
   * typo'd check that silently does not run turns a verification DSL into
   * decoration, so the caller fails the completion closed and names the line.
   */
  invalid: string[];
}

/**
 * A line ADDRESSED TO THE CHECKER, whatever it goes on to say.
 *
 * Deliberately matches the prefix ALONE — no body requirement. A pattern that
 * demanded a non-empty body would leave `check:` on its own matching neither
 * the check grammar nor the invalid path: no check run, no line reported, and
 * a completion accepted on a verification that was never performed. Recognition
 * and parsing are therefore two steps: this decides what is addressed to the
 * checker, `parseChecks` decides whether what it says is legible, and anything
 * recognised but unparseable — an empty body included — is `invalid`.
 */
const CHECK_PREFIX = /^\s*(?:[-*+]\s*)?check:/i;

/**
 * The one predicate for "this line belongs to the checker".
 *
 * Exported because the kanban verifier strips settled check lines before
 * handing the remaining prose to the LLM judge, and the stripper and the parser
 * MUST agree about what a check line is. Two copies of the rule can disagree,
 * and the disagreement is exactly a bypass: a line the parser ignores and the
 * stripper removes is a criterion nobody ever verified.
 */
export function isCheckLine(line: string): boolean {
  return CHECK_PREFIX.test(line);
}

/** Greedy `.*` takes the LAST `exit <n>`, so `run bash -c "echo exit 3" exit 0`
 *  is unambiguous: the command keeps its "exit", the check takes the final one. */
const RUN_FORM = /^(.*?\S)\s+exit\s+(\d+)$/;

function parseOne(body: string): GroundTruthCheck | null {
  const space = body.indexOf(' ');
  if (space === -1) return null;
  const verb = body.slice(0, space);
  const rest = body.slice(space + 1).trim();
  if (rest === '') return null;

  if (verb === 'file_exists') return { verb, path: rest };

  if (verb === 'file_min_bytes') {
    const split = rest.lastIndexOf(' ');
    if (split === -1) return null;
    const bytes = Number(rest.slice(split + 1));
    const path = rest.slice(0, split).trim();
    if (path === '' || !Number.isInteger(bytes) || bytes < 0) return null;
    return { verb, path, bytes };
  }

  if (verb === 'file_contains') {
    const split = rest.indexOf(' ');
    if (split === -1) return null;
    const substring = rest.slice(split + 1).trim();
    if (substring === '') return null;
    return { verb, path: rest.slice(0, split), substring };
  }

  if (verb === 'run') {
    const match = RUN_FORM.exec(rest);
    if (!match) return null;
    const [, command, code] = match;
    if (command === undefined || code === undefined) return null;
    return { verb, command, exitCode: Number(code) };
  }

  return null;
}

/** Pull every `check:` line out of an acceptance-criteria block. Prose lines
 *  are not checks and are left to the LLM judge. */
export function parseChecks(criteria: string): ParsedChecks {
  const checks: GroundTruthCheck[] = [];
  const invalid: string[] = [];

  for (const line of criteria.split('\n')) {
    const match = CHECK_PREFIX.exec(line);
    if (!match) continue;
    // Everything after the prefix, which may be nothing at all. A bare
    // `check:` is a check line that says nothing — recognised, unparseable,
    // and so `invalid`; the caller fails the completion closed on it rather
    // than letting an empty criterion pass for having asked for nothing.
    const body = line.slice(match[0].length).trim();
    const parsed = body === '' ? null : parseOne(body);
    if (parsed) checks.push(parsed);
    else invalid.push(line.trim());
  }

  return { checks, invalid };
}
