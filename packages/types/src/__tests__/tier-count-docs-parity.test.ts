// Mechanical drift gate for the published security tier figures.
//
// `.architecture-state.yaml` is the authoritative tier assignment: every
// workspace package has a `tier:` line in it. Three documents then make prose
// CLAIMS about that inventory — its size, its per-tier split, and (in the
// boundary page) which packages sit in Tier 0 and Tier 1. Nothing checked
// those claims, and all three drifted: the sidecar header said 120 packages,
// SECURITY.md and security-boundary.md said 119, and the mechanical count was
// 141. Published *security* documentation was ~22 packages stale, in three
// places that disagreed with each other. CHANGELOG.md called this out as "a
// gap of its own"; this file is the gate that closes it.
//
// The count is trivially derivable from the sidecar, so the gate derives it
// and compares. It also checks Tier 0 and Tier 1 ROSTER membership, because
// the same drift happened there: `security-boundary.md`'s Execution row was
// missing two Tier 1 packages for a month, and `packages/worker-router` was
// Tier 1 while appearing in no row of the table at all. A count-only gate
// would have passed both.
//
// Tier 2 gets a count check and no roster check: the boundary page states it
// as "the remaining N packages" by construction, which is the honest shape —
// Tier 2 is the complement, not a list.
//
// Mirrors the personality-field-count / memory-method-count /
// error-code-docs-parity gate pattern: parse the source of truth, compare
// against the published artefact.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SIDECAR = join(REPO_ROOT, '.architecture-state.yaml');
const SECURITY_MD = join(REPO_ROOT, 'SECURITY.md');
const BOUNDARY_MD = join(REPO_ROOT, 'docs', 'content', 'security', 'security-boundary.md');

interface TieredPackage {
  path: string;
  name: string;
  tier: number;
}

/**
 * Read the `tiers:` block of the sidecar. Each entry is a two-space-indented
 * path key with `package:` and `tier:` beneath it. Deliberately a small
 * hand-parse rather than a YAML dependency — `@ethosagent/types` has zero
 * runtime deps and this gate must not be the thing that gives it one.
 */
export function parseTiers(yaml: string): TieredPackage[] {
  const start = yaml.indexOf('\ntiers:\n');
  if (start < 0) throw new Error('sidecar has no `tiers:` block');
  const body = yaml.slice(start + 1);

  const out: TieredPackage[] = [];
  let path: string | null = null;
  let name: string | null = null;

  for (const line of body.split('\n')) {
    const key = /^ {2}([A-Za-z][^\s:]*):\s*$/.exec(line);
    if (key) {
      path = key[1] ?? null;
      name = null;
      continue;
    }
    const pkg = /^ {4}package:\s*"?([^"\s]+)"?\s*$/.exec(line);
    if (pkg) {
      name = pkg[1] ?? null;
      continue;
    }
    const tier = /^ {4}tier:\s*"?(\d)"?\s*$/.exec(line);
    if (tier && path && name) {
      out.push({ path, name, tier: Number(tier[1]) });
    }
  }
  return out;
}

/** Every `N packages: A at Tier 0, B at Tier 1, C at Tier 2` claim in a document. */
export function parseClaims(doc: string): { total: number; byTier: number[] }[] {
  const re = /(\d+) packages: (\d+) at Tier 0, (\d+) at Tier 1, (\d+) at Tier 2/g;
  return [...doc.matchAll(re)].map((m) => ({
    total: Number(m[1]),
    byTier: [Number(m[2]), Number(m[3]), Number(m[4])],
  }));
}

/** The unscoped half of `@ethosagent/foo`, which is how the prose names packages. */
function shortName(pkg: string): string {
  return pkg.replace(/^@[^/]+\//, '');
}

/** Is this package named in backticks in `text`, by short name or by path? */
function named(text: string, pkg: TieredPackage): boolean {
  return text.includes(`\`${shortName(pkg.name)}\``) || text.includes(`\`${pkg.path}\``);
}

/** The slice of a markdown document between two headings. */
function section(doc: string, startMarker: string, endMarker: string): string {
  const from = doc.indexOf(startMarker);
  if (from < 0) throw new Error(`marker not found: ${startMarker}`);
  const to = doc.indexOf(endMarker, from + startMarker.length);
  if (to < 0) throw new Error(`end marker not found: ${endMarker}`);
  return doc.slice(from, to);
}

const sidecar = readFileSync(SIDECAR, 'utf-8');
const packages = parseTiers(sidecar);
const counts = [0, 1, 2].map((t) => packages.filter((p) => p.tier === t).length);
const expected = { total: packages.length, byTier: counts };

const securityMd = readFileSync(SECURITY_MD, 'utf-8');
const boundaryMd = readFileSync(BOUNDARY_MD, 'utf-8');

describe('security tier counts ↔ .architecture-state.yaml parity gate', () => {
  it('parses a plausible inventory from the sidecar', () => {
    // Guard against a silently-empty parse making every assertion vacuous.
    expect(packages.length).toBeGreaterThan(100);
    expect(new Set(packages.map((p) => p.path)).size).toBe(packages.length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(packages.length);
    for (const n of counts) expect(n).toBeGreaterThan(0);
  });

  it.each([
    ['.architecture-state.yaml', sidecar],
    ['SECURITY.md', securityMd],
    ['docs/content/security/security-boundary.md', boundaryMd],
  ])('%s publishes the mechanical count', (_label, doc) => {
    const claims = parseClaims(doc);
    expect(claims.length, 'no "N packages: A at Tier 0, ..." figure found').toBe(1);
    expect(claims[0]).toEqual(expected);
  });

  it('states the Tier 2 remainder on the boundary page', () => {
    const tier2 = counts[2] ?? 0;
    expect(boundaryMd).toContain(`The remaining ${tier2} packages.`);
  });

  it('names every Tier 0 package in the boundary page roster', () => {
    const roster = section(boundaryMd, '**Tier 0 — the security kernel.**', '**Tier 1 —');
    const missing = packages
      .filter((p) => p.tier === 0)
      .map((p) => shortName(p.name))
      .filter((n) => !roster.includes(n));
    expect(missing, `Tier 0 packages in no roster line: ${missing.join(', ')}`).toEqual([]);
  });

  // The table names a module in backticks, by its unscoped package name
  // (`gateway`) or — where the short name alone would be ambiguous — by its
  // workspace path (`apps/web-api`). Either is a naming; neither a bare
  // mention in surrounding prose.
  it('names every Tier 1 package in the boundary page table', () => {
    const table = section(boundaryMd, '**Tier 1 — guarded surfaces.**', '**Tier 2 —');
    const missing = packages
      .filter((p) => p.tier === 1)
      .filter((p) => !named(table, p))
      .map((p) => p.path);
    expect(missing, `Tier 1 packages in no table row: ${missing.join(', ')}`).toEqual([]);
  });
});

// The gate must have teeth against a wrong figure, not merely agree with a
// repository that currently happens to be right. These drive the same parsers
// over synthetic text.
describe('tier gate — proof it fails on drift', () => {
  const sidecarFixture = [
    'version: 1',
    '',
    'tiers:',
    '  packages/types:',
    '    package: "@ethosagent/types"',
    '    tier: 0',
    '  extensions/gateway:',
    '    package: "@ethosagent/gateway"',
    '    tier: 1',
    '  extensions/tools-web:',
    '    package: "@ethosagent/tools-web"',
    '    tier: 2',
    '  extensions/cron:',
    '    package: "@ethosagent/cron"',
    '    tier: 2',
    '',
  ].join('\n');

  const parsed = parseTiers(sidecarFixture);

  it('counts a fixture sidecar exactly', () => {
    expect(parsed.length).toBe(4);
    expect([0, 1, 2].map((t) => parsed.filter((p) => p.tier === t).length)).toEqual([1, 1, 2]);
  });

  it('rejects a total that drifted', () => {
    const claim = parseClaims('3 packages: 1 at Tier 0, 1 at Tier 1, 2 at Tier 2.')[0];
    expect(claim).not.toEqual({ total: 4, byTier: [1, 1, 2] });
  });

  it('rejects a per-tier split that drifted', () => {
    const claim = parseClaims('4 packages: 1 at Tier 0, 2 at Tier 1, 1 at Tier 2.')[0];
    expect(claim).not.toEqual({ total: 4, byTier: [1, 1, 2] });
  });

  it('rejects a document that makes no count claim at all', () => {
    expect(parseClaims('The tier roster lives in the sidecar.')).toEqual([]);
  });

  it('catches a Tier 1 package that appears in no table row', () => {
    const tier1 = parsed.filter((p) => p.tier === 1);

    const table = '| Ingress | `gateway` |\n';
    expect(tier1.filter((p) => !named(table, p)).map((p) => p.path)).toEqual([]);

    const tableWithoutIt = '| Ingress | `platform-slack` |\n';
    expect(tier1.filter((p) => !named(tableWithoutIt, p)).map((p) => p.path)).toEqual([
      'extensions/gateway',
    ]);
  });

  it('accepts a package named by its workspace path rather than its short name', () => {
    const pkg: TieredPackage = { path: 'apps/web-api', name: '@ethosagent/web-api', tier: 1 };
    expect(named('| Network surface | `apps/web-api` |', pkg)).toBe(true);
    expect(named('| Network surface | `gateway` |', pkg)).toBe(false);
    // A bare mention outside backticks is not a naming.
    expect(named('the web-api network surface', pkg)).toBe(false);
  });
});
