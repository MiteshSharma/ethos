import { readFile, rename, writeFile } from 'node:fs/promises';
import type { CheckpointState } from './types';

export async function readCheckpoint(path: string): Promise<CheckpointState> {
  try {
    const src = await readFile(path, 'utf-8');
    return JSON.parse(src) as CheckpointState;
  } catch {
    return { version: 1, completedTaskIds: [], failedTaskIds: [] };
  }
}

// Atomic write: write to .tmp then rename so a mid-write SIGTERM
// leaves either the old checkpoint or the new one intact — never a partial file.
export async function writeCheckpoint(path: string, state: CheckpointState): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, path);
}
