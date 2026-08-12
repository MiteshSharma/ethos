#!/usr/bin/env node
/**
 * The architecture validator — the mechanical projection of ARCHITECTURE.md.
 *
 * WHAT THIS IS. ARCHITECTURE.md §IX declares a parser contract: "a single YAML
 * document inside the first ```yaml fence whose first non-blank line is
 * `# ARCHITECTURE-RULES v1`. The validator reads this block plus
 * `.architecture-state.yaml` and exits non-zero on any unmatched violation."
 * This is that validator. The constitution is the source; this file is its
 * projection. Rules are READ from the fenced block and the sidecar — they are
 * not restated here, because a second copy is a second thing to drift.
 *
 * WHY IT EXISTS. A published control claim once survived the deletion of the
 * code that implemented it (plan/phases/security-boundary.md G11), because
 * nothing tied a claim to an enforcement point. Check 3 is that tie, in both
 * directions. Check 4 is the same tie one layer out: the sentences ELSEWHERE
 * that describe the register's size and membership, which drifted from it for
 * exactly the same reason — nothing was checking them.
 *
 * WHERE PROSE AND YAML CONFLICT, §IX says the prose wins. So a rule that cannot
 * be expressed mechanically is reported as UNENFORCED rather than approximated
 * — an approximate check that fails constitutionally-permitted code gets
 * switched off, and a switched-off check protects nothing.
 *
 * SEVERITY.
 *   error — exits non-zero. The rule is mechanically sound as stated.
 *   warn  — reported, does not fail. The rule has an escape hatch in the prose
 *           that no machine-readable inventory resolves; the finding is real
 *           but the verdict needs a human. Each warn prints what would make it
 *           an error.
 *
 * USAGE
 *   node scripts/check-architecture.mjs
 *   node scripts/check-architecture.mjs --only exceptions,register
 *   node scripts/check-architecture.mjs --sidecar <path> --architecture <path> --root <path>
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const CHECKS = ['tiers', 'layers', 'register', 'register-claims', 'exceptions', 'stale-paths'];

/** The register is the published projection of the guarantee table (plan §4.2). */
const REGISTER_DOC = 'docs/content/security/security-boundary.md';

/** Citation form used by the register: a GitHub blob permalink with a line anchor. */
const CITATION_RE = /https:\/\/github\.com\/ethosagent\/ethos\/blob\/main\/([^)#\s]+)#L(\d+)/g;

/** Workspace roots the tier roster must cover (plan §7 Phase 3, check 1). */
const TIERED_ROOTS = ['packages', 'packages/safety', 'extensions', 'apps'];

const VALID_TIERS = [0, 1, 2];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.vite',
  '.docusaurus',
]);

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|ya?ml|sh|txt|toml|html|css|Dockerfile)$|^Dockerfile$|^Makefile$/;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * @type {{check: string, severity: 'error'|'warn', where: string, what: string,
 *   fix: string, roll?: {label: string, subject: string}}[]}
 */
const findings = [];
/** @type {{rule: string, why: string}[]} */
const unenforced = [];

function fail(check, where, what, fix) {
  findings.push({ check, severity: 'error', where, what, fix });
}
/**
 * `roll` collapses many findings that share one location and one remedy into a
 * single reported line — `{ label, subject }`. Twenty-one identical sentences
 * differing only in a package name is noise; one sentence and a list is a finding.
 */
function warn(check, where, what, fix, roll) {
  findings.push({ check, severity: 'warn', where, what, fix, roll });
}
function notEnforced(rule, why) {
  unenforced.push({ rule, why });
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Extract the §IX rules block per the parser contract: the FIRST ```yaml fence
 * whose first non-blank line is the version marker. Anything else is not the
 * rules block, even if it parses.
 */
export function parseRulesBlock(markdown) {
  // Anchored to line starts: §IX's own parser-contract comment contains the
  // literal "```yaml" mid-line, and an unanchored non-greedy match closes on it.
  const fence = /^```yaml\n([\s\S]*?)^```/gm;
  let m = fence.exec(markdown);
  while (m !== null) {
    const body = m[1];
    const firstLine = body.split('\n').find((l) => l.trim() !== '');
    if (firstLine?.trim() === '# ARCHITECTURE-RULES v1') return YAML.parse(body);
    m = fence.exec(markdown);
  }
  throw new Error(
    'ARCHITECTURE.md §IX: no ```yaml fence whose first non-blank line is "# ARCHITECTURE-RULES v1". ' +
      'The parser contract in §IX is the authority on this shape.',
  );
}

// ---------------------------------------------------------------------------
// Path / layer helpers
// ---------------------------------------------------------------------------

/** Match a sidecar layer path, which may be a one-level glob ("extensions/*"). */
function pathMatches(pattern, path) {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
  }
  return pattern === path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function listDirs(root, dir) {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => `${dir}/${e.name}`);
}

/** Every workspace package under the tiered roots, as repo-relative dir paths. */
function discoverPackages(root) {
  const found = new Set();
  for (const r of TIERED_ROOTS) {
    for (const dir of listDirs(root, r)) {
      if (existsSync(join(root, dir, 'package.json'))) found.add(dir);
    }
  }
  return [...found].sort();
}

/**
 * Tracked files, repo-relative. `null` when git cannot answer.
 *
 * Tracked files only. Untracked trees are not the repository: agent worktrees
 * under .claude/, and generated bundles like docs/static/llms-full.txt which
 * mirror content the callers already read at its source. A validator that fails
 * on somebody's scratch checkout is a validator people switch off.
 */
function trackedFiles(root) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(String.fromCharCode(0))
      .filter(Boolean);
  } catch {
    return null;
  }
}

function collectSourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name === '__tests__') continue;
        walk(full);
      } else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Check 1 — tier completeness (G6)
// ---------------------------------------------------------------------------

function checkTiers(ctx) {
  const { root, sidecar } = ctx;
  const tiers = sidecar.tiers ?? {};
  const onDisk = discoverPackages(root);

  for (const dir of onDisk) {
    const entry = tiers[dir];
    if (!entry) {
      fail(
        'tiers',
        dir,
        'workspace package carries no tier in .architecture-state.yaml',
        'add an entry for this directory under tiers: with package, tier (0|1|2), and assigned ' +
          "(today's date). An unclassified module is how 90 extensions ended up inside a security " +
          'promise — and a tier assigned after a report arrives is rationalisation, not triage (§3.3).',
      );
      continue;
    }
    if (!VALID_TIERS.includes(entry.tier)) {
      fail(
        'tiers',
        dir,
        `tier is ${JSON.stringify(entry.tier)}; the roster admits only 0, 1, or 2`,
        'set tier to 0 (kernel), 1 (guarded surface), or 2 (extension). See docs/content/security/security-boundary.md#tiers.',
      );
    }
    const declared = entry.package;
    const actual = readJson(join(root, dir, 'package.json')).name;
    if (declared && declared !== actual) {
      fail(
        'tiers',
        dir,
        `sidecar records package "${declared}" but ${dir}/package.json says "${actual}"`,
        `update the sidecar's package: field to "${actual}".`,
      );
    }
  }

  const diskSet = new Set(onDisk);
  for (const dir of Object.keys(tiers)) {
    if (!diskSet.has(dir)) {
      fail(
        'tiers',
        dir,
        'tier entry names a package that does not exist on disk',
        'remove the entry from tiers:, or restore the package. A roster that names ghosts cannot be ' +
          'used to answer "is this module in scope".',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2 — layer import rules (§IX layers:)
// ---------------------------------------------------------------------------

function buildLayerIndex(ctx) {
  const { sidecar } = ctx;
  /** @type {Map<string,string>} dir -> layer */
  const dirLayer = new Map();
  const layerDirs = new Map();
  const tierDirs = Object.keys(sidecar.tiers ?? {});

  for (const layer of sidecar.layers ?? []) {
    const dirs = [];
    for (const pattern of layer.paths ?? []) {
      for (const dir of tierDirs) {
        if (pathMatches(pattern, dir)) dirs.push(dir);
      }
    }
    layerDirs.set(layer.name, dirs);
    for (const d of dirs) {
      // First layer wins: the sidecar lists security-kernel before core, and
      // packages/safety/* must not be re-read as anything else.
      if (!dirLayer.has(d)) dirLayer.set(d, layer.name);
    }
  }

  /** @type {Map<string,string>} package name -> dir */
  const nameDir = new Map();
  for (const [dir, entry] of Object.entries(sidecar.tiers ?? {})) {
    if (entry?.package) nameDir.set(entry.package, dir);
  }

  return { dirLayer, layerDirs, nameDir };
}

function internalDeps(root, dir) {
  const pkg = readJson(join(root, dir, 'package.json'));
  const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  return Object.keys(all).filter((n) => n.startsWith('@ethosagent/'));
}

/**
 * Vendored packages (sidecar `vendored:`) are workspace packages that are
 * functionally EXTERNAL: a thin shim over a platform primitive with no Ethos
 * semantics. The layer check reads them the way it reads an npm dependency, so
 * a closed layer may depend on one without that being an unclassified reach.
 *
 * The flag is only as honest as its justification, so `rationale` is required
 * and a blank one fails. Without that, `vendored:` is a one-line escape from
 * every layer rule and the next awkward edge quietly moves in behind it.
 */
function vendoredNames(ctx) {
  const { sidecar } = ctx;
  const entries = sidecar.vendored ?? {};
  const names = new Set();
  for (const [name, entry] of Object.entries(entries)) {
    const rationale = String(entry?.rationale ?? '').trim();
    if (rationale === '') {
      fail(
        'layers',
        `.architecture-state.yaml vendored[${name}]`,
        'vendored classification carries no rationale',
        'state, in the entry, why this package has no Ethos semantics — no contract, no policy, no ' +
          'boundary decision — and is therefore exempt from the layer rules. An unjustified `vendored: ' +
          'true` is a hole in Law 11 wide enough for the next package that finds a layer inconvenient.',
      );
      continue;
    }
    if (!sidecar.tiers?.[entry?.path]) {
      fail(
        'layers',
        `.architecture-state.yaml vendored[${name}]`,
        `path ${JSON.stringify(entry?.path ?? null)} is not a package in the tier roster`,
        'point `path` at the package directory as it appears under tiers:. Vendoring answers which ' +
          'layer rules apply; it never removes a package from the tier roster.',
      );
    }
    names.add(name);
  }
  return names;
}

function checkLayers(ctx) {
  const { root, rules } = ctx;
  const { dirLayer, layerDirs, nameDir } = buildLayerIndex(ctx);
  const layers = new Map((rules.layers ?? []).map((l) => [l.name, l]));
  const vendored = vendoredNames(ctx);

  const kernelNames = new Set(
    (layerDirs.get('security-kernel') ?? []).map((d) => {
      for (const [name, dd] of nameDir) if (dd === d) return name;
      return d;
    }),
  );

  // §II: contracts, security-kernel, and core each "depend on contracts only".
  // For those three the dependency set is closed, so a dep on a package with no
  // layer assignment is still a violation. For extensions/wiring/apps the
  // sidecar states plainly that §II does not partition packages/* exhaustively,
  // so an unlayered dep there is not judged.
  const CLOSED_LAYERS = new Set(['contracts', 'security-kernel', 'core']);

  for (const [layerName, spec] of layers) {
    const dirs = layerDirs.get(layerName) ?? [];
    if (dirs.length === 0) continue;

    const allowedLayers = new Set([...(spec.depends_on ?? []), layerName]);
    const typeOnly = new Set(spec.type_only_deps ?? []);
    const forbidsAllInternal = (spec.forbids ?? []).some(
      (f) => f?.internal_workspace_deps === 'all',
    );

    for (const dir of dirs) {
      for (const dep of internalDeps(root, dir)) {
        // A vendored shim is an external dependency that happens to live
        // in-repo. Layer rules constrain Ethos-semantic coupling; this edge
        // carries none. Justified per-package in the sidecar, checked above.
        if (vendored.has(dep)) continue;

        const depDir = nameDir.get(dep);
        const depLayer = depDir ? dirLayer.get(depDir) : undefined;

        if (forbidsAllInternal) {
          fail(
            'layers',
            `${dir}/package.json`,
            `layer "${layerName}" forbids internal_workspace_deps: all, but depends on ${dep}`,
            'Law 1 — a contract that imports a sibling becomes structurally bound to it. Move the shared ' +
              'value into the contracts package or invert the dependency.',
          );
          continue;
        }

        if (depLayer && allowedLayers.has(depLayer)) continue;

        // §IX grants core `type_only_deps: [security-kernel]` — the package.json
        // edge is legal, only the runtime import is not. That is checked below
        // against the source, not the manifest.
        if (depLayer && typeOnly.has(depLayer)) continue;

        if (!depLayer) {
          if (!CLOSED_LAYERS.has(layerName)) continue;
          fail(
            'layers',
            `${dir}/package.json`,
            `layer "${layerName}" depends on contracts only (§II), but depends on ${dep}, which carries no layer assignment`,
            `either give ${dep} a layer in .architecture-state.yaml and prove the edge legal, or drop the ` +
              'dependency. A Tier 0 package reaching into an unclassified one is exactly the edge Law 11 exists for.',
          );
          continue;
        }

        // Law 5 for apps is checked at FILE granularity below, against the
        // sidecar's `app_entry_modules` inventory. A manifest edge says only
        // that the app declared the dependency somewhere; §II's thin-wiring-
        // adapter grant makes that legal for an entry module and illegal
        // everywhere else, and only the file check can tell those apart.
        if (layerName === 'apps') continue;

        fail(
          'layers',
          `${dir}/package.json`,
          `layer "${layerName}" may depend on [${[...allowedLayers].join(', ')}], but depends on ${dep} (layer "${depLayer}")`,
          'invert the dependency, or move the shared surface down to contracts.',
        );
      }
    }
  }

  // Runtime imports of the security kernel from core.
  // This REPLACED packages/core/src/__tests__/no-safety-imports.test.ts, which
  // has been deleted. Same rule, strictly stronger: the forbidden set is
  // derived from the sidecar rather than restated by hand (that hand-written
  // list named 4 of the 7 kernel packages), and dynamic `import(` / `require(`
  // are caught alongside `from`. The record of why one derivation replaced two
  // is the point of this note — a hand-kept copy of a rule drifts from the rule.
  for (const [layerName, spec] of layers) {
    const runtimeForbidden = new Set(
      (spec.forbids ?? []).flatMap((f) => f?.runtime_imports_of_layer ?? []),
    );
    if (runtimeForbidden.size === 0) continue;

    const forbiddenNames = new Set();
    for (const forbiddenLayer of runtimeForbidden) {
      for (const d of layerDirs.get(forbiddenLayer) ?? []) {
        for (const [name, dd] of nameDir) if (dd === d) forbiddenNames.add(name);
      }
    }

    for (const dir of layerDirs.get(layerName) ?? []) {
      for (const file of collectSourceFiles(join(root, dir, 'src'))) {
        const lines = readFileSync(file, 'utf-8').split('\n');
        lines.forEach((line, i) => {
          for (const name of forbiddenNames) {
            if (!line.includes(`'${name}'`) && !line.includes(`"${name}"`)) continue;
            if (!/\bfrom\s|\bimport\s*\(|\brequire\s*\(/.test(line)) continue;
            if (line.trimStart().startsWith('import type')) continue;
            if (/^\s*(\/\/|\*)/.test(line)) continue;
            fail(
              'layers',
              `${relative(root, file)}:${i + 1}`,
              `layer "${layerName}" runtime-imports ${name} (layer "${[...runtimeForbidden][0]}")`,
              'use `import type`, or take the capability through an injected contract seam bound by wiring. ' +
                'A kernel that core can import directly is a kernel nobody can replace (§II).',
            );
          }
        });
      }
    }
  }

  checkAppEntryModules(ctx, { dirLayer, layerDirs, nameDir, vendored, layers });

  if (kernelNames.size === 0) {
    fail(
      'layers',
      '.architecture-state.yaml',
      'the security-kernel layer resolves to no packages',
      'check that layers[].paths under security-kernel match directories that also appear under tiers:.',
    );
  }

  notEnforced(
    'layers[].forbids.raw_filesystem_apis / raw_filesystem_apis_outside_storage_contract (Law 7)',
    'covered by apps/ethos/src/__tests__/no-raw-fs.test.ts and the allowed-exception list in CLAUDE.md; ' +
      'expressing "on a personality boundary" mechanically needs a call-graph, not a grep.',
  );
  notEnforced(
    'layers[].forbids.direct_console_writes (Law 10)',
    'covered by Biome + review; the §IX rule names no allowed-file inventory for app entry modules.',
  );
  notEnforced(
    'layers[].composition_root: "entry modules only" (apps) and §II\'s thin-wiring-adapter grant',
    'now checked at file granularity against `app_entry_modules:` in .architecture-state.yaml, but reported ' +
      'as advisory because the repository does not satisfy it yet. The mechanism is done; the cleanup is not.',
  );
}

/**
 * Runtime import specifiers of workspace packages, per file. Type-only
 * `import type … from '…'` statements are removed first: they erase at build
 * time and create no runtime coupling, which is the coupling Law 5 is about.
 */
function workspaceImportsOf(text) {
  const runtime = text.replace(/import\s+type\s[\s\S]*?from\s*['"][^'"]+['"]/g, '');
  const re = /(?:from|import|require)\s*\(?\s*['"](@ethosagent\/[^'"]+)['"]/g;
  const names = new Set();
  let m = re.exec(runtime);
  while (m !== null) {
    names.add(m[1].split('/').slice(0, 2).join('/'));
    m = re.exec(runtime);
  }
  return names;
}

/**
 * §VIII exceptions that name a law, keyed by the exact path they scope. Shape
 * is NOT re-checked here — `checkExceptions` fails the whole run on a missing
 * owner, an expired `review_by`, or an unobservable removal condition, so a
 * malformed entry cannot buy quiet: the build is already red when it is read.
 * Matching is on the exact path, never a prefix, so an exception grants itself
 * to one file and never to a directory.
 */
function exemptPaths(sidecar, lawPattern) {
  const out = new Set();
  for (const ex of sidecar.exceptions ?? []) {
    if (!ex || typeof ex !== 'object') continue;
    if (!lawPattern.test(String(ex.law ?? ''))) continue;
    const scope = String(ex.scope ?? '').trim();
    if (scope) out.add(scope);
  }
  return out;
}

const LAW5_RE = /(law\s*5|\bL5\b)/i;

/**
 * Law 5 at FILE granularity (§II's thin-wiring-adapter grant, §IX's
 * `composition_root: "entry modules only"` for apps).
 *
 * §II lets an app carry its own wiring adapter and §IX confines composition to
 * entry modules, but neither enumerates which modules those are — so this ran
 * at manifest granularity and could only ever be advisory: "apps/ethos declares
 * @ethosagent/gateway" is true of a compliant app and a non-compliant one
 * alike. The sidecar's `app_entry_modules` is that missing inventory, and this
 * check is the rule read against it: an entry module composing concrete
 * implementations is the grant being used; any other app file reaching past
 * wiring is Law 5.
 *
 * STILL ADVISORY — pending cleanup, not pending a mechanism. The inventory is
 * in place and the check is exact; the repository simply does not satisfy it
 * yet (see the count in the report). Flipping `warn` to `fail` below is the
 * whole promotion, and it should happen the moment the count reaches zero. It
 * is deliberately NOT tuned to pass in the meantime: a check trimmed until it
 * goes green measures nothing, and the number it prints is the only honest
 * record of how far the apps are from the constitution.
 */
function checkAppEntryModules(ctx, idx) {
  const { root, sidecar } = ctx;
  const { dirLayer, layerDirs, nameDir, vendored, layers } = idx;
  const spec = layers.get('apps');
  if (!spec) return;

  const allowed = new Set([...(spec.depends_on ?? []), 'apps']);
  const inventory = sidecar.app_entry_modules ?? {};
  const appDirs = layerDirs.get('apps') ?? [];
  const exempt = exemptPaths(sidecar, LAW5_RE);

  // The inventory is a claim about files that exist, in the app they name.
  for (const [app, paths] of Object.entries(inventory)) {
    for (const p of paths ?? []) {
      if (!p.startsWith(`${app}/`)) {
        fail(
          'layers',
          '.architecture-state.yaml',
          `app_entry_modules lists ${p} under ${app}, which does not contain it`,
          'move the entry under the app that owns the file. An inventory that mis-files a path grants the ' +
            'exemption to a module nobody meant to grant it to.',
        );
        continue;
      }
      if (!existsSync(join(root, p))) {
        fail(
          'layers',
          '.architecture-state.yaml',
          `app_entry_modules lists ${p}, which does not exist on disk`,
          'remove the stale entry, or restore the entry module. A composition-root grant on a deleted file ' +
            'is a grant nobody can audit.',
        );
      }
    }
  }

  for (const app of appDirs) {
    const entries = new Set(inventory[app] ?? []);
    for (const file of collectSourceFiles(join(root, app, 'src'))) {
      const rel = relative(root, file);
      if (entries.has(rel) || exempt.has(rel)) continue;

      // Grouped by the layer reached, so one file importing six extensions is
      // one finding rather than six copies of the same sentence.
      const offending = new Map();
      for (const dep of workspaceImportsOf(readFileSync(file, 'utf-8'))) {
        if (vendored.has(dep)) continue;
        const depDir = nameDir.get(dep);
        const depLayer = depDir ? dirLayer.get(depDir) : undefined;
        if (!depLayer || allowed.has(depLayer)) continue;
        if (!offending.has(depLayer)) offending.set(depLayer, []);
        offending.get(depLayer).push(dep);
      }

      for (const [depLayer, deps] of offending) {
        warn(
          'layers',
          app,
          `Law 5 — ${rel} imports ${deps.sort().join(', ')} (layer "${depLayer}"); only an entry module may`,
          'ADVISORY pending cleanup, not pending a mechanism: `app_entry_modules` in ' +
            '.architecture-state.yaml is the §II/§IX inventory this check was missing, and the check is now ' +
            'exact against it. Route the import through @ethosagent/wiring, or — if the file genuinely IS a ' +
            'composition root — add it to the inventory and say so in review. Do not widen the inventory to ' +
            'silence a finding; promoting this to an error is a one-word change once the count is zero.',
          {
            label: `Law 5 — non-entry-module app files import layer "${depLayer}"`,
            subject: rel,
          },
        );
      }
    }
  }
}

/**
 * Everything §IX declares that this validator does NOT check, derived from the
 * parsed block rather than a hand-kept list — so a law or safety rule added to
 * the constitution shows up here on its first run instead of being silently
 * unenforced, which is the failure mode this whole phase exists to end.
 */
const GATED_ELSEWHERE = {
  L3_only_wiring_composes:
    'reported as advisory under the file-granularity Law 5 check above, against `app_entry_modules`.',
  L7_storage_abstraction:
    'apps/ethos/src/__tests__/no-raw-fs.test.ts + the allowed-exception list in CLAUDE.md.',
  L8_toolset_enforcement:
    'packages/core/src/__tests__/tool-registry*.test.ts (definition time and execution time).',
  L9_extensionless_imports:
    'scripts/check-tool-imports.sh and tsx resolution failing loudly in dev.',
  L10_silent_libraries: 'Biome, plus review.',
  L11_kernel_guarantees_not_weakenable:
    'behavioural, not structural — the AgentSafety conformance suite is the gate. The exception check ' +
    'above enforces its no-exception-path half.',
  S6_inbound_safety_injection:
    'the personality drift gate; §IX marks it `enforcement: mechanical` there.',
};

function reportUnenforcedRules(ctx) {
  const { rules } = ctx;
  const enforcedLaws = new Set([
    'L1_contracts_pure',
    'L2_core_no_concrete',
    'L5_apps_through_wiring',
  ]);
  for (const law of Object.keys(rules.laws ?? {})) {
    if (enforcedLaws.has(law)) continue;
    notEnforced(
      `laws.${law}`,
      GATED_ELSEWHERE[law] ??
        'no mechanical check in this validator and none named elsewhere — a gap.',
    );
  }
  for (const rule of Object.keys(rules.safety ?? {})) {
    notEnforced(
      `safety.${rule} (§V)`,
      GATED_ELSEWHERE[rule] ??
        'behavioural rather than structural; the AgentSafety conformance suite and the adversarial tests ' +
          'are where this is proven, not a static scan.',
    );
  }
  for (const schema of Object.keys(rules.frozen_schemas ?? {})) {
    notEnforced(
      `frozen_schemas.${schema} (§VII)`,
      'each frozen schema carries its own drift gate under packages/types/src/__tests__/; §IX names the ' +
        'gate kind, and the gate itself is the enforcement.',
    );
  }
}

// ---------------------------------------------------------------------------
// Check 3 — register <-> enforcement point, both directions (§4.2, G11)
// ---------------------------------------------------------------------------

function readCitations(root) {
  const docPath = join(root, REGISTER_DOC);
  if (!existsSync(docPath)) {
    fail(
      'register',
      REGISTER_DOC,
      'the guarantee register does not exist',
      'the register is the published projection of the guardrails table; without it the boundary is unpublished.',
    );
    return [];
  }
  const lines = readFileSync(docPath, 'utf-8').split('\n');
  const out = [];
  let row = '(preamble)';
  lines.forEach((line, i) => {
    const heading = line.match(/^###\s+(G-[A-Z]+)\b/);
    if (heading) row = heading[1];
    CITATION_RE.lastIndex = 0;
    let m = CITATION_RE.exec(line);
    while (m !== null) {
      out.push({ row, docLine: i + 1, path: m[1], line: Number(m[2]) });
      m = CITATION_RE.exec(line);
    }
  });
  return out;
}

/**
 * The anchor a citation asserts, from the sidecar's `register_anchors`, keyed
 * `<row>|<path>|<line>`. Returns the map plus a mutable set of keys nobody
 * cited, so an anchor for a withdrawn claim cannot sit here unnoticed.
 */
function readAnchors(sidecar) {
  const byKey = new Map();
  for (const [row, list] of Object.entries(sidecar.register_anchors ?? {})) {
    for (const a of list ?? []) {
      byKey.set(`${row}|${a?.path}|${a?.line}`, String(a?.contains ?? ''));
    }
  }
  return byKey;
}

function checkRegister(ctx) {
  const { root, sidecar } = ctx;
  const citations = readCitations(root);
  if (citations.length === 0) return;

  // --- Anchors: what each citation ASSERTS is at the line it points to.
  //
  // A bare line number catches deletion and nothing else. Insert lines above an
  // enforcement point and every anchor below it lands on real, non-blank,
  // unrelated code — the claim is silently re-aimed and CI stays green. That is
  // G11 in a quieter form, so the anchor carries the symbol too and the check
  // reads the line rather than counting it.
  const anchors = readAnchors(sidecar);
  const usedAnchors = new Set();

  // --- Forward: every cited file:line resolves to a real, non-blank line.
  for (const c of citations) {
    const target = join(root, c.path);
    if (!existsSync(target) || !statSync(target).isFile()) {
      fail(
        'register',
        `${REGISTER_DOC}:${c.docLine}`,
        `row ${c.row} cites ${c.path}#L${c.line}, but that file does not exist`,
        `the published claim in ${c.row} no longer has an enforcement point. Re-point the citation, or ` +
          'withdraw the guarantee through §VI with a release note naming what stopped being true (§4.6).',
      );
      continue;
    }
    const lines = readFileSync(target, 'utf-8').split('\n');
    if (c.line > lines.length) {
      fail(
        'register',
        `${REGISTER_DOC}:${c.docLine}`,
        `row ${c.row} cites ${c.path}#L${c.line}, but that file has ${lines.length} lines`,
        `open ${c.path}, find the enforcement point ${c.row} describes, and re-point the citation at it.`,
      );
      continue;
    }
    const cited = lines[c.line - 1] ?? '';
    if (cited.trim() === '') {
      fail(
        'register',
        `${REGISTER_DOC}:${c.docLine}`,
        `row ${c.row} cites ${c.path}#L${c.line}, which is a blank line`,
        `the code moved under the claim. Re-point ${c.row} at the line that now holds the control — this is ` +
          'the exact failure mode G11 survived for a release.',
      );
      continue;
    }

    const key = `${c.row}|${c.path}|${c.line}`;
    const expected = anchors.get(key);
    if (expected === undefined) {
      fail(
        'register',
        `${REGISTER_DOC}:${c.docLine}`,
        `row ${c.row} cites ${c.path}#L${c.line} with no anchor in register_anchors`,
        'add `{ path, line, contains }` under this row in .architecture-state.yaml, naming the symbol or ' +
          'literal the citation is asserting. A line number alone only catches a DELETED enforcement point; ' +
          'the anchor is what catches a MOVED one, which is the same failure wearing a quieter face.',
      );
      continue;
    }
    usedAnchors.add(key);
    if (expected.trim() === '') {
      fail(
        'register',
        '.architecture-state.yaml',
        `register_anchors[${c.row}] has an empty "contains" for ${c.path}#L${c.line}`,
        'an anchor that asserts nothing passes for any line, which is the same as having no anchor. Name the ' +
          'symbol, error token, or condition that IS the enforcement.',
      );
      continue;
    }
    if (!cited.includes(expected)) {
      fail(
        'register',
        `${REGISTER_DOC}:${c.docLine}`,
        `row ${c.row} cites ${c.path}#L${c.line} for ${JSON.stringify(expected)}, but that line reads ` +
          `${JSON.stringify(cited.trim().slice(0, 80))}`,
        `the code moved under the claim: the line still exists but it is no longer the enforcement point ${c.row} ` +
          'describes. Find where the control went, re-point the citation AND its register_anchors entry, and ' +
          'check the claim is still true of the code you found — this is G11, caught early.',
      );
    }
  }

  for (const key of anchors.keys()) {
    if (usedAnchors.has(key)) continue;
    const [row, path, line] = key.split('|');
    fail(
      'register',
      '.architecture-state.yaml',
      `register_anchors[${row}] anchors ${path}#L${line}, which no citation in the register uses`,
      'remove the stale anchor, or restore the citation it was written for. An anchor list that outlives its ' +
        'claims stops being a check and becomes a second thing to keep true.',
    );
  }

  // --- Reverse: every kernel path is published by exactly one register row.
  const citedRows = new Map();
  for (const c of citations) {
    if (!citedRows.has(c.path)) citedRows.set(c.path, new Set());
    citedRows.get(c.path).add(c.row);
  }

  const kernelPaths = [];
  for (const [dir, entry] of Object.entries(sidecar.tiers ?? {})) {
    for (const p of entry?.kernel_paths ?? []) kernelPaths.push({ dir, path: p });
  }

  for (const { dir, path } of kernelPaths) {
    if (!existsSync(join(root, path))) {
      fail(
        'register',
        '.architecture-state.yaml',
        `${dir} lists kernel_path ${path}, which does not exist on disk`,
        'remove the stale kernel_path, or restore the enforcement point it names.',
      );
      continue;
    }
    const rows = citedRows.get(path);
    if (!rows || rows.size === 0) {
      fail(
        'register',
        path,
        'Tier 0 enforcement point is cited by no register row',
        `either publish it — add a guarantee row in ${REGISTER_DOC} whose "Enforced at" field cites ` +
          'this file with a line anchor — or drop it from kernel_paths in .architecture-state.yaml. ' +
          'An enforcement point with no row is an unpublished guarantee (§4.2).',
      );
      continue;
    }
    if (rows.size > 1) {
      fail(
        'register',
        path,
        `Tier 0 enforcement point is cited by ${rows.size} register rows (${[...rows].join(', ')})`,
        'plan §4.2 requires exactly one row per enforcement point, so a reader knows which guarantee owns it. ' +
          'Split the control, or fold the rows.',
      );
    }
  }

  // --- Inverse: a published enforcement point inside a partly-kernel package
  //     must be listed in that package's kernel_paths, or the tier roster and
  //     the register disagree about what the kernel is.
  for (const [dir, entry] of Object.entries(sidecar.tiers ?? {})) {
    const declared = entry?.kernel_paths;
    if (!declared) continue;
    const declaredSet = new Set(declared);
    for (const path of citedRows.keys()) {
      if (!path.startsWith(`${dir}/`)) continue;
      if (declaredSet.has(path)) continue;
      fail(
        'register',
        path,
        `cited by register row(s) ${[...citedRows.get(path)].join(', ')} but absent from ${dir}'s kernel_paths`,
        'the register publishes this file as an enforcement point while the tier roster reads it as Tier 1 ' +
          "by default. Add it to the package's kernel_paths in .architecture-state.yaml, or move the claim " +
          'to a file that is kernel.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 4 — claims ABOUT the register, made outside it (the prose half of G11)
// ---------------------------------------------------------------------------

/**
 * Check 3 ties every claim IN the register to code. Nothing tied the claims
 * ABOUT the register — "ten named guarantees", and the enumeration under it —
 * to the register itself, so two rows were added and both sentences stayed at
 * ten across a release. Same shape as G11: a published statement outliving the
 * thing it described, with nothing mechanical to notice.
 *
 * WHY A MARKER AND NOT A GREP. Extracting "how many guarantees does this
 * sentence claim" from English is a heuristic in both directions: a regex loose
 * enough to catch "a closed list of ten security guarantees" also fires on
 * unrelated numerals, and one tight enough to avoid that misses the next
 * rephrasing — and a check that misses the rewrite is exactly the check that
 * was missing here. So the claim is DECLARED, in the file that makes it, next
 * to the prose that makes it.
 *
 * WHY THE DECLARATION IS NOT ENOUGH ON ITS OWN. A marker alone moves the drift
 * rather than removing it: the marker would track the register while the
 * sentence beside it went stale, which is the bug verbatim. So the tie is
 * three-way and every link is exact — the marker's ids must equal the
 * register's rows in order, and the prose the marker sits on must contain the
 * count the marker implies, plus each name the marker pairs with a row.
 *
 *   <!-- register-claim
 *        ids:   G-TOOLS, G-CAP, …
 *        names: tool allowlist, capability scoping, …
 *   -->
 *   Ethos publishes a closed list of twelve security guarantees …
 *
 * `ids` is required and positional; `names` is optional and, when present,
 * pairs positionally with `ids`, so a reader can audit which phrase stands for
 * which row. The count is never written in the marker — it is the length of
 * `ids`, because a number stated twice is a number that can disagree with
 * itself.
 */

/**
 * Documents that MUST carry a claim marker. Listed rather than discovered,
 * because the absence of a marker is itself a failure mode: a file that lost
 * its marker along with its accuracy would otherwise pass by having nothing
 * left to check. Every other tracked `.md` file is checked opportunistically —
 * a marker anywhere is honoured, so a new page can opt in without editing this
 * list, and only the two mandatory sites need it edited at all.
 */
const REGISTER_CLAIM_DOCS = ['SECURITY.md', 'README.md'];

const CLAIM_MARKER = 'register-claim';

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];

/** A line that starts a new block, and therefore ends the marker's claim. */
const BLOCK_BREAK_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```)/;

/** The register's rows, in document order. `null` when the register is absent. */
function registerRowIds(root) {
  const docPath = join(root, REGISTER_DOC);
  if (!existsSync(docPath)) return null;
  const ids = [];
  for (const line of readFileSync(docPath, 'utf-8').split('\n')) {
    const m = line.match(/^###\s+(G-[A-Z]+)\b/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/**
 * One comma-separated field of a marker body. The value runs to the next known
 * key or the end of the body, so it may wrap across lines — a twelve-item list
 * on one line is unreadable, and an unreadable marker is one nobody checks
 * before editing the sentence beside it.
 */
function claimField(body, key) {
  const re = new RegExp(
    `(?:^|\\n)[ \\t]*${key}[ \\t]*:([\\s\\S]*?)(?=\\n[ \\t]*(?:ids|names)[ \\t]*:|$)`,
  );
  const m = body.match(re);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
}

/**
 * The block the marker sits on: the next non-blank line, plus its continuation
 * lines. It stops at a blank line or at the next block-level construct, so a
 * marker over one bullet claims that bullet and not the list.
 */
function claimTextAfter(lines, firstIdx) {
  let i = firstIdx;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return '';
  const block = [lines[i]];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '' || BLOCK_BREAK_RE.test(lines[j])) break;
    block.push(lines[j]);
  }
  return block.join(' ');
}

function parseClaimMarkers(text) {
  const lines = text.split('\n');
  const out = [];
  const re = /<!--([\s\S]*?)-->/g;
  let m = re.exec(text);
  while (m !== null) {
    const body = m[1].trim();
    if (body.startsWith(CLAIM_MARKER)) {
      // Lines are 1-based; the count of lines up to the marker's end is also
      // the 0-based index of the first line after it.
      const endLine = text.slice(0, m.index + m[0].length).split('\n').length;
      out.push({
        line: text.slice(0, m.index).split('\n').length,
        ids: claimField(body, 'ids'),
        names: claimField(body, 'names'),
        text: claimTextAfter(lines, endLine),
      });
    }
    m = re.exec(text);
  }
  return out;
}

function checkRegisterClaims(ctx) {
  const { root } = ctx;
  const rows = registerRowIds(root);
  if (rows === null) {
    fail(
      'register-claims',
      REGISTER_DOC,
      'the guarantee register does not exist, so no claim about its size or membership can be checked',
      'restore the register. Every claim marker in the repository asserts something about this file; with ' +
        'the file gone, the claims are unfalsifiable rather than true.',
    );
    return;
  }
  if (rows.length === 0) {
    fail(
      'register-claims',
      REGISTER_DOC,
      'the register publishes no `### G-…` rows',
      'a register with no rows makes every claim about it false. Restore the rows, or withdraw the claims ' +
        `in ${REGISTER_CLAIM_DOCS.join(' and ')} through §VI.`,
    );
    return;
  }

  const duplicates = [...new Set(rows.filter((id, i) => rows.indexOf(id) !== i))];
  if (duplicates.length > 0) {
    fail(
      'register-claims',
      REGISTER_DOC,
      `the register publishes ${duplicates.join(', ')} more than once`,
      'give each guarantee exactly one row. A duplicated id makes "how many guarantees are there" ' +
        'unanswerable, which is the question every claim marker asserts an answer to.',
    );
  }

  const expected = rows.join(', ');
  const count = rows.length;
  const word = NUMBER_WORDS[count];
  const countRe = new RegExp(`\\b(?:${word ? `${word}|` : ''}${count})\\b`, 'i');

  const files = new Set(REGISTER_CLAIM_DOCS);
  for (const rel of trackedFiles(root) ?? []) {
    if (!rel.endsWith('.md')) continue;
    if (rel === REGISTER_DOC) continue;
    if (rel.startsWith('plan/')) continue; // plan/ records history, stale counts included
    files.add(rel);
  }

  for (const rel of [...files].sort()) {
    const full = join(root, rel);
    const required = REGISTER_CLAIM_DOCS.includes(rel);
    if (!existsSync(full)) {
      if (required) {
        fail(
          'register-claims',
          rel,
          'this file is required to carry a register claim, and does not exist',
          'restore the file, or drop it from REGISTER_CLAIM_DOCS in scripts/check-architecture.mjs.',
        );
      }
      continue;
    }

    let claims;
    try {
      claims = parseClaimMarkers(readFileSync(full, 'utf-8'));
    } catch {
      continue;
    }

    if (claims.length === 0) {
      if (required) {
        fail(
          'register-claims',
          rel,
          "this file states the register's size or membership and carries no `<!-- register-claim … -->` marker",
          `put the marker on the line above the claim, listing the register's rows in order: ids: ${expected}. ` +
            'Without it the sentence is checked by nobody, which is how "ten named guarantees" survived two ' +
            'guarantees being added.',
        );
      }
      continue;
    }

    for (const c of claims) {
      const where = `${rel}:${c.line}`;

      if (!c.ids) {
        fail(
          'register-claims',
          where,
          'claim marker carries no `ids:` field',
          `list the register's rows in document order: ids: ${expected}. The count is the length of that ` +
            'list and is deliberately not stated separately — a number written twice is a number that can ' +
            'disagree with itself.',
        );
        continue;
      }

      if (c.ids.join(', ') !== expected) {
        const missing = rows.filter((id) => !c.ids.includes(id));
        const unexpected = c.ids.filter((id) => !rows.includes(id));
        const parts = [];
        if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
        if (unexpected.length > 0) {
          parts.push(`names ${unexpected.join(', ')}, which the register does not`);
        }
        if (parts.length === 0) parts.push('same rows, wrong order');
        const detail = parts.join('; ');
        fail(
          'register-claims',
          where,
          `claim marker disagrees with the register — ${detail}; marker says [${c.ids.join(', ')}]`,
          `set ids to the register's rows in document order: ${expected}. Then re-read the sentence below ` +
            'the marker and the names beside it: the marker is what fails the build, but the prose is what a ' +
            'reader believed.',
        );
        continue;
      }

      if (c.text.trim() === '') {
        fail(
          'register-claims',
          where,
          'claim marker sits above no claim',
          'the marker asserts that the text under it describes the register. Put it directly above that ' +
            'text, or remove it — a marker with nothing beneath it checks nothing.',
        );
        continue;
      }

      if (!countRe.test(c.text)) {
        fail(
          'register-claims',
          where,
          `the register has ${count} rows, but the claim under this marker never says ${word ? `"${word}"` : count} — it reads ` +
            `${JSON.stringify(c.text.trim().slice(0, 120))}`,
          `write the count the register actually has (${word ? `"${word}" or ` : ''}${count}). This is the ` +
            'check that catches the marker being updated while the sentence beside it is not, which is the ' +
            'same drift one layer down.',
        );
      }

      if (!c.names) continue;
      if (c.names.length !== c.ids.length) {
        fail(
          'register-claims',
          where,
          `claim marker pairs ${c.ids.length} ids with ${c.names.length} names`,
          'names are positional against ids, so a reader can audit which phrase stands for which row. Give ' +
            'one name per id, or drop the names field.',
        );
        continue;
      }
      const lower = c.text.toLowerCase();
      const absent = c.names.filter((n) => !lower.includes(n.toLowerCase()));
      if (absent.length > 0) {
        fail(
          'register-claims',
          where,
          `the claim under this marker never names ${absent.map((n) => JSON.stringify(n)).join(', ')}`,
          'the marker says the prose enumerates the register; the prose does not. Add the missing ' +
            'guarantees to the sentence — rewrite the clause rather than appending words to it — or change ' +
            'the name to the phrase the sentence actually uses.',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check 5 — exceptions (§VIII)
// ---------------------------------------------------------------------------

const UNOBSERVABLE_RE =
  /\b(best[- ]effort|as needed|when convenient|eventually|someday|tbd|n\/a|ongoing|where possible)\b/i;
const INDEFINITE_RE = /\b(indefinite|further notice|tbd|n\/a|permanent|forever|never)\b/i;
const SAFETY_LAW_RE = /(§\s*V\b|\bS[1-9]\b|safety[- ]constitution)/i;
const LAW11_RE = /(law\s*11|\bL11\b|kernel[- ]guarantee)/i;
const PATTERN_SCOPE_RE = /[*?]|\ball\b|\bevery\b|^layer:|^tier:/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && ISO_DATE_RE.test(value.trim())) {
    const d = new Date(`${value.trim()}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function checkExceptions(ctx) {
  const { rules, sidecar, today } = ctx;
  const policy = rules.exception_policy ?? {};
  const required = policy.required_fields ?? [];
  const forbidden = new Set(policy.forbidden_shapes ?? []);
  const list = sidecar.exceptions ?? [];

  if (!Array.isArray(list)) {
    fail(
      'exceptions',
      '.architecture-state.yaml',
      'exceptions: is not a list',
      'write `exceptions: []` when there are none. Empty is the correct state (§VIII).',
    );
    return;
  }

  const seen = new Set();
  list.forEach((ex, idx) => {
    const id = ex?.id ?? `exceptions[${idx}]`;
    const where = `.architecture-state.yaml exceptions[${idx}] (${id})`;

    if (typeof ex !== 'object' || ex === null) {
      fail(
        'exceptions',
        where,
        'exception entry is not a mapping',
        'give it the eight §VIII fields.',
      );
      return;
    }
    if (seen.has(id)) {
      fail(
        'exceptions',
        where,
        `duplicate exception id "${id}"`,
        'validator output references exceptions by id; two entries sharing one id make that reference ambiguous.',
      );
    }
    seen.add(id);

    for (const field of required) {
      const v = ex[field];
      if (v === undefined || v === null || String(v).trim() === '') {
        fail(
          'exceptions',
          where,
          `missing required field "${field}"`,
          `§VIII requires all of [${required.join(', ')}]. An entry missing one is a violation, not an exception.`,
        );
      }
    }

    const reviewBy = asDate(ex.review_by);
    if (forbidden.has('indefinite_term')) {
      if (ex.review_by !== undefined && !reviewBy) {
        fail(
          'exceptions',
          where,
          `review_by ${JSON.stringify(ex.review_by)} is not an ISO-8601 date`,
          'an exception with no parseable end date is an indefinite exception, which §VIII forbids outright.',
        );
      }
      if (typeof ex.review_by === 'string' && INDEFINITE_RE.test(ex.review_by)) {
        fail(
          'exceptions',
          where,
          `review_by reads as indefinite: ${JSON.stringify(ex.review_by)}`,
          'set a date. "Until further notice" is the shape §VIII names first.',
        );
      }
    }

    if (forbidden.has('missing_owner') && !String(ex.owner ?? '').trim()) {
      fail(
        'exceptions',
        where,
        'no named owner',
        "name the maintainer responsible for removal. An unowned exception is nobody's to close.",
      );
    }

    if (forbidden.has('unobservable_removal_condition')) {
      const cond = String(ex.removal_condition ?? '');
      if (cond.trim() === '' || UNOBSERVABLE_RE.test(cond)) {
        fail(
          'exceptions',
          where,
          `removal_condition is not observable: ${JSON.stringify(ex.removal_condition ?? null)}`,
          'state the condition someone else could check without asking you — a test that passes, a module ' +
            'that is deleted, a version that ships.',
        );
      }
    }

    const law = String(ex.law ?? '');
    if (forbidden.has('safety_constitution_carve_out') && SAFETY_LAW_RE.test(law)) {
      fail(
        'exceptions',
        where,
        `exception targets a §V Safety Constitution rule (law: ${JSON.stringify(ex.law)})`,
        'safety rules are amended through §VI or not at all. There is no exception path.',
      );
    }
    if (forbidden.has('kernel_guarantee_carve_out') && LAW11_RE.test(law)) {
      fail(
        'exceptions',
        where,
        `exception targets Law 11 (law: ${JSON.stringify(ex.law)})`,
        'an exception permitting a module outside the kernel to weaken a kernel guarantee is the violation ' +
          'Law 11 names. Fix the kernel instead.',
      );
    }

    const scope = String(ex.scope ?? '');
    if (forbidden.has('pattern_wide_scope') && PATTERN_SCOPE_RE.test(scope)) {
      fail(
        'exceptions',
        where,
        `scope is pattern-wide: ${JSON.stringify(ex.scope)}`,
        'narrow it to a single path, module, or symbol. A pattern-wide exception is a law change, not an exception.',
      );
    }

    // Tier 0 has no exception path at all (tier contract, §2.4 / §VIII).
    if (forbidden.has('kernel_guarantee_carve_out') && scope) {
      for (const [dir, entry] of Object.entries(sidecar.tiers ?? {})) {
        if (entry?.tier !== 0) continue;
        if (scope === dir || scope.startsWith(`${dir}/`)) {
          fail(
            'exceptions',
            where,
            `scope ${JSON.stringify(scope)} lands inside ${dir}, which is Tier 0`,
            'no Tier 0 package is eligible for a §VIII exception. Either the code changes or the guarantee ' +
              'is withdrawn through §VI.',
          );
        }
      }
    }

    if (reviewBy && policy.expiry?.on_review_by_passed === 'surface_as_violation') {
      if (reviewBy.getTime() < today.getTime()) {
        fail(
          'exceptions',
          where,
          `review_by ${reviewBy.toISOString().slice(0, 10)} has passed`,
          'an expired exception is a violation, not an exception. §VIII: there is no automatic renewal and no ' +
            'permanent-grandfather list. Re-justify it in a renewal PR, or remove the carve-out.',
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Check 6 — stale kernel-path references (G10)
// ---------------------------------------------------------------------------

function checkStalePaths(ctx) {
  const { root } = ctx;
  // Built by concatenation so this file and its test never match themselves.
  const needle = `extensions/${'safety-'}`;

  const tracked = trackedFiles(root);
  if (tracked === null) {
    fail(
      'stale-paths',
      root,
      'could not list tracked files (git ls-files failed)',
      'this check reads the git index; run it inside a git checkout.',
    );
    return;
  }

  for (const rel of tracked) {
    if (rel.startsWith('plan/')) continue; // plan/ records history, dead paths included
    if (rel === 'pnpm-lock.yaml') continue;
    if (!TEXT_EXT.test(rel) && !TEXT_EXT.test(basename(rel))) continue;
    const full = join(root, rel);
    if (!existsSync(full)) continue; // deleted but still indexed
    let text;
    try {
      text = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    if (!text.includes(needle)) continue;
    text.split('\n').forEach((line, i) => {
      if (!line.includes(needle)) return;
      fail(
        'stale-paths',
        `${rel}:${i + 1}`,
        `references ${needle}*, a directory tree that no longer exists`,
        'the safety packages moved to packages/safety/*. Re-point the reference. A link into a deleted ' +
          'tree reads as a live control to anyone auditing the docs (G10).',
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(only) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warn');

  if (errors.length === 0 && warnings.length === 0) return 0;

  const groups = new Map();
  for (const f of findings) {
    if (!groups.has(f.check)) groups.set(f.check, []);
    groups.get(f.check).push(f);
  }

  const out = [];
  out.push('');
  out.push('architecture validator — ARCHITECTURE.md §IX + .architecture-state.yaml');
  out.push('');

  for (const check of CHECKS) {
    if (only && !only.has(check)) continue;
    const group = groups.get(check);
    if (!group) continue;
    const e = group.filter((f) => f.severity === 'error').length;
    const w = group.length - e;
    const mark = e > 0 ? '✗' : '!';
    out.push(
      `${mark} ${check} — ${e} violation${e === 1 ? '' : 's'}${w > 0 ? `, ${w} advisory` : ''}`,
    );
    out.push('');

    // One copy of each remedy, referenced by number. Sixty findings sharing one
    // fix should print that fix once; a repeated wall of identical prose is how
    // a check stops being read.
    const notes = [];
    const noteOf = (fix) => {
      let i = notes.indexOf(fix);
      if (i === -1) i = notes.push(fix) - 1;
      return i + 1;
    };
    const rolled = new Map();
    const singles = [];
    for (const f of group.filter((x) => x.severity === 'error')) singles.push(f);
    for (const f of group.filter((x) => x.severity === 'warn')) {
      if (!f.roll) {
        singles.push(f);
        continue;
      }
      const key = `${f.where}|${f.roll.label}|${f.fix}`;
      if (!rolled.has(key)) rolled.set(key, { ...f, subjects: [] });
      rolled.get(key).subjects.push(f.roll.subject);
    }

    for (const f of singles) {
      out.push(`  ${f.severity === 'error' ? '·' : '~'} ${f.where}  [${noteOf(f.fix)}]`);
      out.push(`      ${f.what}`);
    }
    for (const f of rolled.values()) {
      out.push(`  ~ ${f.where}  [${noteOf(f.fix)}]`);
      const label = `${f.roll.label} (${f.subjects.length}): ${f.subjects.sort().join(', ')}`;
      for (const l of wrap(label, 92)) out.push(`      ${l}`);
    }
    out.push('');
    notes.forEach((fix, i) => {
      const lines = wrap(fix, 92);
      out.push(`  [${i + 1}] ${lines[0]}`);
      for (const l of lines.slice(1)) out.push(`      ${l}`);
      out.push('');
    });
  }

  out.push(
    `${errors.length} violation${errors.length === 1 ? '' : 's'}, ` +
      `${warnings.length} advisory finding${warnings.length === 1 ? '' : 's'}.`,
  );
  if (warnings.length > 0) {
    out.push(
      'Advisory findings do not fail this check; each prints what would make it enforceable.',
    );
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return errors.length > 0 ? 1 : 0;
}

function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width && line !== '') {
      lines.push(line);
      line = w;
    } else {
      line = line === '' ? w : `${line} ${w}`;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { only: null, sidecar: null, architecture: null, root: null, unenforced: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') args.only = new Set(argv[++i].split(',').map((s) => s.trim()));
    else if (a === '--sidecar') args.sidecar = argv[++i];
    else if (a === '--architecture') args.architecture = argv[++i];
    else if (a === '--root') args.root = argv[++i];
    else if (a === '--unenforced') args.unenforced = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.only) {
    for (const c of args.only) {
      if (!CHECKS.includes(c)) throw new Error(`unknown check: ${c} (known: ${CHECKS.join(', ')})`);
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(args.root ?? join(here, '..'));
  const archPath = resolve(args.architecture ?? join(root, 'ARCHITECTURE.md'));
  const rules = parseRulesBlock(readFileSync(archPath, 'utf-8'));
  const sidecarPath = resolve(
    args.sidecar ?? join(root, rules.state_sidecar ?? '.architecture-state.yaml'),
  );
  const sidecar = YAML.parse(readFileSync(sidecarPath, 'utf-8')) ?? {};

  const ctx = { root, rules, sidecar, today: new Date(new Date().toISOString().slice(0, 10)) };
  const run = (name, fn) => {
    if (args.only && !args.only.has(name)) return;
    fn(ctx);
  };

  run('tiers', checkTiers);
  run('layers', checkLayers);
  run('register', checkRegister);
  run('register-claims', checkRegisterClaims);
  run('exceptions', checkExceptions);
  run('stale-paths', checkStalePaths);

  const code = report(args.only);

  if (args.unenforced) reportUnenforcedRules(ctx);
  if (args.unenforced && unenforced.length > 0) {
    const out = ['', 'Declared in §IX but NOT enforced mechanically by this validator:', ''];
    for (const u of unenforced) {
      out.push(`  · ${u.rule}`);
      for (const l of wrap(u.why, 92)) out.push(`      ${l}`);
      out.push('');
    }
    process.stdout.write(`${out.join('\n')}\n`);
  }
  return code;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`architecture validator failed to run: ${err.message}\n`);
    process.exit(2);
  }
}

export { findings, main };
