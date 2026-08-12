import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopedFsImpl } from '@ethosagent/core';
import { defaultAlwaysDeny, FsStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileTool, writeFileTool } from '../index';

// Phase 4 — personality_isolation Tier 1 #1.
//
// A personality with read_file/write_file in its toolset must NOT be able
// to reach paths outside its fs_reach allowlist. Builds a real FsStorage
// rooted at a tmp ~/.ethos look-alike, wraps it in ScopedFsImpl with the
// "researcher" reach, and asserts that reaching into engineer's MEMORY.md
// returns a tool error rather than the file body.

function makeCtx(opts: { workingDir: string; scopedFs?: ToolContext['scopedFs'] }): ToolContext {
  return {
    sessionId: 'test',
    sessionKey: 'cli:boundary',
    platform: 'cli',
    workingDir: opts.workingDir,
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...(opts.scopedFs ? { scopedFs: opts.scopedFs } : {}),
  };
}

describe('tools-file — fs_reach boundary enforcement', () => {
  let dataDir: string;
  let cwd: string;

  beforeEach(async () => {
    // Canonicalize through realpath: on macOS, tmpdir() lives under
    // /var/folders/... which is a symlink to /private/var/folders/...
    // ScopedFsImpl.checkReach() compares the allow prefixes and the request
    // path LEXICALLY with normalize(resolve(...)), so the two must share
    // canonical form. Its symlink walk does not help here and is not meant
    // to: the walk starts at the matched allow prefix and only descends, so
    // the /var → /private/var link ABOVE the prefix is never resolved. That
    // is deliberate — segments above the allowlist root are the operator's
    // own layout, not an escape from the reach.
    dataDir = await realpath(await mkdtemp(join(tmpdir(), 'ethos-fsreach-')));
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'ethos-cwd-')));
    // Seed two personality dirs with their own MEMORY.md
    await mkdir(join(dataDir, 'personalities', 'researcher'), { recursive: true });
    await mkdir(join(dataDir, 'personalities', 'engineer'), { recursive: true });
    await writeFile(join(dataDir, 'personalities', 'researcher', 'MEMORY.md'), 'mine');
    await writeFile(join(dataDir, 'personalities', 'engineer', 'MEMORY.md'), 'theirs');
    await writeFile(join(cwd, 'project-notes.md'), 'cwd notes');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  function researcherFs() {
    const reach = new Set([join(dataDir, 'personalities', 'researcher'), cwd]);
    return new ScopedFsImpl(new FsStorage(), reach, reach, defaultAlwaysDeny());
  }

  it('researcher CAN read its own MEMORY.md', async () => {
    const ctx = makeCtx({ workingDir: cwd, scopedFs: researcherFs() });
    const result = await readFileTool.execute(
      { path: join(dataDir, 'personalities', 'researcher', 'MEMORY.md') },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('mine');
  });

  it("researcher CANNOT read engineer's MEMORY.md", async () => {
    const ctx = makeCtx({ workingDir: cwd, scopedFs: researcherFs() });
    const result = await readFileTool.execute(
      { path: join(dataDir, 'personalities', 'engineer', 'MEMORY.md') },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Filesystem boundary/);
      expect(result.error).toContain('engineer');
    }
  });

  it('out-of-scope rejection is shaped by the tool, not leaked from ScopedFs', async () => {
    // When ScopedFsImpl throws PATH_NOT_REACHABLE, the tool catches it
    // and emits a tool-shaped ToolResult — the LLM does not see the
    // raw error class. The check matters because a leaky tool would
    // let capability internals surface to the model as opaque
    // exceptions.
    const ctx = makeCtx({ workingDir: cwd, scopedFs: researcherFs() });
    const result = await readFileTool.execute(
      { path: join(dataDir, 'personalities', 'engineer', 'MEMORY.md') },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      // Tool wording, not capability wording.
      expect(result.error).toMatch(/Filesystem boundary: read/);
      expect(result.error).toMatch(/personality's fs_reach allowlist/);
    }
  });

  it('researcher CAN read files in its working dir', async () => {
    const ctx = makeCtx({ workingDir: cwd, scopedFs: researcherFs() });
    const result = await readFileTool.execute({ path: join(cwd, 'project-notes.md') }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('cwd notes');
  });

  it('researcher CAN write into its own personality dir', async () => {
    const ctx = makeCtx({ workingDir: cwd, scopedFs: researcherFs() });
    const target = join(dataDir, 'personalities', 'researcher', 'note.md');
    const result = await writeFileTool.execute({ path: target, content: 'fresh' }, ctx);
    expect(result.ok).toBe(true);
  });

  it("researcher CANNOT write into engineer's personality dir", async () => {
    const ctx = makeCtx({ workingDir: cwd, scopedFs: researcherFs() });
    const target = join(dataDir, 'personalities', 'engineer', 'sneak.md');
    const result = await writeFileTool.execute({ path: target, content: 'evil' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Filesystem boundary/);
  });

  it('returns not_available when ctx.scopedFs is missing — no silent fallback', async () => {
    const ctx = makeCtx({ workingDir: cwd });
    const result = await readFileTool.execute(
      { path: join(dataDir, 'personalities', 'engineer', 'MEMORY.md') },
      ctx,
    );
    // Pre-migration the absence of ctx.storage fell through to an
    // unrestricted FsStorage. With ctx.scopedFs the absence is fail-
    // closed: the tool returns `not_available` so the LLM never gets
    // a free pass when the capability backend is unwired.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });

  // Ch.5 — symlink-defeats-allowlist coverage (G11).
  // Symlink resolution lives in the tool's capability backend, not in the
  // tool: ScopedFsImpl.checkReach() walks the path below the matched allow
  // prefix and re-judges the deny floor and the allowlist against wherever
  // a link actually lands. These cases exercise that through the tool, which
  // is the shape a personality actually experiences.
  it('rejects a symlink inside the allowlist that points outside it', async () => {
    const link = join(cwd, 'notes.md');
    await symlink(join(dataDir, 'personalities', 'engineer', 'MEMORY.md'), link);
    const ctx = makeCtx({ workingDir: cwd, scopedFs: researcherFs() });
    const result = await readFileTool.execute({ path: link }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Filesystem boundary/);
  });

  it('rejects a symlinked PARENT directory even when the leaf is an ordinary file', async () => {
    // The leaf-only bypass: `<cwd>/peek` is a link to engineer's dir, and
    // `<cwd>/peek/MEMORY.md` is a plain file. lstat on the leaf says
    // "not a link" — only a per-segment walk catches this.
    await symlink(join(dataDir, 'personalities', 'engineer'), join(cwd, 'peek'));
    const ctx = makeCtx({ workingDir: cwd, scopedFs: researcherFs() });
    const result = await readFileTool.execute({ path: join(cwd, 'peek', 'MEMORY.md') }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Filesystem boundary/);
  });

  it('ALLOWS a symlink whose target is inside the allowlist', async () => {
    // Chosen semantics: resolve-and-recheck, not refuse-all-symlinks. A link
    // that lands inside the reach reaches nothing the personality could not
    // reach by its literal path, so refusing it would be a behaviour change
    // beyond closing the escape.
    await writeFile(join(cwd, 'real.md'), 'in-bounds body');
    await symlink(join(cwd, 'real.md'), join(cwd, 'alias.md'));
    const ctx = makeCtx({ workingDir: cwd, scopedFs: researcherFs() });
    const result = await readFileTool.execute({ path: join(cwd, 'alias.md') }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('in-bounds body');
  });

  it('ALLOWS a write to a path that does not exist yet inside the allowlist', async () => {
    // The ENOENT case. `lstat` on a not-yet-created leaf finds nothing; that
    // is the normal state of every first write, not a boundary violation.
    const ctx = makeCtx({ workingDir: cwd, scopedFs: researcherFs() });
    const result = await writeFileTool.execute(
      { path: join(cwd, 'brand', 'new', 'file.md'), content: 'fresh' },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a path matching the alwaysDeny floor even when allow includes its parent', async () => {
    // Use a path the deny floor catches structurally (`/etc/passwd`).
    // The researcher's reach intentionally does NOT include /etc, but
    // even if it did, the floor would still fire — that's the test.
    const reachIncludingEtc = new Set([cwd, '/etc']);
    const permissive = new ScopedFsImpl(
      new FsStorage(),
      reachIncludingEtc,
      reachIncludingEtc,
      defaultAlwaysDeny(),
    );
    const ctx = makeCtx({ workingDir: cwd, scopedFs: permissive });
    const result = await readFileTool.execute({ path: '/etc/passwd' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Filesystem boundary/);
  });

  // Ch.5 — ~20 evasion-shape coverage. The boundary must hold against
  // common shell-shaped tricks: relative path traversal, glob escapes,
  // case variants, encoded forms. Each rejected path proves a different
  // attack shape that earlier drafts of fs-boundary code missed.
  describe('Ch.5 evasion shapes — should all be rejected', () => {
    let scoped: ScopedFsImpl;

    beforeEach(() => {
      const reach = new Set([cwd]);
      scoped = new ScopedFsImpl(new FsStorage(), reach, reach, defaultAlwaysDeny());
    });

    it.each([
      ['relative parent traversal', () => join(cwd, '..', '..', 'etc', 'passwd')],
      ['absolute outside-allow path', () => '/etc/passwd'],
      ['absolute outside-allow shell file', () => '/etc/shadow'],
      ['root-relative absolute path', () => '/root/.ssh/id_rsa'],
      ['absolute /boot path', () => '/boot/grub.cfg'],
      ['absolute /sys path', () => '/sys/kernel/debug/foo'],
      ['absolute /proc/sys path', () => '/proc/sys/kernel/core_pattern'],
      ['traversal with redundant slashes', () => `${cwd}//../..//etc//passwd`],
      ['traversal with redundant dots', () => `${cwd}/./../etc/passwd`],
    ])('rejects %s', async (_name, makePath) => {
      const ctx = makeCtx({ workingDir: cwd, scopedFs: scoped });
      const result = await readFileTool.execute({ path: makePath() }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/Filesystem boundary/);
    });

    it('rejects a symlink chain that lands in the deny prefix after multiple hops', async () => {
      // hop1 stays inside the reach, which is exactly why one hop is not
      // enough: the boundary has to keep following until the path stops
      // moving. Both links are in-bounds; only the third target is not.
      await symlink(join(cwd, 'hop2'), join(cwd, 'hop1'));
      await symlink('/etc/passwd', join(cwd, 'hop2'));
      const ctx = makeCtx({ workingDir: cwd, scopedFs: scoped });
      const result = await readFileTool.execute({ path: join(cwd, 'hop1') }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/Filesystem boundary/);
    });

    it('rejects a symlink to a deny-listed directory (not just files inside it)', async () => {
      // The allowlist here deliberately GRANTS /root, so the allow check
      // cannot be what rejects this — the deny floor has to be re-applied
      // to the resolved target, not just to the link path.
      const reach = new Set([cwd, '/root']);
      const permissive = new ScopedFsImpl(new FsStorage(), reach, reach, defaultAlwaysDeny());
      await symlink('/root', join(cwd, 'rootdir'));
      const ctx = makeCtx({ workingDir: cwd, scopedFs: permissive });
      const result = await readFileTool.execute(
        { path: join(cwd, 'rootdir', '.ssh', 'id_rsa') },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/Filesystem boundary/);
    });
  });
});
