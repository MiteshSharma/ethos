import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** How many levels to walk up from `baseDir` looking for the monorepo root. */
const MAX_WORKSPACE_WALK_LEVELS = 12;

/**
 * Walk up from `baseDir` looking for a monorepo root — a directory holding both
 * `pnpm-workspace.yaml` and a `skills/` catalog. A published npm package has no
 * `pnpm-workspace.yaml`, so this only ever matches a source checkout.
 */
function findWorkspaceCatalogDir(baseDir: string): string | undefined {
  let dir = baseDir;
  for (let i = 0; i < MAX_WORKSPACE_WALK_LEVELS; i++) {
    const catalog = join(dir, 'skills');
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(catalog)) return catalog;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Resolve the system skills catalog directory relative to the running code.
 * `ETHOS_SKILLS_CATALOG_DIR` overrides everything. Otherwise:
 *   - In a source checkout, the repo-root `skills/` found by walking up to the
 *     workspace root. This must win: `apps/ethos/skills` is a gitignored
 *     `copy-skills` build artifact that `pnpm dev` never refreshes, so a stale
 *     snapshot would otherwise shadow the live catalog.
 *   - Otherwise (published package) tries, in order:
 *     - `<baseDir>/../skills` — packaged build (tsup bundles to `<pkg>/dist/index.js`,
 *       prebuild ships the catalog at `<pkg>/skills`)
 *     - `<baseDir>/../../skills` — packaged layout with unbundled commands dir
 *     - `<baseDir>/../../../../skills` — `<pkg>/src/commands` → `<pkg>/skills`
 * Returns the first candidate that exists, or undefined (with a one-line
 * warning naming the tried candidates and the env override).
 */
export function resolveSkillsCatalogDir(
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.ETHOS_SKILLS_CATALOG_DIR) return env.ETHOS_SKILLS_CATALOG_DIR;
  const workspaceCatalog = findWorkspaceCatalogDir(baseDir);
  if (workspaceCatalog) return workspaceCatalog;
  const candidates = [
    join(baseDir, '..', 'skills'),
    join(baseDir, '..', '..', 'skills'),
    join(baseDir, '..', '..', '..', '..', 'skills'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  console.warn(
    `[serve] skills catalog not found (tried: ${candidates.join(', ')}) — set ETHOS_SKILLS_CATALOG_DIR to override.`,
  );
  return undefined;
}
