// Mechanical doc-drift gate for `EthosErrorCode`.
//
// `errors.ts` tells contributors: "Adding a code? Document it in
// `docs/content/troubleshooting.md`." Nothing checked that, so codes shipped
// undocumented. This gate reads both files and asserts every registered code
// appears on the page.
//
// There is no allowlist. Every registered code is operator-facing by
// construction — `EthosError` is the surface-layer envelope, so a code exists
// precisely because some CLI command, gateway adapter, or web route renders it
// to a human. If a future code genuinely warrants no entry, add it to an
// explicit allowlist here with a written reason rather than relaxing the
// assertion, so the omission is a recorded decision instead of an oversight.
//
// Mirrors the personality-field-count / memory-method-count gate pattern:
// parse the source text, compare against the published artefact.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ERRORS_SOURCE = join(import.meta.dirname, '..', 'errors.ts');
const TROUBLESHOOTING = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'content',
  'troubleshooting.md',
);

/** Extract the string-literal members of the `EthosErrorCode` union. */
function extractErrorCodes(src: string): string[] {
  const startMarker = 'export type EthosErrorCode =';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) throw new Error('EthosErrorCode union not found');
  const endIdx = src.indexOf(';', startIdx);
  if (endIdx < 0) throw new Error('EthosErrorCode union has no terminator');

  const body = src
    .slice(startIdx + startMarker.length, endIdx)
    // Strip comments so a code mentioned in a comment cannot pad the list.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  return [...body.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1] as string);
}

describe('EthosErrorCode ↔ troubleshooting.md parity gate', () => {
  const codes = extractErrorCodes(readFileSync(ERRORS_SOURCE, 'utf-8'));
  const doc = readFileSync(TROUBLESHOOTING, 'utf-8');

  it('parses a plausible number of codes from the union', () => {
    // Guard against a silently-empty match making the parity check vacuous.
    expect(codes.length).toBeGreaterThan(20);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('documents every registered error code in troubleshooting.md', () => {
    const missing = codes.filter((code) => !doc.includes(`\`${code}\``));
    expect(missing, `undocumented error codes: ${missing.join(', ')}`).toEqual([]);
  });
});
