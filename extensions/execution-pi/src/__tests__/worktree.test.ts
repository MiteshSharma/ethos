// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${ETHOS_HOME}` in a
// test name is an fs_reach substitution token, not a JS template.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertWorkspaceInReach,
  type CommandRunner,
  piWorkspacePaths,
  prepareWorkspace,
  spawnCapture,
  WorkspaceOutOfReachError,
} from '../worktree';

const JOB = 'job-1234';
const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-worktree-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('piWorkspacePaths', () => {
  it('puts the run under ${ETHOS_HOME}/worktrees keyed by job id', () => {
    const paths = piWorkspacePaths('/home/u/.ethos', JOB);
    expect(paths).toEqual({
      root: '/home/u/.ethos/worktrees',
      workspace: '/home/u/.ethos/worktrees/job-1234',
      sessionDir: '/home/u/.ethos/worktrees/job-1234.session',
    });
  });

  it('keeps the session store OUT of the worktree so the run diff stays clean', () => {
    const paths = piWorkspacePaths('/home/u/.ethos', JOB);
    expect(paths.sessionDir.startsWith(`${paths.workspace}/`)).toBe(false);
    // ...while still sitting under the one prefix a personality has to declare.
    expect(paths.sessionDir.startsWith(`${paths.root}/`)).toBe(true);
  });

  it('gives two jobs two workspaces — a run never shares a tree', () => {
    const a = piWorkspacePaths('/home/u/.ethos', 'a');
    const b = piWorkspacePaths('/home/u/.ethos', 'b');
    expect(a.workspace).not.toBe(b.workspace);
  });
});

describe('assertWorkspaceInReach', () => {
  const workspace = '/home/u/.ethos/worktrees/job-1234';

  it('accepts a workspace under a declared reach entry', () => {
    expect(() =>
      assertWorkspaceInReach('scribe', workspace, ['/home/u/.ethos/worktrees/']),
    ).not.toThrow();
  });

  it('refuses when the personality never declared the worktrees root', () => {
    expect(() =>
      assertWorkspaceInReach('scribe', workspace, ['/home/u/.ethos/personalities/scribe/']),
    ).toThrow(WorkspaceOutOfReachError);
  });

  it('names the entry the operator has to add', () => {
    expect(() => assertWorkspaceInReach('scribe', workspace, [])).toThrow(/fs_reach\.write/);
  });

  it('does not accept a sibling directory that merely shares a prefix string', () => {
    // `/home/u/.ethos/worktrees-public` must not satisfy `/home/u/.ethos/worktrees`.
    expect(() =>
      assertWorkspaceInReach('scribe', '/home/u/.ethos/worktrees-public/x', [
        '/home/u/.ethos/worktrees',
      ]),
    ).toThrow(WorkspaceOutOfReachError);
  });
});

describe('prepareWorkspace', () => {
  it('creates a real git worktree when the source workdir is a repository', async () => {
    const repo = tempDir();
    const ethosHome = tempDir();
    const run: CommandRunner = spawnCapture;
    await run('git', ['-C', repo, 'init', '-q']);
    await run('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    await run('git', ['-C', repo, 'config', 'user.name', 'test']);
    writeFileSync(join(repo, 'tracked.txt'), 'original\n');
    await run('git', ['-C', repo, 'add', '.']);
    await run('git', ['-C', repo, 'commit', '-qm', 'init']);

    const paths = piWorkspacePaths(ethosHome, JOB);
    const prepared = await prepareWorkspace(paths, repo);

    expect(prepared.sourceRepo).toBeTruthy();
    // The worktree carries the repo's content but is a separate tree: editing
    // it cannot touch the workdir the job was spawned from.
    expect(readFileSync(join(prepared.workspace, 'tracked.txt'), 'utf-8')).toBe('original\n');
    writeFileSync(join(prepared.workspace, 'tracked.txt'), 'changed\n');
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf-8')).toBe('original\n');
  });

  it('falls back to a fresh empty directory when the workdir is not a repository', async () => {
    const plain = tempDir();
    writeFileSync(join(plain, 'parent.txt'), 'do not share me\n');
    const paths = piWorkspacePaths(tempDir(), JOB);

    const prepared = await prepareWorkspace(paths, plain);

    expect(prepared.sourceRepo).toBeUndefined();
    expect(prepared.workspace).not.toBe(plain);
    // Isolation is the requirement; a repository is not.
    expect(() => readFileSync(join(prepared.workspace, 'parent.txt'), 'utf-8')).toThrow();
  });

  it('reuses an existing workspace, so a Resume lands on the same tree', async () => {
    const paths = piWorkspacePaths(tempDir(), JOB);
    await prepareWorkspace(paths, tempDir());
    writeFileSync(join(paths.workspace, 'partial.txt'), 'work so far\n');

    await prepareWorkspace(paths, tempDir());

    expect(readFileSync(join(paths.workspace, 'partial.txt'), 'utf-8')).toBe('work so far\n');
  });

  it('reports the git failure rather than silently running in an empty directory', async () => {
    const failing: CommandRunner = async (_cmd, args) =>
      args.includes('--show-toplevel')
        ? { code: 0, stdout: '/some/repo\n', stderr: '' }
        : { code: 128, stdout: '', stderr: 'fatal: it already exists' };
    const paths = piWorkspacePaths(tempDir(), JOB);
    await expect(prepareWorkspace(paths, '/some/repo', failing)).rejects.toThrow(
      /git worktree add failed/,
    );
  });
});
