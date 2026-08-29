import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSkillsCatalogDir } from '../lib/resolve-skills-catalog-dir';

describe('resolveSkillsCatalogDir', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ethos-skills-catalog-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('resolves the packaged layout: <pkg>/dist → <pkg>/skills', () => {
    const pkg = makeTempDir();
    mkdirSync(join(pkg, 'dist'));
    mkdirSync(join(pkg, 'skills', 'dummy-skill'), { recursive: true });

    expect(resolveSkillsCatalogDir(join(pkg, 'dist'), {})).toBe(join(pkg, 'skills'));
  });

  it('resolves the dev layout: <repo>/apps/ethos/src/commands → <repo>/skills', () => {
    const repo = makeTempDir();
    const commandsDir = join(repo, 'apps', 'ethos', 'src', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    mkdirSync(join(repo, 'skills'));

    expect(resolveSkillsCatalogDir(commandsDir, {})).toBe(join(repo, 'skills'));
  });

  it('prefers ETHOS_SKILLS_CATALOG_DIR over existing candidates', () => {
    const pkg = makeTempDir();
    mkdirSync(join(pkg, 'dist'));
    mkdirSync(join(pkg, 'skills'));

    const override = join(pkg, 'custom-catalog');
    expect(resolveSkillsCatalogDir(join(pkg, 'dist'), { ETHOS_SKILLS_CATALOG_DIR: override })).toBe(
      override,
    );
  });

  it('prefers ETHOS_SKILLS_CATALOG_DIR over a source-checkout workspace root', () => {
    const repo = makeTempDir();
    const commandsDir = join(repo, 'apps', 'ethos', 'src', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    mkdirSync(join(repo, 'skills'));
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');

    const override = join(repo, 'custom-catalog');
    expect(resolveSkillsCatalogDir(commandsDir, { ETHOS_SKILLS_CATALOG_DIR: override })).toBe(
      override,
    );
  });

  it('resolves the repo-root catalog even when a stale apps/ethos/skills artifact exists', () => {
    const repo = makeTempDir();
    const commandsDir = join(repo, 'apps', 'ethos', 'src', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    mkdirSync(join(repo, 'skills'));
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    // The gitignored `copy-skills` build artifact — never refreshed by `pnpm dev`.
    mkdirSync(join(repo, 'apps', 'ethos', 'skills'));

    expect(
      resolveSkillsCatalogDir(commandsDir, {}),
      'a stale apps/ethos/skills build artifact must not shadow the live repo-root catalog',
    ).toBe(join(repo, 'skills'));
  });

  it('resolves the packaged layout when no workspace root is present', () => {
    const pkg = makeTempDir();
    mkdirSync(join(pkg, 'dist'));
    mkdirSync(join(pkg, 'skills'));

    expect(resolveSkillsCatalogDir(join(pkg, 'dist'), {})).toBe(join(pkg, 'skills'));
  });

  it('returns undefined and warns when no candidate exists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const empty = makeTempDir();

    expect(resolveSkillsCatalogDir(join(empty, 'dist'), {})).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('ETHOS_SKILLS_CATALOG_DIR');
  });
});
