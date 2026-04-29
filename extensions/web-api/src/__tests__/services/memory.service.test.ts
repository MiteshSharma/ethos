import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryService } from '../../services/memory.service';

describe('MemoryService', () => {
  let dir: string;
  let service: MemoryService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-memory-'));
    service = new MemoryService({ memory: new MarkdownFileMemoryProvider({ dir }) });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('get returns empty content + null modifiedAt when the file does not exist', async () => {
    const { file } = await service.get('memory');
    expect(file.store).toBe('memory');
    expect(file.content).toBe('');
    expect(file.modifiedAt).toBeNull();
    expect(file.path).toContain('MEMORY.md');
  });

  it('write creates the file and returns the freshly-read state', async () => {
    const result = await service.write('memory', '# project context\n\nfirst note');
    expect(result.file.content).toBe('# project context\n\nfirst note');
    expect(result.file.modifiedAt).not.toBeNull();
    expect(await readFile(join(dir, 'MEMORY.md'), 'utf-8')).toBe(
      '# project context\n\nfirst note',
    );
  });

  it('write to user store uses USER.md', async () => {
    await service.write('user', 'I am Mitesh.');
    expect(await readFile(join(dir, 'USER.md'), 'utf-8')).toBe('I am Mitesh.');
    const { file } = await service.get('user');
    expect(file.path).toContain('USER.md');
  });

  it('read picks up out-of-band edits', async () => {
    await writeFile(join(dir, 'MEMORY.md'), 'edited externally');
    const { file } = await service.get('memory');
    expect(file.content).toBe('edited externally');
  });

  it('list returns both files in [memory, user] order', async () => {
    await service.write('memory', 'm');
    await service.write('user', 'u');
    const { files } = await service.list();
    expect(files.map((f) => f.store)).toEqual(['memory', 'user']);
  });
});
