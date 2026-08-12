// The gate that makes this package worth existing.
//
// The browser speaks the realtime provider's protocol DIRECTLY on the realtime
// tier — it opens the WebSocket itself with an ephemeral token, so the frame
// mapping has to be in the SPA bundle. The obvious place for that mapping was
// `extensions/voice-providers`, and it cannot be: that package depends on `ws`,
// which pulls node builtins into a page. The obvious alternative — a second
// copy of the mapping in `apps/web` — is the failure this repo already paid for
// once, when the speakable-text helpers drifted into three copies.
//
// So the mapping lives here, in a package with no transport at all, and this
// test is the thing that keeps it that way. It walks the ACTUAL import graph
// from each browser-facing entry point (relative imports plus workspace
// `@ethosagent/*` imports) and fails on any `ws` or `node:` specifier reachable
// from it, at any depth.
//
// The sibling half of the rule is the transport seam: `./socket` declares the
// types, `@ethosagent/voice-providers` supplies the `ws` implementation, and
// `apps/web` supplies the browser `WebSocket` one. Neither implementation is
// reachable from here.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(join(import.meta.dirname, '..', '..', '..', '..'));

/** Entry points whose whole reachable graph must be browser-safe. */
const BROWSER_ENTRY_POINTS = [
  'packages/voice-realtime-protocol/src/index.ts',
  'apps/web/src/features/voice/realtime-voice-call-client.ts',
];

/** Workspace roots scanned to map `@ethosagent/<x>` → its source entry file. */
const WORKSPACE_ROOTS = ['packages', 'packages/safety', 'extensions', 'apps'];

const IMPORT_RE =
  /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g;

interface WorkspaceEntry {
  dir: string;
  entry: string | undefined;
}

/** `@ethosagent/<name>` → { package dir, source entry file }. */
function workspacePackages(): Map<string, WorkspaceEntry> {
  const map = new Map<string, WorkspaceEntry>();
  for (const root of WORKSPACE_ROOTS) {
    const base = join(ROOT, root);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      const manifest = join(dir, 'package.json');
      if (!statSync(dir).isDirectory() || !existsSync(manifest)) continue;
      const pkg: unknown = JSON.parse(readFileSync(manifest, 'utf-8'));
      if (typeof pkg !== 'object' || pkg === null) continue;
      const pkgName = (pkg as { name?: unknown }).name;
      if (typeof pkgName !== 'string') continue;
      map.set(pkgName, { dir, entry: sourceEntry(dir, pkg) });
    }
  }
  return map;
}

/** The `exports['.'].import` source file, when the manifest names one. */
function sourceEntry(dir: string, pkg: object): string | undefined {
  const exportsField = (pkg as { exports?: unknown }).exports;
  if (typeof exportsField !== 'object' || exportsField === null) return undefined;
  const root = (exportsField as Record<string, unknown>)['.'];
  if (typeof root !== 'object' || root === null) return undefined;
  const imported = (root as { import?: unknown }).import;
  if (typeof imported !== 'string') return undefined;
  const file = resolve(dir, imported);
  return existsSync(file) ? file : undefined;
}

/** Resolve a relative specifier to a real file, trying the usual suffixes. */
function resolveRelative(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile());
}

function specifiersIn(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (spec) out.push(spec);
  }
  return out;
}

interface Violation {
  file: string;
  specifier: string;
  via: string[];
}

/** Walk the reachable graph from `entry`, reporting every forbidden specifier. */
function scan(entry: string, packages: Map<string, WorkspaceEntry>): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const queue: Array<{ file: string; via: string[] }> = [{ file: resolve(ROOT, entry), via: [] }];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (seen.has(next.file)) continue;
    seen.add(next.file);
    if (!existsSync(next.file)) continue;
    const rel = relative(ROOT, next.file).replace(/\\/g, '/');

    for (const spec of specifiersIn(readFileSync(next.file, 'utf-8'))) {
      if (spec === 'ws' || spec.startsWith('ws/') || spec.startsWith('node:')) {
        violations.push({ file: rel, specifier: spec, via: next.via });
        continue;
      }
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(next.file, spec);
        if (resolved) queue.push({ file: resolved, via: [...next.via, rel] });
        continue;
      }
      const workspace = packages.get(spec);
      // A non-workspace bare specifier (react, zod, antd) is a browser
      // dependency the bundler already carries; only OUR packages are walked,
      // because only ours can quietly grow a node builtin.
      if (workspace?.entry) queue.push({ file: workspace.entry, via: [...next.via, rel] });
    }
  }
  return violations;
}

describe('browser-safe realtime protocol', () => {
  const packages = workspacePackages();

  for (const entry of BROWSER_ENTRY_POINTS) {
    it(`reaches no ws and no node builtin from ${entry}`, () => {
      expect(existsSync(resolve(ROOT, entry)), `${entry} does not exist`).toBe(true);
      const violations = scan(entry, packages);
      expect(
        violations.map((v) => `${v.file} imports "${v.specifier}" (via ${v.via.join(' → ')})`),
        [
          `${entry} is bundled into the browser. Something reachable from it now`,
          'imports `ws` or a `node:` builtin, which breaks the SPA build.',
          '',
          'The fix is never to copy the mapping into apps/web — it is to move the',
          'transport-specific part behind the `RealtimeSocketFactory` seam in',
          '@ethosagent/voice-realtime-protocol/src/socket.ts.',
        ].join('\n'),
      ).toEqual([]);
    });
  }

  it('declares no runtime dependency beyond the zero-dep contracts package', () => {
    const pkg: unknown = JSON.parse(
      readFileSync(join(ROOT, 'packages/voice-realtime-protocol/package.json'), 'utf-8'),
    );
    const deps = (pkg as { dependencies?: Record<string, string> }).dependencies ?? {};
    expect(Object.keys(deps)).toEqual(['@ethosagent/types']);
    expect((pkg as { peerDependencies?: unknown }).peerDependencies).toBeUndefined();
  });
});
