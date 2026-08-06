#!/usr/bin/env bash
# Verify every bare npm module bundled into the CLI is declared in
# apps/ethos/package.json dependencies/optionalDependencies.
#
# tsup bundles all @ethosagent/* workspace internals INTO apps/ethos/dist
# (see apps/ethos/tsup.config.ts) while externalizing bare modules — so any
# bare import in any bundled workspace source becomes a runtime require of
# the CLI package. If it isn't declared there, a fresh `npm install
# @ethosagent/cli` breaks at startup with ERR_MODULE_NOT_FOUND (dev hides
# this via pnpm workspace hoisting). This gate walks the workspace import
# graph from apps/ethos/src and fails on any undeclared external module.
# Called by: scripts/run-checks.sh (blocking); local devs via `make bundle-deps`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

exec node --input-type=module - <<'EOF'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { builtinModules } from 'node:module';

// Kept external by tsup on purpose (published separately for plugin authors);
// they are real dependencies of apps/ethos, not bundled sources to walk into.
const EXTERNAL_WORKSPACE = new Set(['@ethosagent/core', '@ethosagent/types']);

// False-positive allowlist — bare specifiers matched by the import regex that
// are NOT runtime requirements of the published CLI bundle. One justification per entry.
const ALLOWLIST = new Set([
  // antd: imported only by packages/design-tokens/src/antd.ts — a subpath entry
  // ('@ethosagent/design-tokens/antd') consumed solely by apps/web, tree-shaken
  // out of the CLI bundle (no `from "antd"` in dist), and declared as an
  // optional peerDependency of design-tokens. The walk is package-granular so
  // it can't see that this one file is unreachable from the CLI entry.
  'antd',
]);

const builtins = new Set(builtinModules.flatMap((m) => [m, m.replace(/^node:/, '')]));

// Map workspace package name -> src dir.
const srcDirs = new Map();
for (const group of ['packages', 'extensions', 'apps']) {
  if (!existsSync(group)) continue;
  for (const entry of readdirSync(group)) {
    const pkgJson = join(group, entry, 'package.json');
    if (!existsSync(pkgJson)) continue;
    const name = JSON.parse(readFileSync(pkgJson, 'utf8')).name;
    const src = join(group, entry, 'src');
    if (name && existsSync(src)) srcDirs.set(name, src);
  }
}

const sourceFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

// Extract bare import specifiers from one file (static, side-effect, dynamic, require).
const specifiers = (file) => {
  // Type-only imports are erased by tsup — they never reach the bundle.
  const code = readFileSync(file, 'utf8')
    .replace(/\b(?:import|export)\s+type\b[\s\S]{0,500}?from\s*["'][^"']*["']/g, '');
  const found = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /^\s*import\s+["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) found.push(m[1]);
  }
  return found;
};

// Normalize "@scope/pkg/deep" -> "@scope/pkg", "pkg/deep" -> "pkg".
// Returns null for relative paths and anything that isn't a valid npm specifier
// (prose inside strings that happens to follow the word "from").
const toModuleName = (spec) => {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  const m = spec.match(/^(@[a-z0-9-~][\w.-]*\/[a-z0-9-~][\w.-]*|[a-z0-9-~][\w.-]*)(\/|$)/);
  return m ? m[1] : null;
};

// BFS the workspace graph from the CLI entry package.
const queue = ['@ethosagent/cli'];
const visited = new Set();
const external = new Map(); // module -> first file seen in
while (queue.length > 0) {
  const pkg = queue.shift();
  if (visited.has(pkg)) continue;
  visited.add(pkg);
  const src = srcDirs.get(pkg);
  if (!src) continue;
  for (const file of sourceFiles(src)) {
    for (const spec of specifiers(file)) {
      const name = toModuleName(spec);
      if (!name || builtins.has(name) || builtins.has(spec)) continue;
      if (name.startsWith('@ethosagent/')) {
        if (!EXTERNAL_WORKSPACE.has(name)) queue.push(name); // bundled — walk into it
      } else if (!external.has(name)) {
        external.set(name, file);
      }
    }
  }
}

const cliPkg = JSON.parse(readFileSync('apps/ethos/package.json', 'utf8'));
const declared = new Set([
  ...Object.keys(cliPkg.dependencies ?? {}),
  ...Object.keys(cliPkg.optionalDependencies ?? {}),
]);

const missing = [...external.entries()]
  .filter(([name]) => !declared.has(name) && !ALLOWLIST.has(name))
  .sort(([a], [b]) => a.localeCompare(b));

if (missing.length > 0) {
  console.error('BUNDLE-DEPS: bare modules bundled into the CLI but not declared in');
  console.error('apps/ethos/package.json dependencies/optionalDependencies:');
  for (const [name, file] of missing) {
    console.error(`  ${name}  (imported in ${file})`);
  }
  console.error('');
  console.error('A fresh npm install of @ethosagent/cli will crash with ERR_MODULE_NOT_FOUND.');
  console.error('Fix: add the module (same semver range as the declaring workspace package)');
  console.error('to apps/ethos/package.json, or allowlist it here with a justification.');
  process.exit(1);
}

console.log(
  `All ${external.size} bundled external modules declared (walked ${visited.size} workspace packages).`,
);
EOF
