import { describe, expect, it } from 'vitest';
import {
  type ClaimCode,
  extractAuditableSentences,
  extractClaims,
  type SentenceSplitter,
} from '../extraction';

/**
 * Stand-in for the injected splitter. The real one is `splitSentences` from
 * `@ethosagent/voice-text`, which this package may not import — security-kernel
 * depends on contracts and nothing else — and which
 * `packages/wiring/src/grounding.ts` supplies; the test that the wiring seam
 * actually supplies it lives next to that file.
 */
const stubSplitter: SentenceSplitter = (line) => line.split('. ');

function codes(text: string, splitLine?: SentenceSplitter): ClaimCode[] {
  return extractClaims(text, splitLine).map((c) => c.code);
}

describe('pre-filter (R3)', () => {
  it('drops fenced code blocks', () => {
    const text = [
      'Here is the diff.',
      '```bash',
      'I wrote src/a.ts and the tests pass',
      '```',
    ].join('\n');
    expect(codes(text)).toEqual([]);
  });

  it('drops a tilde-fenced block too', () => {
    expect(codes(['~~~', 'I created report.pdf', '~~~'].join('\n'))).toEqual([]);
  });

  it('drops blockquotes — quoted text is someone else speaking', () => {
    expect(codes('> I ran the migration and the tests pass')).toEqual([]);
  });

  it('drops second-person lines — instructions are not reports', () => {
    expect(codes('You can run the tests and they pass on my machine.')).toEqual([]);
    expect(codes('Your build passes once the deps are installed.')).toEqual([]);
  });

  it('drops imperatives', () => {
    expect(codes('Run `pnpm test` — the tests pass in CI.')).toEqual([]);
    expect(codes('Make sure the tests pass before merging.')).toEqual([]);
  });

  it('drops hypotheticals, modals and hedges', () => {
    expect(codes('I would have written src/a.ts.')).toEqual([]);
    expect(codes('I can run the tests next.')).toEqual([]);
    expect(codes('I did not write src/a.ts.')).toEqual([]);
    expect(codes('I think the tests pass.')).toEqual([]);
  });

  it('drops a command hidden in an inline code span', () => {
    expect(codes('The recipe is `git commit -m "I wrote the file"` for later.')).toEqual([]);
  });

  it('keeps a path written as an inline code span', () => {
    expect(codes('I wrote `src/a.ts` in one pass.')).toEqual(['file_written']);
  });

  it('drops past tense about the USER rather than the agent', () => {
    expect(codes('You wrote src/a.ts before this session.')).toEqual([]);
  });

  it('admits an outcome report with no first-person subject', () => {
    expect(extractAuditableSentences('All tests pass.').map((s) => s.text)).toEqual([
      'All tests pass.',
    ]);
  });

  it('strips list markers from the quoted claim', () => {
    expect(extractClaims('- I wrote src/a.ts.')[0]?.sentence).toBe('I wrote src/a.ts.');
  });
});

describe('claim patterns', () => {
  const table: Array<[string, ClaimCode]> = [
    ['I wrote src/agent.ts with the new loop.', 'file_written'],
    ['I updated 3 files under packages/core.', 'file_written'],
    ['We created docs/readme.md from the template.', 'file_written'],
    ['All tests pass.', 'tests_passed'],
    ['The test suite is green.', 'tests_passed'],
    ['I ran the tests and they passed.', 'tests_passed'],
    ['I ran the migration script.', 'command_ran'],
    ['I executed the build.', 'command_ran'],
    ['I started the dev server on port 3000.', 'process_started'],
    ['I launched the worker process.', 'process_started'],
    ['I committed the change.', 'vcs'],
    ['I pushed the branch upstream.', 'vcs'],
    ['I opened a PR against main.', 'vcs'],
  ];

  for (const [text, code] of table) {
    it(`reads ${JSON.stringify(text)} as ${code}`, () => {
      expect(codes(text)).toEqual([code]);
    });
  }

  it('captures the path a write claim names', () => {
    expect(extractClaims('I wrote src/agent.ts with the new loop.')[0]?.path).toBe('src/agent.ts');
  });

  it('does not audit reading claims', () => {
    expect(codes('I read src/agent.ts and looked at the config.')).toEqual([]);
  });

  it('yields one claim per sentence, highest-priority pattern first', () => {
    expect(codes('I updated the tests and they pass.')).toEqual(['tests_passed']);
  });

  it('reads several sentences independently', () => {
    expect(codes('I wrote src/a.ts. I committed the change.', stubSplitter)).toEqual([
      'file_written',
      'vcs',
    ]);
  });

  it('captures the VCS operation the claim named, normalized', () => {
    // Captured the same way `path` is — a named group on the pattern that
    // matched — so the auditor can hold a push claim against push commands
    // rather than against the whole git family.
    expect(extractClaims('I pushed the branch to origin.')[0]?.operation).toBe('pushed');
    expect(extractClaims('I have  checked   out the release tag.')[0]?.operation).toBe(
      'checked out',
    );
    expect(extractClaims('I created a branch called feature/x.')[0]?.operation).toBe(
      'created a branch',
    );
  });

  it('leaves the operation absent on claims that name none', () => {
    expect(extractClaims('I wrote src/a.ts.')[0]?.operation).toBeUndefined();
  });

  it('reads a line as one sentence when no splitter is injected', () => {
    // The port's default. Nothing here re-implements the splitter, so an
    // un-wired caller under-reads a multi-claim line rather than drifting from
    // the one implementation — which is why wiring supplies one.
    expect(codes('I wrote src/a.ts. I committed the change.')).toEqual(['vcs']);
  });
});
