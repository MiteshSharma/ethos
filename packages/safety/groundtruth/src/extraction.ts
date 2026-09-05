/**
 * Layer 2, step one: decide which sentences of a reply are CLAIMS about what
 * the agent did, before any of them is compared against evidence.
 *
 * This is the precision half of the feature (plan R3). A reply that shows the
 * user a command, quotes a log, or tells them what to run next is full of
 * sentences that look like claims and are not. Reading those as claims and
 * flagging them produces warnings on correct turns, and a grounding warning
 * nobody believes is worse than none — so the pre-filter drops far more than
 * it keeps, and the eval corpus in `__tests__/fixtures/replies.jsonl` is what
 * holds it to that.
 */

export type ClaimCode = 'file_written' | 'tests_passed' | 'command_ran' | 'process_started' | 'vcs';

export interface AuditableSentence {
  /** Verbatim, for quoting back to the user. */
  text: string;
  /** The same sentence with command code-spans removed, for matching only. */
  probe: string;
}

export interface ExtractedClaim {
  code: ClaimCode;
  /** The sentence the claim was read from, quoted verbatim. */
  sentence: string;
  /** The file the claim named, when it named one. */
  path?: string;
  /**
   * The verb phrase the claim used, lower-cased and whitespace-collapsed
   * ("committed", "pushed", "checked out", "created a branch"). Captured the
   * same way `path` is — a named group on the pattern that matched — and
   * interpreted where the evidence is, by `VCS_OPERATIONS` in `auditor.ts`.
   *
   * It is the claim's OPERATION, and it exists because a family is not one: a
   * successful `git status` is not a push, and a successful `git diff` is not a
   * commit. Only the `vcs` pattern captures it today; the field is optional
   * because a claim may name no operation the table can identify ("I ran git"),
   * which is a verdict of `unsupported` rather than a guess.
   */
  operation?: string;
}

const FENCE = /^\s*(?:```|~~~)/;
const LIST_MARKER = /^(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/;

/** A line addressed to the reader is instruction, not report. */
const SECOND_PERSON = /\b(?:you|your|yours|you'(?:re|ll|ve|d))\b/i;

/** A sentence that opens with a bare imperative is telling the user to do the
 *  thing, not reporting having done it. */
const IMPERATIVE_START =
  /^(?:run|make|check|try|install|see|note|add|use|open|ensure|verify|consider|review|please|let's|to\s)/i;

/** Modals, negations and hedges: none of these assert that something happened.
 *  Dropping the whole sentence loses a real claim that shares it with a hedge
 *  ("I wrote the file but did not run the tests" scores nothing), which costs
 *  recall and buys precision — the trade this filter exists to make. */
/** Reported speech: the sentence carries someone else's claim, not the
 *  agent's own report of what it did. */
const ATTRIBUTED = /\b(?:says?|said|claims?|claimed|according\s+to|reportedly|asked\s+for)\b/i;

const HYPOTHETICAL =
  /\b(?:would|could|should|shall|might|may|can|cannot|can't|won't|will|didn't|doesn't|don't|did\s+not|does\s+not|do\s+not|haven't|hasn't|has\s+not|have\s+not|isn't|wasn't|weren't|never|not|if|unless|once|after\s+you|going\s+to|need\s+to|needs\s+to|want\s+to|about\s+to|plan\s+to|planning\s+to|think|thought|believe|assume|guess|expect|hope|probably|likely|presumably|appears?|seems?)\b|\w'll\b/i;

/** Command words that mark an inline code span as a command rather than a
 *  path. A span holding a command must not lend its verbs to the sentence. */
const COMMAND_SPAN =
  /^\s*(?:sudo\s+)?(?:pnpm|npm|npx|yarn|bun|git|gh|node|deno|bash|sh|zsh|make|cargo|go|python3?|pip3?|ruby|docker|kubectl|curl|wget|rm|mv|cp|mkdir|touch|cd|ls|cat|echo|vitest|jest|pytest|tsc|biome|eslint|prettier)\b/;

const FIRST_PERSON = /(?:^|[^\p{L}])(?:I|I'(?:ve|m)|[Ww]e|[Ww]e've)(?:[^\p{L}]|$)/u;

/** An outcome report ("the tests pass", "the build is green") is admitted even
 *  though it carries no first-person subject. It is the single most common
 *  fabricated claim there is — the plan's own worked example is
 *  `"tests pass" — run_tests exited 1` — and requiring "I" would filter it out.
 *  Everything else in the pre-filter still applies to it. */
const OUTCOME_REPORT =
  /\b(?:tests?|test\s+suite|specs?|suite|build|typecheck|lint(?:er)?|checks?|everything|all\s+green)\b[^\n]{0,60}?\b(?:pass(?:ed|es|ing)?|green|succeed(?:ed|s)?|clean)\b/i;

/** Subject + optional adverbs, shared by every first-person pattern. */
const SUBJECT = String.raw`(?:^|[^\p{L}])(?:I|[Ww]e)(?:'ve)?\s+(?:(?:have|had|just|also|then|already|successfully|now|finally|quickly)\s+)*`;

interface Pattern {
  code: ClaimCode;
  re: RegExp;
}

/**
 * Ordered: the FIRST pattern that matches a sentence names it, and a sentence
 * yields at most one claim. "I updated the tests and they pass" is read as a
 * passing-tests claim because that is the claim worth checking; a second row
 * quoting the same sentence would say the same thing twice.
 */
const PATTERNS: Pattern[] = [
  { code: 'tests_passed', re: OUTCOME_REPORT },
  {
    code: 'process_started',
    re: new RegExp(
      `${SUBJECT}(?:started|launched|spawned|booted|restarted)\\b[\\s\\S]{0,40}?\\b(?:server|process|daemon|watcher|container|worker|service|job)\\b`,
      'u',
    ),
  },
  {
    code: 'vcs',
    re: new RegExp(
      `${SUBJECT}(?<op>committed|pushed|merged|rebased|tagged|reverted|cherry-picked|stashed|checked\\s+out|opened\\s+(?:a\\s+)?(?:PR|pull\\s+request)|created\\s+(?:a\\s+)?branch|ran\\s+git)\\b`,
      'u',
    ),
  },
  {
    code: 'file_written',
    re: new RegExp(
      `${SUBJECT}(?:wrote|written|created|added|updated|edited|patched|saved|modified|generated|rewrote|deleted|removed)\\b[\\s\\S]{0,80}?(?:(?<path>[\\w@][\\w@./-]*\\.[A-Za-z][A-Za-z0-9]{0,5})|\\bfiles?\\b)`,
      'u',
    ),
  },
  {
    code: 'command_ran',
    re: new RegExp(`${SUBJECT}(?:ran|executed|invoked|installed|built|compiled)\\b`, 'u'),
  },
];

/** Drop the CONTENT of command-shaped code spans and of double-quoted spans;
 *  unwrap every other span so a path written as `src/foo.ts` still reaches the
 *  patterns. Quoted text is someone else's words — a criterion, a log line, a
 *  commit message — and lending its verbs to the sentence around it is the
 *  false positive this whole filter exists to avoid. */
function sanitize(sentence: string): string {
  return sentence
    .replace(/`([^`]*)`/g, (_match, inner: string) =>
      COMMAND_SPAN.test(inner) || /\s/.test(inner) ? ' ' : inner,
    )
    .replace(/"[^"]*"/g, ' ');
}

/**
 * Injected port: cut one line into sentences.
 *
 * There is exactly one sentence splitter in this repo — `@ethosagent/voice-text`
 * — and `packages/voice-text/src/__tests__/drift-gate.test.ts` fails on a second
 * declaration of it, because the three copies that package replaced had already
 * drifted apart. This package cannot import it: security-kernel depends on
 * contracts and nothing else (ARCHITECTURE.md §II), the same reason `pidAlive`
 * arrives injected. So the splitter arrives the same way, supplied by wiring
 * (`packages/wiring/src/grounding.ts`).
 */
export type SentenceSplitter = (line: string) => string[];

/** No splitter injected: the line is the sentence. Not a splitter of its own —
 *  a line with no injected splitter is simply never cut. */
const WHOLE_LINE: SentenceSplitter = (line) => [line];

/** The pre-filter. Fenced code, blockquotes, second-person lines, imperatives
 *  and hedged sentences are gone by the time anything is matched. */
export function extractAuditableSentences(
  raw: string,
  splitLine: SentenceSplitter = WHOLE_LINE,
): AuditableSentence[] {
  const out: AuditableSentence[] = [];
  let inFence = false;

  for (const line of raw.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('>')) continue;

    const body = trimmed.replace(LIST_MARKER, '');
    if (SECOND_PERSON.test(body)) continue;

    for (const sentence of splitLine(body)) {
      const text = sentence.trim();
      if (text === '' || IMPERATIVE_START.test(text)) continue;

      const probe = sanitize(text);
      if (HYPOTHETICAL.test(probe) || ATTRIBUTED.test(probe)) continue;
      if (!FIRST_PERSON.test(probe) && !OUTCOME_REPORT.test(probe)) continue;

      out.push({ text, probe });
    }
  }

  return out;
}

/** Pre-filter, then the pattern table. Reading claims ("I read the file") are
 *  deliberately not audited: they change nothing, so a wrong one is a wrong
 *  answer rather than a fabricated action. */
export function extractClaims(
  raw: string,
  splitLine: SentenceSplitter = WHOLE_LINE,
): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];

  for (const { text, probe } of extractAuditableSentences(raw, splitLine)) {
    for (const { code, re } of PATTERNS) {
      const match = re.exec(probe);
      if (!match) continue;
      const path = match.groups?.path;
      const op = match.groups?.op;
      claims.push({
        code,
        sentence: text,
        ...(path ? { path } : {}),
        ...(op ? { operation: op.replace(/\s+/g, ' ').toLowerCase() } : {}),
      });
      break;
    }
  }

  return claims;
}
