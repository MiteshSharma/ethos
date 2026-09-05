import type { TurnAuditContext, TurnAuditor, TurnFinding } from '@ethosagent/types';
import type { EvidenceRecord, LedgerStore } from './evidence';
import {
  type ClaimCode,
  type ExtractedClaim,
  extractClaims,
  type SentenceSplitter,
} from './extraction';

/**
 * Layer 2: the deterministic claims auditor.
 *
 * It compares the claims the pre-filter kept against the turn's evidence
 * ledger. It is a checker and never an actor — no LLM call, no tool, no reach
 * outside the two things it is handed.
 */

export type Verdict = 'supported' | 'unsupported' | 'contradicted';

/** Verdict codes as they reach `TurnFinding.code`. */
export const CONTRADICTED = 'contradicted';
export const UNSUPPORTED = 'unsupported';
export const NO_TOOLS_AT_ALL = 'no_tools_at_all';

/**
 * Tools that could have DONE the thing a claim describes, whether or not this
 * ledger can see the doing. The gate `unsupported` findings pass (R7): if one
 * of these ran, an unmatched claim is more likely a gap in the pattern table
 * than a fabrication, and saying "unverified" out loud would be crying wolf.
 *
 * `delegate_task` counts because a delegated child runs in ANOTHER session —
 * its tools write to a ledger this turn's auditor never reads, so a parent that
 * delegated and then reported what the child did has evidence, elsewhere.
 */
const WRITE_CAPABLE = new Set([
  'terminal',
  'bash',
  'shell',
  'run_code',
  'run_tests',
  'lint',
  'typecheck',
  'write_file',
  'patch_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'process_start',
  'delegate_task',
]);

/**
 * Tool names whose ONLY calls this turn were refused before they ran.
 *
 * A refusal reaches the ledger as a record marked `rejected` (FIX C): the loop
 * fires `after_tool_call` for a blocked call so the turn's evidence says so out
 * loud. `TurnAuditContext.toolNames` cannot make the distinction on its own —
 * it is a bare list of names, and a name is there whether the call ran or was
 * denied, which is right for `no_tools_at_all` and wrong for the gate below.
 *
 * A name is subtracted only if EVERY record of it is a refusal. A tool that was
 * blocked once and ran once did run, and the turn has activity under that name.
 */
function refusedOnly(records: readonly EvidenceRecord[]): Set<string> {
  const refused = new Set<string>();
  const ran = new Set<string>();
  for (const record of records) {
    if (record.rejected === true) refused.add(record.toolName);
    else ran.add(record.toolName);
  }
  for (const name of ran) refused.delete(name);
  return refused;
}

function isWriteCapable(toolName: string): boolean {
  if (WRITE_CAPABLE.has(toolName)) return true;
  // Every MCP tool is third-party code doing who-knows-what under a name this
  // package cannot enumerate (`mcp__<server>__<tool>`, tools-mcp).
  if (toolName.startsWith('mcp__')) return true;
  return toolName.startsWith('delegate_');
}

const TEST_COMMAND = /\b(?:test|tests|vitest|jest|pytest|mocha|rspec|go\s+test)\b/i;

/**
 * Which family a command line belongs to — the identity test for a command
 * record, and subject to the same rule as `samePath`: identity is read where
 * identity lives, not anywhere the characters happen to appear.
 *
 * Quoted arguments are DATA, not the program being run. Matched over the raw
 * line, `\bgit\b` lets `echo "no git here"` answer for a commit claim, and
 * `\btests\b` lets a FAILED `git commit -m "fix failing tests"` contradict
 * "the tests pass" — the basename bug's false contradiction, through the
 * command-line door. So quoted spans go before the family is matched, exactly
 * as `sanitize()` in `extraction.ts` drops them from a sentence and for the
 * same reason.
 *
 * Residual, deliberately left and stated rather than papered over: an
 * UNQUOTED argument carrying a family word (`pnpm test --filter git`) still
 * matches. Closing it needs the line parsed into program words, and every
 * cheap approximation loses more than it gains — the family word is a
 * SUBCOMMAND in `pnpm test`, is inside a path in `./node_modules/.bin/jest`,
 * and is not the first token in `cd repo && git push`.
 */
function matchesFamily(command: string, family: RegExp): boolean {
  return family.test(command.replace(/"[^"]*"|'[^']*'/g, ' '));
}

/**
 * A version-control command, up to and including its subcommand.
 *
 * `(?:^|[\s|;&(])` anchors the binary at a word start or after a shell
 * separator, so `cd repo && git push` still reads as git; `[^|;&]*?` skips the
 * flags and paths between the binary and its subcommand (`git -C repo push`)
 * without leaping a pipe into a DIFFERENT program's arguments. It carries the
 * same residual `matchesFamily` documents and states rather than papers over:
 * an unquoted argument spelling a subcommand (`git commit -m fix push bug`)
 * still matches, and closing that needs a real shell parse.
 */
const VCS_SUBCOMMAND = String.raw`(?:^|[\s|;&(])(?:git|jj|gh)\s+[^|;&]*?\b`;

function vcsCommand(subcommand: string): RegExp {
  return new RegExp(VCS_SUBCOMMAND + subcommand, 'i');
}

/**
 * THE OPERATION TABLE — a family is not an operation.
 *
 * Matching `git`/`gh`/`jj` alone let a successful `git status` support "I pushed
 * the branch" and a successful `git diff` support "I committed the change": the
 * verifier reporting fabricated work as verified, which is the one failure it
 * exists to prevent. So a claim is matched to ITS OWN operation on both sides —
 * `claim` against the verb phrase `extraction.ts` captured, `command` against
 * the recorded command line — and a record of some other operation is not
 * evidence about this claim at all.
 *
 * Ordered, and read first-match-wins on both sides, so the specific entries come
 * before the general ones they would otherwise be swallowed by: `git checkout -b`
 * creates a branch before it is a checkout.
 *
 * An operation this table cannot name — on either side — is `unsupported`. Never
 * support, never contradiction: "I ran git" names no operation to check, and a
 * `git status` record answers no claim. Guessing in either direction is how the
 * two bugs above were written.
 */
interface VcsOperation {
  id: string;
  claim: RegExp;
  command: RegExp;
}

const VCS_OPERATIONS: readonly VcsOperation[] = [
  { id: 'pull request', claim: /^opened\b/, command: vcsCommand(String.raw`pr\s+create\b`) },
  {
    id: 'branch',
    claim: /^created\b/,
    command: vcsCommand(String.raw`(?:branch\b|(?:checkout|switch)\s+-[bc]\b)`),
  },
  {
    id: 'checkout',
    claim: /^checked\s+out\b/,
    command: vcsCommand(String.raw`(?:checkout|switch|restore)\b`),
  },
  { id: 'commit', claim: /^committed\b/, command: vcsCommand(String.raw`commit\b`) },
  { id: 'push', claim: /^pushed\b/, command: vcsCommand(String.raw`push\b`) },
  { id: 'merge', claim: /^merged\b/, command: vcsCommand(String.raw`merge\b`) },
  { id: 'rebase', claim: /^rebased\b/, command: vcsCommand(String.raw`rebase\b`) },
  { id: 'tag', claim: /^tagged\b/, command: vcsCommand(String.raw`tag\b`) },
  { id: 'revert', claim: /^reverted\b/, command: vcsCommand(String.raw`revert\b`) },
  { id: 'cherry-pick', claim: /^cherry-picked\b/, command: vcsCommand(String.raw`cherry-pick\b`) },
  { id: 'stash', claim: /^stashed\b/, command: vcsCommand(String.raw`stash\b`) },
];

/** Which operation a recorded command line performed, or `undefined` when the
 *  table cannot say. Quoted spans are stripped first, for the reason
 *  `matchesFamily` gives: a quoted argument is data, not the program. */
function vcsOperationOf(command: string): VcsOperation | undefined {
  const line = command.replace(/"[^"]*"|'[^']*'/g, ' ');
  return VCS_OPERATIONS.find((op) => op.command.test(line));
}

function commandRecords(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  return records.filter((r) => r.kind === 'command');
}

/** A command call that ran and reported a non-zero code is a contradiction as
 *  much as one that failed outright — `structured.exitCode` only ever carries
 *  0 today, but reading it is what makes this true if that changes. */
function failed(record: EvidenceRecord): boolean {
  return !record.ok || (record.exitCode !== undefined && record.exitCode !== 0);
}

/**
 * An OBSERVED success — the only thing that may support a command claim.
 *
 * `ok` alone is not enough, and this is the asymmetry that matters: a command
 * tool returns success both when it saw exit 0 and when it saw no exit code at
 * all (an older execution backend that emits no exit chunk). The tools no
 * longer fabricate a zero for the second case, so such a record arrives here
 * with `exitCode` absent — UNKNOWN. Unknown supports nothing: reading it as
 * support is how "the tests passed" comes to be backed by a run that never
 * reported whether they did.
 *
 * Unknown does not contradict either (`failed` ignores an absent code), so a
 * claim backed only by such a record lands on `unsupported` — which is exactly
 * what it is.
 */
function succeeded(record: EvidenceRecord): boolean {
  return record.ok && record.exitCode === 0;
}

/** A leading `./` is noise on both sides. Nothing else is rewritten: this is a
 *  comparison, not a resolver, and a contracts-only package has no filesystem
 *  to resolve against. */
function normalizePath(value: string): string {
  return value.replace(/^\.\//, '');
}

/**
 * Does this record's path name the file the claim named?
 *
 * An exact match, or a suffix that starts on a SEGMENT boundary: the leading
 * `/` in the `endsWith` test is what makes the boundary real, so `src/a.ts`
 * matches `/work/src/a.ts` and `foo/bar.ts` does NOT match `foo/notbar.ts`.
 * A raw string suffix would match both.
 *
 * There is deliberately NO basename fallback. It used to fire even when the
 * claim carried a directory — so a write to `tests/a.ts` could support, or
 * contradict, a claim about `src/a.ts`. Duplicate basenames are routine in
 * every real repository (`index.ts`, `types.ts`, `README.md`), which made that
 * a false-contradiction door of exactly the shape this package exists to
 * close, and a fabricated-support door besides.
 *
 * A claim with no directory component ("I wrote a.ts") needs no fallback: the
 * segment-boundary suffix already matches its basename against the record's
 * last segment, and only against the last segment — `srca.ts` is not `a.ts`.
 */
function samePath(recordPath: string, claimed: string): boolean {
  const target = normalizePath(claimed);
  const actual = normalizePath(recordPath);
  return actual === target || actual.endsWith(`/${target}`);
}

interface Judgement {
  verdict: Verdict;
  /** The record that decided a `contradicted` verdict, for the evidence line. */
  against?: EvidenceRecord;
  /**
   * Evidence line for an `unsupported` verdict where `CLAIM_LABEL`'s generic
   * "nothing of this kind was recorded" would be a false statement of its own —
   * a no-op patch, or a version-control command that was not the claimed
   * operation. A finding that misdescribes its own evidence is the same defect
   * class as one that invents it.
   */
  note?: string;
}

/**
 * THE MATCHING RULE, and every judge below obeys it.
 *
 * A record may contradict a claim only if it is a record OF THAT CLAIM'S
 * OPERATION. Two things can identify one:
 *
 *   - the KIND — a file write, a command, a process start. Always known,
 *     because it is read from the tool's name.
 *   - the SUBJECT — which file, which command line. Known from `structured` on
 *     success and from `args` on failure (see `EvidenceRecord`); still absent
 *     when a tool names neither.
 *
 * When the claim names a subject (a path, or a command family like git), the
 * record must name a matching one. A record whose subject is unknown is NOT a
 * match: it may be a failure of something else entirely, and reading it as a
 * contradiction is how a failed `pnpm test` ends up calling "I committed the
 * change" a lie, or a failed write to one file calls a claim about another one
 * a lie. Those are false contradictions, and a warning the user learns to
 * dismiss costs more than the true one it was traded for. Unmatched, the
 * verdict is `unsupported` — which is gated (R7) and usually silent.
 *
 * When the claim names no subject ("I ran the migration", "I started the
 * worker"), the kind IS the whole claim, so a failure of that kind matches it.
 * There is nothing to mismatch.
 *
 * AND THE ORDERING RULE, which follows from it. Where the matching records are
 * all of ONE operation — the same file, the same version-control operation, the
 * same test suite — the LAST of them is the state the reply describes: the
 * ledger appends in completion order and the claim was written after all of
 * them. `judgeVcs` and `judgeTestsPassed` therefore read `.at(-1)` and derive
 * the verdict from that record alone, which is what makes fail-fix-pass come
 * out `supported` instead of `contradicted`.
 *
 * Where the pool is MIXED — `judgeCommandRan` and `judgeProcessStarted` see
 * every command, or every process start, of the turn, because the claim named
 * no subject to filter by — "last" names some other operation entirely, and
 * letting an unrelated trailing failure decide would be a false contradiction
 * of exactly the shape above. Those two are success-preferring: any success in
 * the pool supports, and only a pool with no success at all contradicts.
 * `judgeFileWritten` is success-preferring for a different reason — a write
 * that failed after an earlier one succeeded did not un-write the file, so the
 * claim stays true — and it reaches its failure branch only when no matching
 * write succeeded, where every record is a failure and the choice is which one
 * to cite rather than what the verdict is.
 */

function judgeFileWritten(claim: ExtractedClaim, records: readonly EvidenceRecord[]): Judgement {
  const writes = records.filter((r) => r.kind === 'file_write');
  const claimed = claim.path;
  const about = (r: EvidenceRecord): boolean =>
    claimed === undefined || (r.path !== undefined && samePath(r.path, claimed));

  // `changed === false` is `patch_file` saying the patch was ALREADY APPLIED
  // and nothing was written. It is the strongest statement a writing tool can
  // make that no modification occurred, so it cannot be the support for a claim
  // that one did. Absent is not false: `write_file` reports no `changed` at all
  // because it has no no-op branch, and every success of its is a real write.
  if (writes.some((r) => r.ok && r.changed !== false && about(r))) return { verdict: 'supported' };

  const broken = writes.find((r) => !r.ok && about(r));
  if (broken) return { verdict: CONTRADICTED, against: broken };

  // Not a contradiction — the tool did not fail, and the file may well hold the
  // claimed content already. It is simply not evidence that this turn wrote it.
  const noop = writes.find((r) => r.ok && r.changed === false && about(r));
  if (noop) {
    return {
      verdict: UNSUPPORTED,
      note: `${noop.toolName} reported no change to ${noop.path ?? 'the file'}`,
    };
  }
  return { verdict: UNSUPPORTED };
}

/**
 * The subject is "a test run": the tool's own name settles it for `run_tests`,
 * and a command line naming a test runner settles it for a shell. A command
 * record that is neither is a different operation and never judged here.
 *
 * When several test runs happened, the LAST one decides — the same rule, and
 * the same reason, as `judgeVcs`: the ledger appends in completion order and
 * the claim was written after all of them, so the last run is the state the
 * reply describes.
 *
 * This judge used to take the FIRST failure, before any later run was looked
 * at, which made the most ordinary sequence in software — run the tests, watch
 * them fail, fix the code, run them again, say they pass — read as a lie about
 * work that had actually been done. A warning that fires on correct work on the
 * commonest workflow there is teaches people to dismiss every grounding warning
 * they see, and the true findings go with them.
 */
function judgeTestsPassed(records: readonly EvidenceRecord[]): Judgement {
  const testish = commandRecords(records).filter(
    (r) =>
      r.toolName === 'run_tests' ||
      (r.command !== undefined && matchesFamily(r.command, TEST_COMMAND)),
  );
  const latest = testish.at(-1);
  if (latest === undefined) return { verdict: UNSUPPORTED };
  if (succeeded(latest)) return { verdict: 'supported' };
  if (failed(latest)) return { verdict: CONTRADICTED, against: latest };
  return {
    verdict: UNSUPPORTED,
    note: `${latest.toolName} ran tests that reported no exit code`,
  };
}

/**
 * A bare "I ran it" / "I built it": the claim names no subject, so the KIND is
 * the whole claim and every command record of the turn is in the pool. There is
 * nothing for a record to mismatch, which is why this judge — unlike the file,
 * test and VCS ones — needs no identity test.
 *
 * Claims that DO name a subject never reach here: `judgeVcs` takes the
 * version-control ones, `judgeTestsPassed` the test ones. This used to take a
 * command-family filter for the VCS case, and matching a family was exactly the
 * defect — see `VCS_OPERATIONS`.
 */
function judgeCommandRan(records: readonly EvidenceRecord[]): Judgement {
  const pool = commandRecords(records);
  if (pool.some(succeeded)) return { verdict: 'supported' };
  const broken = pool.find(failed);
  if (broken) return { verdict: CONTRADICTED, against: broken };
  return { verdict: UNSUPPORTED };
}

/**
 * A version-control claim, judged against the operation it names.
 *
 * The subject here is not the git FAMILY — that was the bug — it is the
 * operation: a push claim is answered by push commands and by nothing else.
 * A record whose operation the table cannot identify is out of the pool
 * entirely, exactly as a record with no command line is: it may have been about
 * anything, so it can neither support nor contradict.
 *
 * When several commands of the claimed operation ran, the LAST one decides. The
 * ledger is appended in completion order and the claim was written after all of
 * them, so the last is the state the reply is describing — a push that failed
 * and was retried successfully leaves the branch pushed, and a push that
 * succeeded and was then re-run into a failure does not.
 */
function judgeVcs(claim: ExtractedClaim, records: readonly EvidenceRecord[]): Judgement {
  const phrase = claim.operation;
  const wanted =
    phrase === undefined ? undefined : VCS_OPERATIONS.find((op) => op.claim.test(phrase));
  if (wanted === undefined) {
    return { verdict: UNSUPPORTED, note: 'the claim names no version-control operation to check' };
  }

  const matching = commandRecords(records).filter(
    (r) => r.command !== undefined && vcsOperationOf(r.command)?.id === wanted.id,
  );
  const latest = matching.at(-1);
  if (latest === undefined) {
    return { verdict: UNSUPPORTED, note: `no ${wanted.id} command recorded this turn` };
  }
  if (succeeded(latest)) return { verdict: 'supported' };
  if (failed(latest)) return { verdict: CONTRADICTED, against: latest };
  return {
    verdict: UNSUPPORTED,
    note: `${latest.toolName} ran a ${wanted.id} command that reported no exit code`,
  };
}

/** No subject on either side: the extraction reads no process name out of the
 *  claim, and a record's pid is an outcome rather than an identity. So the kind
 *  is the match, exactly as for a bare command claim. */
function judgeProcessStarted(records: readonly EvidenceRecord[]): Judgement {
  const procs = records.filter((r) => r.kind === 'process');
  if (procs.some((r) => r.ok && r.aliveAtCheck !== false)) return { verdict: 'supported' };
  const broken = procs.find((r) => !r.ok || r.aliveAtCheck === false);
  if (broken) return { verdict: CONTRADICTED, against: broken };
  return { verdict: UNSUPPORTED };
}

function judge(claim: ExtractedClaim, records: readonly EvidenceRecord[]): Judgement {
  switch (claim.code) {
    case 'file_written':
      return judgeFileWritten(claim, records);
    case 'tests_passed':
      return judgeTestsPassed(records);
    case 'process_started':
      return judgeProcessStarted(records);
    case 'vcs':
      return judgeVcs(claim, records);
    default:
      return judgeCommandRan(records);
  }
}

const MAX_CLAIM_CHARS = 160;

/** Quote-safe, single-line, bounded: the claim is model output going onto a
 *  wire whose grammar uses `"` as its delimiter. */
function quoteClaim(sentence: string): string {
  const flat = sentence.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return flat.length > MAX_CLAIM_CHARS ? `${flat.slice(0, MAX_CLAIM_CHARS - 1)}…` : flat;
}

/**
 * The `_grounding` wire format — the contract every surface parses.
 *
 *   "<claim>" — <evidence>[ [ref:<toolCallId>]]
 *
 * One string, because that is all `tool_progress` carries (`AgentEvent` is
 * frozen at 17 variants and is not gaining fields for this). The grammar is a
 * convention inside the string rather than an encoding, because the SAME string
 * is what the CLI and every channel adapter print to a human: JSON would be
 * unreadable there, and a surface that has not implemented the parse yet still
 * shows a correct sentence.
 *
 * Parsing rules, exactly:
 *  - The message ALWAYS begins with `"`; the claim is everything to the next
 *    `"`. Inner quotes are replaced with `'` at construction, so the closing
 *    quote is unambiguous.
 *  - An optional ` — ` (space, U+2014 EM DASH, space) separates the evidence,
 *    which runs to the end of the message minus the ref.
 *  - An optional ` [ref:<id>]` ends the message; `<id>` matches
 *    `[A-Za-z0-9_-]+` and is a `toolCallId` from this turn's trail.
 *  Anything that does not parse is a claim line: show it as-is.
 */
export function formatGroundingMessage(parts: {
  claim: string;
  evidence?: string;
  citesToolCallId?: string;
}): string {
  const head = `"${quoteClaim(parts.claim)}"`;
  const body = parts.evidence ? `${head} — ${parts.evidence}` : head;
  return parts.citesToolCallId ? `${body} [ref:${parts.citesToolCallId}]` : body;
}

function describeEvidence(record: EvidenceRecord): string {
  if (record.rejected === true) return `${record.toolName} was refused before it ran`;
  if (record.exitCode !== undefined && record.exitCode !== 0) {
    return `${record.toolName} exited ${record.exitCode}`;
  }
  if (record.kind === 'process' && record.ok && record.aliveAtCheck === false) {
    return `${record.toolName} started pid ${record.pid} which was gone at check`;
  }
  return `${record.toolName} failed`;
}

const CLAIM_LABEL: Record<ClaimCode, string> = {
  file_written: 'no file write recorded this turn',
  tests_passed: 'no test run recorded this turn',
  command_ran: 'no command recorded this turn',
  process_started: 'no process start recorded this turn',
  vcs: 'no version-control command recorded this turn',
};

export interface ClaimsAuditorOptions {
  ledgers: LedgerStore;
  /**
   * Show `unsupported` findings even on a turn that ran a write-capable tool.
   * Off by default: `unsupported` means "the pattern table found no matching
   * evidence", which on a turn that plainly did work is far more often a gap in
   * the table than a lie (R7). Operators who want the raw signal opt in.
   */
  showUnsupported?: boolean;
  /**
   * Injected port — `splitSentences` from `@ethosagent/voice-text`, adapted and
   * supplied by `packages/wiring/src/grounding.ts`. Absent, a line is read as a
   * single sentence: this package may import contracts and nothing else, so it
   * has no splitter of its own to fall back on (see `SentenceSplitter`).
   */
  splitSentences?: SentenceSplitter;
}

/**
 * Build the deterministic auditor. Registered as `AgentLoopConfig.turnAuditors`
 * entry; the loop runs it inside `finalizeTurn` under a budget, fail-open.
 */
export function createClaimsAuditor(opts: ClaimsAuditorOptions): TurnAuditor {
  return {
    id: 'grounding-claims',
    async audit(ctx: TurnAuditContext): Promise<TurnFinding[]> {
      const claims = extractClaims(ctx.text, opts.splitSentences);
      if (claims.length === 0) return [];

      const records = opts.ledgers.get(ctx.sessionId);
      // R7's gate, minus the tools that never ran. A call the loop refused is
      // in `toolNames` — correctly, `no_tools_at_all` must not fire on a turn
      // that tried — but it is not activity that could have done the claimed
      // work, and counting it as such is what made a blocked `write_file` the
      // quietest possible outcome under "I wrote the file".
      const refused = refusedOnly(records);
      const anyWriteCapable = ctx.toolNames.some(
        (name) => isWriteCapable(name) && !refused.has(name),
      );
      const findings: TurnFinding[] = [];

      for (const claim of claims) {
        // No tools at all is its own verdict, and it does not need the ledger:
        // the loop's own tool list is the evidence, and it counts calls a hook
        // rejected — a turn that TRIED is not a turn that claimed out of thin
        // air.
        if (ctx.toolNames.length === 0) {
          findings.push({
            code: NO_TOOLS_AT_ALL,
            severity: 'warn',
            message: formatGroundingMessage({
              claim: claim.sentence,
              evidence: 'no tools ran this turn',
            }),
            claim: claim.sentence,
          });
          continue;
        }

        const { verdict, against, note } = judge(claim, records);
        if (verdict === 'supported') continue;

        if (verdict === CONTRADICTED && against) {
          findings.push({
            code: CONTRADICTED,
            severity: 'warn',
            message: formatGroundingMessage({
              claim: claim.sentence,
              evidence: describeEvidence(against),
              citesToolCallId: against.toolCallId,
            }),
            claim: claim.sentence,
            evidenceRef: against.toolCallId,
          });
          continue;
        }

        findings.push({
          code: UNSUPPORTED,
          // Observability-only on a turn that ran something that could have
          // done it; user-visible on a turn where nothing could have.
          severity: opts.showUnsupported === true || !anyWriteCapable ? 'warn' : 'info',
          message: formatGroundingMessage({
            claim: claim.sentence,
            evidence: note ?? CLAIM_LABEL[claim.code],
          }),
          claim: claim.sentence,
        });
      }

      return findings;
    },
  };
}
