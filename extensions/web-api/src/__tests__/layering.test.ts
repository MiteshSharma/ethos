import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Backend layering enforcement (Phase 26 Done-when #24).
//
// `src/rpc/*.ts` files are thin oRPC shells. They must:
//   • Validate input (oRPC does this automatically)
//   • Call exactly one service method
//   • Return its result
//
// They must NOT:
//   • Import anything from `@ethosagent/{session-sqlite, personalities,
//     memory-*, cron, agent-mesh, plugin-loader, skill-evolver,
//     batch-runner, eval-harness}` directly. Those imports belong in
//     repositories.
//   • Touch the filesystem (`node:fs`, `node:path`).
//   • Open SQLite connections.
//
// The grep below catches the most common drift; full enforcement comes
// from code review + the layered file structure.

const SRC_ROOT = join(import.meta.dirname, '..');
const RPC_DIR = join(SRC_ROOT, 'rpc');

const FORBIDDEN_PACKAGES = [
  '@ethosagent/session-sqlite',
  '@ethosagent/personalities',
  '@ethosagent/memory-markdown',
  '@ethosagent/memory-vector',
  '@ethosagent/cron',
  '@ethosagent/agent-mesh',
  '@ethosagent/plugin-loader',
  '@ethosagent/skill-evolver',
  '@ethosagent/batch-runner',
  '@ethosagent/eval-harness',
];

const FORBIDDEN_NODE_MODULES = ['node:fs', 'node:fs/promises', 'better-sqlite3'];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTs(full));
    } else if (extname(entry) === '.ts') {
      out.push(full);
    }
  }
  return out;
}

describe('web-api layering (Phase 26 Done-when #24)', () => {
  it('src/rpc/*.ts does not import any extension package directly', () => {
    const offenders: string[] = [];
    for (const file of listTs(RPC_DIR)) {
      const src = readFileSync(file, 'utf-8');
      for (const pkg of FORBIDDEN_PACKAGES) {
        const re = new RegExp(`from\\s+['"]${pkg.replace('/', '\\/')}['"]`);
        if (re.test(src)) {
          offenders.push(`${relative(SRC_ROOT, file)} → ${pkg}`);
        }
      }
    }
    expect(
      offenders,
      `RPC handlers must not import extensions directly. Move data access into a repository:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('src/rpc/*.ts does not touch the filesystem or SQLite', () => {
    const offenders: string[] = [];
    for (const file of listTs(RPC_DIR)) {
      const src = readFileSync(file, 'utf-8');
      for (const mod of FORBIDDEN_NODE_MODULES) {
        const re = new RegExp(`from\\s+['"]${mod}['"]`);
        if (re.test(src)) {
          offenders.push(`${relative(SRC_ROOT, file)} → ${mod}`);
        }
      }
    }
    expect(
      offenders,
      `RPC handlers must not touch the filesystem/SQLite. Move I/O into a repository:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('src/rpc/*.ts handlers stay thin (heuristic: each file ≤120 lines)', () => {
    // Soft cap; the spec aims for procedures of 5-10 lines each. A whole
    // namespace file with 4-6 procedures + imports + types lands well under
    // 120. If a file blows past this, the implementer probably leaked
    // service-layer logic into the handler.
    const fat: Array<{ file: string; lines: number }> = [];
    for (const file of listTs(RPC_DIR)) {
      const lines = readFileSync(file, 'utf-8').split('\n').length;
      if (lines > 120) fat.push({ file: relative(SRC_ROOT, file), lines });
    }
    expect(fat).toEqual([]);
  });
});
