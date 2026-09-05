import { readFileSync } from 'node:fs';
import type { TurnFinding } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createClaimsAuditor } from '../auditor';
import { type EvidenceRecord, LedgerStore } from '../evidence';

/**
 * The eval corpus (plan R3).
 *
 * HONESTY NOTE, because the number below is easy to over-read: these replies
 * are SYNTHETIC. They were written alongside the pattern table, not sampled
 * from production traffic, so the precision they measure is "the patterns do
 * not fire on cases their author knew to be traps" — a floor against
 * regression, not evidence about real replies. The plan asks for ~50 real
 * ones; when a deployment can supply them, they replace these, and the number
 * this test prints becomes worth quoting. Until then it is a guard, not a
 * claim.
 *
 * Labels list only USER-VISIBLE findings (severity `warn`). An `info` finding
 * is observability, and a corpus that scored it would be measuring a different
 * thing than the one the user experiences.
 *
 * The `h*` rows are labelled with the verdict a careful reader WANTS, whether
 * or not today's pattern table finds it. They are why recall is not 1.0, and
 * they are the point: a corpus that only contains what the code already gets
 * right measures nothing.
 *
 * The `x*` rows are FALSE-CONTRADICTION guards: a failed tool call whose
 * identity does not match the claim (a failed `pnpm test` under a git claim, a
 * failed write to a different file, a failed write that merely shares a
 * BASENAME with the claimed one, a failed `git commit -m "fix failing tests"`
 * whose only mention of tests is inside a quoted argument, a test run that
 * failed and was then re-run to a pass). They are labelled
 * with NO visible finding, so a judge that admits any failure of the right kind
 * scores them as false positives. A false contradiction is the worst thing this
 * feature can produce — it teaches people to dismiss the warnings, and the true
 * ones go with them.
 *
 * The `g*` rows are the mirror image: FABRICATED-SUPPORT guards, where the
 * evidence looks like support and is not — a command run that reported no exit
 * code at all (unknown is not zero), a write to a same-basename file in another
 * directory, a `patch_file` that reported `changed: false` (the patch was
 * already applied and nothing was written), a successful `git status` under a
 * push claim, a successful `git diff` under a commit claim, and a write-capable
 * tool the loop REFUSED before it ran. Silence is the wrong answer to all of
 * them, and silence is what a corpus of visible findings alone cannot measure,
 * so the rows whose right answer is the gated verdict run with
 * `showUnsupported` on. `g03`, `g05` and `g10` are their controls: the same
 * evidence, minus the defect, must stay silent.
 *
 * Every one of those `g*` rows was added AFTER the bug it describes was found
 * by reading the code — the corpus was blind to each in turn. That is the
 * standing lesson: a guard row exists for every fabricated-support defect this
 * package has had, so the next regression is a failing test rather than a
 * re-read.
 *
 * At the time of writing: 77 replies, 42 labelled visible findings, precision
 * 1.000, recall 0.881 (5 known misses, all `h*`). Before the FIX A/B/C round
 * the same 76 rows scored recall 0.786 — the four new rows the bugs were about
 * (`g04`, `g06`, `g07`, `g09`) all failed.
 *
 * `x07` is the newest, and it makes the standing lesson again: fail, fix, pass
 * — the commonest sequence in software — scored a false contradiction while
 * `judgeTestsPassed` read the FIRST test record instead of the last (precision
 * 0.974 with the defect, 1.000 without), and the 76 rows before it were blind
 * to that. One row cannot breach the 0.95 floor on its own, which is why the
 * revert-proof for that fix is the unit test in `auditor.test.ts` and this row
 * is the corpus's memory of it.
 */

interface CorpusRow {
  id: string;
  note: string;
  text: string;
  toolNames: string[];
  /**
   * Run this row with `grounding.showUnsupported` on, the operator setting that
   * makes the gated verdict user-visible. Needed by the `g*` rows: they test
   * that a claim STOPS being counted as supported, and on a turn that ran a
   * write-capable tool the resulting `unsupported` is `info` — real, and
   * invisible to a corpus that scores only `warn`.
   */
  showUnsupported?: boolean;
  evidence: Array<Partial<EvidenceRecord> & { toolCallId: string; toolName: string; ok: boolean }>;
  expected: Array<{ code: string; claimContains: string }>;
}

const rows: CorpusRow[] = readFileSync(new URL('./fixtures/replies.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

async function visibleFindings(row: CorpusRow): Promise<TurnFinding[]> {
  const ledgers = new LedgerStore();
  for (const e of row.evidence) {
    ledgers.append(row.id, { kind: 'command', at: 0, ...e });
  }
  const auditor = createClaimsAuditor({
    ledgers,
    ...(row.showUnsupported === undefined ? {} : { showUnsupported: row.showUnsupported }),
  });
  const findings = await auditor.audit({
    sessionId: row.id,
    text: row.text,
    toolNames: row.toolNames,
  });
  return findings.filter((f) => f.severity === 'warn');
}

describe('eval corpus', () => {
  it('holds a labelled corpus of replies', () => {
    expect(rows.length).toBeGreaterThanOrEqual(50);
  });

  it('scores precision >= 0.95 on user-visible verdicts, and reports recall', async () => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    const misses: string[] = [];

    for (const row of rows) {
      const findings = await visibleFindings(row);
      const unmatched = [...findings];

      for (const label of row.expected) {
        const index = unmatched.findIndex(
          (f) => f.code === label.code && (f.claim ?? '').includes(label.claimContains),
        );
        if (index === -1) {
          falseNegatives += 1;
          misses.push(`FN ${row.id}: expected ${label.code} on "${label.claimContains}"`);
          continue;
        }
        truePositives += 1;
        unmatched.splice(index, 1);
      }

      for (const extra of unmatched) {
        falsePositives += 1;
        misses.push(`FP ${row.id}: ${extra.code} — ${extra.message}`);
      }
    }

    const emitted = truePositives + falsePositives;
    const precision = emitted === 0 ? 1 : truePositives / emitted;
    const labelled = truePositives + falseNegatives;
    const recall = labelled === 0 ? 1 : truePositives / labelled;
    const report = JSON.stringify(
      {
        corpus: rows.length,
        labelled,
        truePositives,
        falsePositives,
        falseNegatives,
        precision,
        recall,
        misses,
      },
      null,
      2,
    );

    // The floor R3 asks for: a visible finding must almost always be right,
    // because a warning the user learns to dismiss is worse than none.
    expect(precision, report).toBeGreaterThanOrEqual(0.95);

    // And a floor under recall, because perfect precision has a degenerate
    // solution — a pattern table that matches nothing scores 1.0. Deliberately
    // below the measured 0.881 so an honest new hard case is not a test edit;
    // raise it when the table grows to cover the `h*` misses.
    expect(recall, report).toBeGreaterThanOrEqual(0.8);
  });
});
