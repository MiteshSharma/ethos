// Regression guard: `ethos cas` with no subcommand must show usage, not run GC.
//
// `apps/ethos/src/index.ts` is a top-level script that reads `process.argv`
// at module scope and is not wrapped in an exported `main()`, so it can't be
// imported and driven directly in a test (importing it would execute the
// whole CLI). Instead we scan the source text for the `case 'cas':` block
// and assert its dispatch line, matching the pattern established by
// `no-raw-fs.test.ts` for other structural invariants.
//
// Context: `runCas` (apps/ethos/src/commands/cas.ts) only runs GC when
// `sub === 'gc'`, and shows a usage message otherwise. If `index.ts`
// defaults a missing subcommand to `'gc'` before calling `runCas`, that
// guard never fires for a bare `ethos cas` — silently running the
// mark-and-sweep GC as a side effect of an incomplete command. GC must stay
// manual, never automatic (see the header comment in commands/cas.ts and
// plan/phases/model-visible-logged.md D6/§7).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const INDEX_PATH = join(import.meta.dirname, '..', 'index.ts');

describe('cli dispatch: cas', () => {
  it('does not default the missing subcommand to "gc"', () => {
    const src = readFileSync(INDEX_PATH, 'utf-8');

    const match = src.match(/case 'cas': \{([\s\S]*?)\}/);
    expect(match, `Could not find "case 'cas':" block in ${INDEX_PATH}`).not.toBeNull();

    const block = match?.[1] ?? '';
    expect(block).toContain("await runCas(args[1] ?? '', args.slice(2));");
    expect(block).not.toContain("await runCas(args[1] ?? 'gc', args.slice(2));");
  });
});
