// Raw `node:fs` carve-out (Law 7) — see apps/ethos/src/__tests__/no-raw-fs.test.ts
// and the allowed-exception list in CLAUDE.md. Creating a run's workspace is a
// `git worktree add`: the git binary writes a whole tree, which no Storage
// method can express, and the surrounding mkdir/exists checks are that same
// operation's bookkeeping. Same category as the SQLite stores' mkdirSync of a
// database's parent directory.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Every host path one Pi run owns. Both sit under `${ETHOS_HOME}/worktrees/`. */
export interface PiWorkspacePaths {
  /** `${ETHOS_HOME}/worktrees` — the root a personality's `fs_reach` must cover. */
  root: string;
  /** The run's git worktree. Pi's cwd, and the only writable code path it sees. */
  workspace: string;
  /**
   * Pi's own session storage, a SIBLING of the worktree rather than a directory
   * inside it: a `.pi-session/` inside the worktree would show up in the diff a
   * human reviews, and the whole point of the worktree is that its diff is the
   * run's output. Sibling placement keeps ONE `fs_reach` prefix covering both.
   */
  sessionDir: string;
}

/**
 * D24 — one worktree per run at `${ETHOS_HOME}/worktrees/<jobId>`.
 *
 * The job id (not the label) because it is already guaranteed unique, and
 * `${ETHOS_HOME}` because it composes with the existing `fs_reach` substitution
 * tokens: a personality extends its reach to its runs by declaring
 * `${ETHOS_HOME}/worktrees/`, with no new mechanism to learn.
 */
export function piWorkspacePaths(ethosHome: string, jobId: string): PiWorkspacePaths {
  const root = join(ethosHome, 'worktrees');
  return { root, workspace: join(root, jobId), sessionDir: join(root, `${jobId}.session`) };
}

/** True when `path` equals `prefix` or is nested under it (path-segment safe). */
function isUnder(path: string, prefix: string): boolean {
  const p = resolve(prefix);
  return path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export class WorkspaceOutOfReachError extends Error {
  readonly code = 'WORKSPACE_OUT_OF_REACH';
  constructor(personalityId: string, workspace: string) {
    super(
      `personality '${personalityId}' cannot run this job: its fs_reach does not cover ${workspace}. ` +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: an fs_reach substitution token, not a JS template.
        'Add "${ETHOS_HOME}/worktrees/" to the personality\'s fs_reach.write.',
    );
    this.name = 'WorkspaceOutOfReachError';
  }
}

/**
 * D24's other half: the worktree must be INSIDE the personality's declared
 * reach, not merely somewhere convenient. The green `worktree only` row claims
 * a fact about this personality; a path outside its write reach would make that
 * row a decoration. Refuses loudly and names the entry to add — a silent widen
 * would be exactly the unenforced claim G8 exists to kill.
 */
export function assertWorkspaceInReach(
  personalityId: string,
  workspace: string,
  writeReach: readonly string[],
): void {
  const target = resolve(workspace);
  if (!writeReach.some((entry) => isUnder(target, entry))) {
    throw new WorkspaceOutOfReachError(personalityId, workspace);
  }
}

export interface PreparedWorkspace extends PiWorkspacePaths {
  /** The repository the worktree branched from, when the source workdir was one. */
  sourceRepo?: string;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Default runner — a plain spawn with output captured. Injected for tests. */
export const spawnCapture: CommandRunner = (cmd, args) =>
  new Promise((resolveOut) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('error', (err) => resolveOut({ code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolveOut({ code: code ?? -1, stdout, stderr }));
  });

/**
 * Create the run's workspace before the host is spawned.
 *
 * When the source workdir is a git repository the workspace is a real detached
 * worktree of it, so the run's diff is reviewable against the branch it came
 * from and `git worktree remove` is the undo. When it is not a repository the
 * workspace is a fresh empty directory: isolation is the requirement (sharing
 * the parent workdir is forbidden), and a repository is not.
 *
 * Idempotent — an existing workspace is reused, which is what makes a Resume of
 * the same job id land on the same tree rather than a second copy.
 *
 * KNOWN LIMIT (Phase 2): only the worktree is mounted into the container, so
 * in-container `git` cannot follow the worktree's `.git` FILE back to the parent
 * repository's object store. Pi can read and write files; it cannot commit.
 * Mounting the parent `.git` would hand the run the whole repository and void
 * the `worktree only` claim, so the limit stands until a phase needs commits.
 */
export async function prepareWorkspace(
  paths: PiWorkspacePaths,
  sourceWorkdir: string,
  run: CommandRunner = spawnCapture,
): Promise<PreparedWorkspace> {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.sessionDir, { recursive: true });

  if (existsSync(paths.workspace)) return paths;

  const top = await run('git', ['-C', sourceWorkdir, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    mkdirSync(paths.workspace, { recursive: true });
    return paths;
  }
  const sourceRepo = top.stdout.trim();
  const added = await run('git', [
    '-C',
    sourceRepo,
    'worktree',
    'add',
    '--detach',
    paths.workspace,
  ]);
  if (added.code !== 0) {
    throw new Error(
      `git worktree add failed for ${paths.workspace} (from ${sourceRepo}): ${added.stderr.trim() || `exit ${added.code}`}`,
    );
  }
  return { ...paths, sourceRepo };
}
