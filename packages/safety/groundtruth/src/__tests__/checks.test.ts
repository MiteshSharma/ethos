import { describe, expect, it } from 'vitest';
import { isCheckLine, parseChecks } from '../checks';

describe('parseChecks', () => {
  it('parses file_exists', () => {
    expect(parseChecks('check: file_exists dist/report.pdf').checks).toEqual([
      { verb: 'file_exists', path: 'dist/report.pdf' },
    ]);
  });

  it('parses file_min_bytes, taking the trailing count', () => {
    expect(parseChecks('check: file_min_bytes dist/report.pdf 2048').checks).toEqual([
      { verb: 'file_min_bytes', path: 'dist/report.pdf', bytes: 2048 },
    ]);
  });

  it('parses file_contains, the rest of the line being the substring', () => {
    expect(parseChecks('check: file_contains README.md ## Install now').checks).toEqual([
      { verb: 'file_contains', path: 'README.md', substring: '## Install now' },
    ]);
  });

  it('parses run with its expected exit code', () => {
    expect(parseChecks('check: run pnpm test exit 0').checks).toEqual([
      { verb: 'run', command: 'pnpm test', exitCode: 0 },
    ]);
  });

  it('takes the LAST exit token, so a command containing "exit" is unambiguous', () => {
    expect(parseChecks('check: run bash -c "echo exit 3" exit 0').checks).toEqual([
      { verb: 'run', command: 'bash -c "echo exit 3"', exitCode: 0 },
    ]);
  });

  it('reads checks out of a criteria block and leaves prose alone', () => {
    const criteria = [
      'The report reads well and covers Q3.',
      '- check: file_exists dist/report.pdf',
      '* check: run pnpm typecheck exit 0',
      'Reviewed by a human.',
    ].join('\n');

    const { checks, invalid } = parseChecks(criteria);
    expect(checks).toHaveLength(2);
    expect(invalid).toEqual([]);
  });

  it('reports a malformed check rather than dropping it silently', () => {
    const { checks, invalid } = parseChecks(
      ['check: file_exists', 'check: run pnpm test', 'check: teleport there'].join('\n'),
    );
    expect(checks).toEqual([]);
    expect(invalid).toEqual([
      'check: file_exists',
      'check: run pnpm test',
      'check: teleport there',
    ]);
  });

  it('finds nothing in criteria with no check lines', () => {
    expect(parseChecks('Ship it when it looks right.')).toEqual({ checks: [], invalid: [] });
  });

  // An EMPTY body used to match neither the check grammar nor the invalid
  // path: no check, no reported line, and — in a solo deployment, where there
  // is no LLM judge behind the checks — a completion accepted outright. A gate
  // that exists to fail closed cannot have a spelling that opens it.
  it.each([
    ['a bare check line', 'check:'],
    ['a check line of nothing but spaces', 'check:   '],
    ['a bulleted bare check line', '- check:'],
    ['a check line whose body is junk', 'check: teleport there'],
  ])('reports %s as invalid rather than as no check at all', (_label, line) => {
    const { checks, invalid } = parseChecks(line);
    expect(checks).toEqual([]);
    expect(invalid).toEqual([line.trim()]);
  });

  it('an empty check line does not hide behind prose that does parse', () => {
    const { checks, invalid } = parseChecks(
      ['check: file_exists report.pdf', 'check:', 'Reads nicely.'].join('\n'),
    );
    expect(checks).toHaveLength(1);
    expect(invalid).toEqual(['check:']);
  });
});

// The parser and the kanban verifier's prose-stripper have to agree about what
// a check line IS. Where they disagree there is a bypass in one direction or
// the other: a line the parser ignores but the stripper removes is a criterion
// nobody ever verified. One predicate, exported, used by both.
describe('isCheckLine', () => {
  it.each([
    'check: file_exists report.pdf',
    '- check: run pnpm test exit 0',
    '  * CHECK: file_min_bytes a.txt 10',
    'check:',
    'check:   ',
    'check: teleport there',
  ])('recognises %j', (line) => {
    expect(isCheckLine(line)).toBe(true);
  });

  it.each(['Ship it when it looks right.', 'Also check: the logs', '', 'checked: nothing'])(
    'leaves %j to the judge',
    (line) => {
      expect(isCheckLine(line)).toBe(false);
    },
  );

  it('recognises exactly the lines parseChecks accounts for', () => {
    const lines = [
      'check: file_exists report.pdf',
      'check:',
      'check:   ',
      '- check: teleport there',
      'Reads nicely.',
      'Also check: the logs',
    ];
    const { checks, invalid } = parseChecks(lines.join('\n'));
    expect(checks.length + invalid.length).toBe(lines.filter(isCheckLine).length);
  });
});
