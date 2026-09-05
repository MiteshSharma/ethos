import { llmJudgeScorer } from '@ethosagent/eval-harness';
import { type GroundTruthCheck, isCheckLine, parseChecks } from '@ethosagent/safety-groundtruth';
import type {
  BeforeTicketCompletePayload,
  BeforeTicketCompleteResult,
  LLMProvider,
} from '@ethosagent/types';
import type { CheckProbe } from './probe';

// Longest slice of the acceptance criteria echoed into a rejection reason —
// keeps the audit trail readable when criteria are long documents.
const MAX_CRITERIA_IN_REASON = 300;

/** Named in every rejection a malformed check produces, so the fix is in the
 *  message rather than in the docs. */
export const CHECK_VERBS =
  'file_exists <path> | file_min_bytes <path> <n> | ' +
  'file_contains <path> <substring> | run <command> exit <code>';

export interface CompletionVerifierOptions {
  /**
   * Lazy provider for the LLM judge, so wiring can defer construction until
   * the first completion.
   *
   * OPTIONAL (R8). The verifier is now registered on solo deployments too,
   * where there is no team provider to judge with; absent, prose criteria are
   * accepted exactly as they were before this hook existed, and only `check:`
   * lines — facts a probe settles — gate the completion.
   */
  getProvider?: () => Promise<LLMProvider>;
  /**
   * Where `check:` paths resolve and `run` checks execute (R4). Absent, a
   * ticket carrying checks is REJECTED rather than accepted: a check nobody
   * can run is not a check that passed.
   */
  probe?: CheckProbe;
  /**
   * `grounding.kanban.allowedCheckCommands`. Default empty, so `run` is off
   * until an operator opts a specific command in.
   */
  allowedCheckCommands?: readonly string[];
  /**
   * `grounding.kanban.checks`. Default true.
   *
   * `false` turns the deterministic pass OFF WHOLE: `check:` lines are not
   * parsed, not run, and not stripped, so criteria reach the judge exactly as
   * they did before this pass existed. Deliberately not "fail every check" —
   * fail-closed is how an ENABLED checker treats a check it could not settle,
   * whereas a master switch that rejected every ticket carrying a check line
   * would not be a switch an operator could actually use.
   */
  checks?: boolean;
}

/** Render a parsed check back to the line an author wrote, so a rejection
 *  names the check in the author's own words. */
function describe(check: GroundTruthCheck): string {
  switch (check.verb) {
    case 'file_exists':
      return `file_exists ${check.path}`;
    case 'file_min_bytes':
      return `file_min_bytes ${check.path} ${check.bytes}`;
    case 'file_contains':
      return `file_contains ${check.path} ${check.substring}`;
    case 'run':
      return `run ${check.command} exit ${check.exitCode}`;
  }
}

function tokenize(command: string): string[] {
  return command.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Is this `run` command opted in?
 *
 * WHOLE-COMMAND MATCH: the check's argv must equal an allowlist entry's argv,
 * token for token, with nothing appended. An operator who writes `pnpm test`
 * is allowing THAT COMMAND, not that program with whatever options an agent
 * decides to add.
 *
 * It used to gate a leading-token PREFIX, which read as convenience and was a
 * hole. The commands come from `acceptanceCriteria`, which the agent writes,
 * so a prefix entry hands the agent the argument vector: `node` admits
 * `node -e '<any program>'`; `pnpm test` admits `pnpm test --config
 * attacker.js`, and a test runner will load that config. Refusing shell
 * metacharacters (`CheckProbe.run` takes argv, never a command string) stops
 * INJECTION, not ARGUMENT ABUSE — and argument abuse needs no shell.
 *
 * The cost is that an operator must name each command they want, which is the
 * correct cost: the allowlist is the whole authorization, and an authorization
 * whose tail the agent fills in is not one. A command absent from the list is
 * never executed at all — the verifier returns before touching the probe.
 */
function commandAllowed(argv: readonly string[], allowed: readonly string[]): boolean {
  for (const entry of allowed) {
    const want = tokenize(entry);
    if (want.length === 0 || want.length !== argv.length) continue;
    if (want.every((token, i) => argv[i] === token)) return true;
  }
  return false;
}

/** `null` when the check passed; otherwise why it did not, in the author's terms. */
async function settle(
  check: GroundTruthCheck,
  probe: CheckProbe,
  allowed: readonly string[],
): Promise<string | null> {
  if (check.verb === 'run') {
    const argv = tokenize(check.command);
    if (!commandAllowed(argv, allowed)) {
      const list = allowed.length === 0 ? 'the list is empty' : `allowed: ${allowed.join(', ')}`;
      return (
        `"${check.command}" does not exactly match an entry in ` +
        `grounding.kanban.allowedCheckCommands (${list})`
      );
    }
    const code = await probe.run(argv);
    return code === check.exitCode ? null : `exited ${code}, expected ${check.exitCode}`;
  }

  const missing = `no such file under ${probe.workdir}`;

  // One probe call per verb, and each asks only what its verb needs: existence
  // and size are metadata questions, and answering them by reading the file
  // would make `check: file_exists dist/bundle.js` cost the bundle.
  if (check.verb === 'file_exists') {
    return (await probe.exists(check.path)) ? null : missing;
  }
  if (check.verb === 'file_min_bytes') {
    const size = await probe.size(check.path);
    if (size === null) return missing;
    return size >= check.bytes ? null : `${size} bytes, expected at least ${check.bytes}`;
  }
  const hit = await probe.contains(check.path, check.substring);
  if (hit === null) return missing;
  return hit ? null : `does not contain "${check.substring}"`;
}

function truncate(text: string): string {
  return text.length > MAX_CRITERIA_IN_REASON ? `${text.slice(0, MAX_CRITERIA_IN_REASON)}…` : text;
}

/**
 * The `before_ticket_complete` claiming handler gating the running → done
 * transition. `handled: true` rejects the completion (the ticket moves to
 * `needs_revision` with the reason); `handled: false` lets it proceed.
 *
 * Two verification passes, in this order:
 *
 *   1. `check:` lines — deterministic, run against a probe rooted at the
 *      team's workdir (solo: the personality's). Facts, settled by a machine.
 *   2. The remaining prose — the Phase 7 eval-harness LLM judge, and only when
 *      a provider exists. Judgement, and it costs a model call.
 *
 * Checks first because they are cheap, certain, and because a failing fact
 * should not need a model's permission to reject a ticket.
 */
export function createCompletionVerifier(
  opts: CompletionVerifierOptions,
): (payload: BeforeTicketCompletePayload) => Promise<BeforeTicketCompleteResult> {
  const allowed = opts.allowedCheckCommands ?? [];

  return async (payload) => {
    // No acceptance criteria → nothing to verify; completion proceeds. The
    // provider is never constructed on this path.
    if (payload.acceptanceCriteria === undefined) {
      return { handled: false };
    }

    const criteria = payload.acceptanceCriteria;
    if (opts.checks === false) return judge(criteria);

    const { checks, invalid } = parseChecks(criteria);

    // FAIL CLOSED on a `check:` line that did not parse. `parseChecks` reports
    // these rather than dropping them precisely so this branch can exist: a
    // typo'd check that silently never runs turns the DSL into decoration, and
    // the ticket would complete on a verification that was never performed.
    const malformed = invalid[0];
    if (malformed !== undefined) {
      return {
        handled: true,
        reason:
          `verifier: unrecognised check line — ${truncate(malformed)}. ` +
          `Valid checks: ${CHECK_VERBS}`,
      };
    }

    if (checks.length > 0) {
      const probe = opts.probe;
      if (!probe) {
        return {
          handled: true,
          reason:
            'verifier: cannot verify — no verification workdir is configured for ' +
            `${truncate(checks.map(describe).join(' | '))}`,
        };
      }
      for (const check of checks) {
        let why: string | null;
        try {
          why = await settle(check, probe, allowed);
        } catch (err) {
          // A probe that threw — missing workdir, escaping path, unreadable
          // file — settles nothing, so it rejects. Same fail-closed rule as a
          // broken judge below.
          why = err instanceof Error ? err.message : String(err);
        }
        if (why !== null) {
          return { handled: true, reason: `verifier: check failed — ${describe(check)}: ${why}` };
        }
      }
    }

    // Prose left after the checks. Empty (criteria that were nothing but
    // checks, or nothing at all) → there is no judgement left to make, so the
    // judge is not called and no provider is constructed.
    return judge(
      criteria
        .split('\n')
        // `isCheckLine` — the SAME predicate `parseChecks` recognises lines
        // with, imported rather than restated. A local copy that disagreed
        // with the parser by one character would be a bypass in either
        // direction: a line the parser ignores but this strips is a criterion
        // nobody verified, and a line the parser settles but this leaves in
        // asks the judge for a second, softer verdict on a settled fact.
        .filter((line) => !isCheckLine(line))
        .join('\n')
        .trim(),
    );

    /**
     * The Phase 7 LLM judge over whatever prose is left.
     *
     * Empty prose (criteria that were nothing but checks, or nothing at all)
     * and a missing provider both mean there is no judgement to make: the
     * judge is not called and no provider is constructed.
     */
    async function judge(prose: string): Promise<BeforeTicketCompleteResult> {
      const getProvider = opts.getProvider;
      if (prose === '' || getProvider === undefined) {
        return { handled: false };
      }

      // `payload.autonomyTier` is deliberately ignored — a `trusted` assignee
      // is still verified. Phase 7 requirement: the review state is
      // non-skippable, so reputation does not buy a way around the pass.
      try {
        const provider = await getProvider();
        const score = await llmJudgeScorer(provider)(payload.summary, {
          id: payload.taskId,
          expected: prose,
          match: 'llm',
        });
        // Score >= 1 → the judge verified the summary; completion proceeds.
        if (score >= 1) {
          return { handled: false };
        }
        // Score 0 → rejected. Include the criteria (truncated) so the
        // needs_revision audit trail says what the summary failed to satisfy.
        return {
          handled: true,
          reason: `verifier: completion summary does not satisfy the acceptance criteria: ${truncate(prose)}`,
        };
      } catch (err) {
        // Fail CLOSED on verifier errors. fireClaiming swallows handler throws
        // (fail-open), so returning the rejection here is the only way to keep
        // the review state non-skippable when the verifier itself breaks.
        const message = err instanceof Error ? err.message : String(err);
        return { handled: true, reason: `verifier error (fail-closed): ${message}` };
      }
    }
  };
}
