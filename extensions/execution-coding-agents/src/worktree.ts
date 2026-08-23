// Raw `node:fs` carve-out (Law 7) — see apps/ethos/src/__tests__/no-raw-fs.test.ts
// and the allowed-exception list in CLAUDE.md. Creating a run's workspace is a
// `git worktree add`: the git binary writes a whole tree, which no Storage
// method can express, and the surrounding mkdir/exists checks are that same
// operation's bookkeeping. Same category as the SQLite stores' mkdirSync of a
// database's parent directory. Identical rationale to (and copied from, not
// imported from) `execution-pi/src/worktree.ts` — D-ACP1: no shared file
// between the two packages.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Every host path one ACP-agent run owns. Both sit under `${ETHOS_HOME}/worktrees/`. */
export interface AcpWorkspacePaths {
  /** `${ETHOS_HOME}/worktrees` — the root a personality's `fs_reach` must cover. */
  root: string;
  /** The run's git worktree. The agent's cwd, and the only writable code path it sees. */
  workspace: string;
  /**
   * The agent's own session/scratch storage, a SIBLING of the worktree rather
   * than a directory inside it: a session dir inside the worktree would show
   * up in the diff a human reviews, and the whole point of the worktree is
   * that its diff IS the run's output. Sibling placement keeps ONE `fs_reach`
   * prefix covering both — same reasoning as Pi's `sessionDir`.
   */
  sessionDir: string;
}

/**
 * D24 — one worktree per run at `${ETHOS_HOME}/worktrees/<jobId>`, generalized
 * off `jobId` exactly the way `execution-pi/src/worktree.ts`'s
 * `piWorkspacePaths` already is. Job ids are unique across every runner (the
 * id space is the shared `JobStore`'s, not per-runner), so a Pi job and an ACP
 * job never collide under the same `worktrees/` root.
 */
export function acpWorkspacePaths(ethosHome: string, jobId: string): AcpWorkspacePaths {
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
 * reach, not merely somewhere convenient. Refuses loudly and names the entry
 * to add — same containment claim `execution-pi`'s worktree module makes,
 * proven here for a second runner kind rather than assumed to transfer.
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

export interface PreparedWorkspace extends AcpWorkspacePaths {
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
 * Create the run's workspace before the host is spawned. Identical shape to
 * `execution-pi`'s `prepareWorkspace` — see that file for the full rationale
 * (real detached worktree when the source is a git repo; fresh empty
 * directory otherwise; idempotent for Resume).
 *
 * KNOWN LIMIT (same as Pi's, inherited by construction): only the worktree is
 * mounted into the container, so in-container `git` cannot follow the
 * worktree's `.git` FILE back to the parent repository's object store. The
 * agent can read and write files; it cannot commit.
 */
export async function prepareWorkspace(
  paths: AcpWorkspacePaths,
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
