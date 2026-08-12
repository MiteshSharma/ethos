// Drift gate for `GUARANTEE_IDS` — the register's row identities in code.
//
// The published guarantee register (docs/content/security/security-boundary.md)
// is prose; its citations live in `.architecture-state.yaml` under
// `register_anchors`, and `scripts/check-architecture.mjs` already ties those
// two together in both directions (a row with no anchor fails, an anchor with
// no row fails). Code cannot import either, so `GUARANTEE_IDS` exists — and
// this test is what stops it becoming a third list that merely agrees today.
//
// Sits beside the other constitution drift gates (personality-field-count,
// memory-method-count, agent-event-drift): a mechanical check on a rule the
// constitution states in prose.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUARANTEE_IDS } from '../safety';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SIDECAR = join(REPO_ROOT, '.architecture-state.yaml');

/**
 * The keys of the `register_anchors:` block. Read with a line scan rather than
 * a YAML parser so this gate carries no dependency of its own — the block is a
 * flat map of `  G-XXX:` keys and the scan stops at the next top-level key.
 */
function registerAnchorIds(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.indexOf('register_anchors:');
  if (start < 0) throw new Error('no `register_anchors:` block in .architecture-state.yaml');
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z_]/.test(line)) break; // next top-level key ends the block
    const match = /^ {2}([A-Z][A-Z-]*):\s*$/.exec(line);
    if (match?.[1]) ids.push(match[1]);
  }
  return ids;
}

describe('GUARANTEE_IDS', () => {
  it('names exactly the guarantees the register anchors in .architecture-state.yaml', () => {
    const anchored = registerAnchorIds(readFileSync(SIDECAR, 'utf-8'));
    expect(anchored.length).toBeGreaterThan(0);
    // Sorted comparison: the sidecar groups anchors by row, this list is in
    // register reading order, and neither ordering is the contract.
    expect([...GUARANTEE_IDS].sort()).toEqual([...anchored].sort());
  });

  it('is a closed list — no duplicates', () => {
    expect(new Set(GUARANTEE_IDS).size).toBe(GUARANTEE_IDS.length);
  });
});
