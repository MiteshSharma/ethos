// The `grounded-citations` skill ships a stdlib-only Python matcher and a
// self-contained suite for it (`scripts/test_verify_quote.py`, 89 checks). The
// suite passed when run by hand and was invoked by nothing — `pnpm test` is
// `vitest run`, which never sees a .py file — so every acceptance criterion it
// covers, including "a paraphrase is not certified as a quote", could regress
// without failing a build. This shells out to it so it can.
//
// It does NOT skip when python3 is missing. A skip-if-absent guard is the same
// silence this test exists to remove, and the skill is inoperable without
// python3 anyway (`ethos.prerequisites.external_cli: [python3]`), so a missing
// interpreter is a real failure with a named cause.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledSkillsSource } from '../bundled';

const SKILL_DIR = join(bundledSkillsSource().dir, 'research', 'grounded-citations');
const SUITE = 'scripts/test_verify_quote.py';

/** The suite takes ~0.3s locally; this is headroom for a cold CI runner. */
const SUITE_TIMEOUT_MS = 60_000;

describe('grounded-citations matcher suite', () => {
  it(
    'python3 scripts/test_verify_quote.py exits 0',
    () => {
      const run = spawnSync('python3', [SUITE], {
        cwd: SKILL_DIR,
        encoding: 'utf8',
        timeout: SUITE_TIMEOUT_MS - 5_000,
      });

      if (run.error) {
        const code = (run.error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error(
            `python3 was not found on PATH. The grounded-citations matcher ` +
              `(${SKILL_DIR}/scripts/verify_quote.py) is a Python 3.10+ script and the ` +
              `skill declares python3 as a prerequisite, so this fails rather than skips. ` +
              `Install python3, or add a setup step to .github/workflows/ci.yml.`,
          );
        }
        throw new Error(`Could not run ${SUITE}: ${run.error.message}`);
      }

      // Surface the suite's own per-check output so a CI failure is diagnosable
      // from the log alone, without re-running anything locally.
      const diagnostics = [
        `${SUITE} exited ${run.status ?? `with signal ${run.signal}`}`,
        `--- stdout ---\n${run.stdout}`,
        `--- stderr ---\n${run.stderr}`,
      ].join('\n');
      expect(run.status, diagnostics).toBe(0);
    },
    SUITE_TIMEOUT_MS,
  );
});
