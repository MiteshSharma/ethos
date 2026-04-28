import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRepository } from '../../repositories/memory.repository';

describe('MemoryRepository', () => {
  let dir: string;
  let repo: MemoryRepository;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-memory-'));
    repo = new MemoryRepository({ dataDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('read returns empty content + null modifiedAt when the file does not exist', async () => {
    const file = await repo.read('memory');
    expect(file.store).toBe('memory');
    expect(file.content).toBe('');
    expect(file.modifiedAt).toBeNull();
    expect(file.path).toContain('MEMORY.md');
  });

  it('write creates the file and returns the freshly-read state', async () => {
    const result = await repo.write('memory', '# project context\n\nfirst note');
    expect(result.content).toBe('# project context\n\nfirst note');
    expect(result.modifiedAt).not.toBeNull();
    expect(await readFile(join(dir, 'MEMORY.md'), 'utf-8')).toBe('# project context\n\nfirst note');
  });

  it('write to user store uses USER.md', async () => {
    await repo.write('user', 'I am Mitesh.');
    expect(await readFile(join(dir, 'USER.md'), 'utf-8')).toBe('I am Mitesh.');
    const file = await repo.read('user');
    expect(file.path).toContain('USER.md');
  });

  it('read picks up out-of-band edits', async () => {
    await writeFile(join(dir, 'MEMORY.md'), 'edited externally');
    const file = await repo.read('memory');
    expect(file.content).toBe('edited externally');
  });
});
