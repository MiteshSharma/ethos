// The satellite's node id must be the SAME id tomorrow.
//
// The server's lane key is `voice:<node>:<personality>`, so a per-boot random
// id forks the conversation on every restart: the kitchen Pi comes back from a
// power cut as a different node and its history is orphaned under a key nothing
// will ever ask for again. These tests pin the two halves of that promise —
// generated exactly once, read verbatim thereafter.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { resolveListenNodeId } from '../commands/listen';

const PATH = '/home/pi/.ethos/listen-node-id';

describe('resolveListenNodeId', () => {
  it('generates on first run and persists the composed id', async () => {
    const storage = new InMemoryStorage();
    const id = await resolveListenNodeId(storage, PATH, () => 'kitchen-pi-1a2b3c4d');
    expect(id).toBe('kitchen-pi-1a2b3c4d');
    expect((await storage.read(PATH))?.trim()).toBe('kitchen-pi-1a2b3c4d');
  });

  it('returns the same id on the second call over the same Storage', async () => {
    const storage = new InMemoryStorage();
    let generated = 0;
    const generate = () => `id-${++generated}`;
    const first = await resolveListenNodeId(storage, PATH, generate);
    const second = await resolveListenNodeId(storage, PATH, generate);
    expect(second).toBe(first);
    expect(generated).toBe(1);
  });

  it('regenerates only when the file is absent', async () => {
    const storage = new InMemoryStorage();
    let generated = 0;
    const generate = () => `id-${++generated}`;
    await resolveListenNodeId(storage, PATH, generate);
    await storage.remove(PATH);
    const regenerated = await resolveListenNodeId(storage, PATH, generate);
    expect(regenerated).toBe('id-2');
    expect(generated).toBe(2);
  });

  it('ignores a trailing newline and surrounding whitespace', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/home/pi/.ethos');
    await storage.write(PATH, '  kitchen-pi-1a2b3c4d \n');
    expect(await resolveListenNodeId(storage, PATH, () => 'fresh')).toBe('kitchen-pi-1a2b3c4d');
  });

  it('treats an empty file as absent rather than as an empty node id', async () => {
    // An empty `nodeId` fails the wire schema's `min(1)`, so the satellite
    // would register nothing at all — a blank file must mean "generate", not
    // "use the empty string".
    const storage = new InMemoryStorage();
    await storage.mkdir('/home/pi/.ethos');
    await storage.write(PATH, '\n');
    expect(await resolveListenNodeId(storage, PATH, () => 'fresh')).toBe('fresh');
  });

  it('the default generator produces a stable-shaped, non-empty id', async () => {
    const storage = new InMemoryStorage();
    const id = await resolveListenNodeId(storage, PATH);
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[a-z0-9-]+$/);
  });
});
