// The synthesized-audio store behind voice redelivery (voice V2, eng-review D9).
//
// Two properties matter here and neither is "it writes a file". The first is
// that a ref is opaque data that re-enters the process from a SQLite column
// after a restart, so it must never be able to address anything outside the
// artifact directory. The second is that every failure is soft: an artifact
// problem is a durability problem, and turning it into a delivery problem would
// mean a disk hiccup costs the user their reply.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { createVoiceArtifactStore } from '../voice-artifacts';
import { SizedInMemoryStorage } from './voice-fakes';

const DIR = '/ethos/voice/artifacts';

function store(storage: InMemoryStorage) {
  const errors: Array<{ op: string; error: string }> = [];
  return {
    errors,
    artifacts: createVoiceArtifactStore({
      storage,
      dir: DIR,
      onError: (op, error) => void errors.push({ op, error }),
    }),
  };
}

async function seeded(): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir('/ethos');
  return storage;
}

describe('voice artifact store — round trip', () => {
  it('writes bytes under a bare filename and reads them back', async () => {
    const { artifacts, errors } = store(await seeded());
    const ref = await artifacts.put(Uint8Array.from([1, 2, 3]), 'wav');

    expect(ref).toMatch(/^[0-9a-f-]{36}\.wav$/);
    // A BARE filename, never a path: the ledger persists this string.
    expect(ref).not.toContain('/');
    expect(Array.from((await artifacts.read(ref ?? '')) ?? [])).toEqual([1, 2, 3]);
    expect(errors).toEqual([]);
  });

  it('uses the format-canonical extension — opus rides in an ogg container', async () => {
    const { artifacts } = store(await seeded());
    expect(await artifacts.put(Uint8Array.from([1]), 'opus')).toMatch(/\.ogg$/);
  });

  it('remove deletes the artifact; a second remove is silent, not an error', async () => {
    const { artifacts, errors } = store(await seeded());
    const ref = (await artifacts.put(Uint8Array.from([1]), 'wav')) ?? '';

    await artifacts.remove(ref);
    expect(await artifacts.read(ref)).toBeNull();
    // Delivering an obligation removes its artifact and a later prune may try
    // again. "Already gone" is the desired end state, not a failure.
    await artifacts.remove(ref);
    expect(errors).toEqual([]);
  });
});

describe('voice artifact store — refs are validated, not trusted', () => {
  it('refuses a traversal ref on read and remove, leaving the target untouched', async () => {
    const storage = await seeded();
    await storage.mkdir('/ethos/secrets');
    await storage.write('/ethos/secrets/key', 'do not touch');
    const { artifacts, errors } = store(storage);

    expect(await artifacts.read('../secrets/key')).toBeNull();
    await artifacts.remove('../secrets/key');

    expect(await storage.read('/ethos/secrets/key')).toBe('do not touch');
    expect(errors.map((e) => e.op)).toEqual(['validate', 'validate']);
  });

  it('refuses anything that is not <uuid>.<ext>', async () => {
    const { artifacts } = store(await seeded());
    for (const bad of ['', 'reply.wav', `${'a'.repeat(36)}.wav`, '/abs/path.wav']) {
      expect(await artifacts.read(bad)).toBeNull();
    }
  });
});

describe('voice artifact store — no storage wired', () => {
  it('put returns null and everything else no-ops', async () => {
    const artifacts = createVoiceArtifactStore({});
    expect(await artifacts.put(Uint8Array.from([1]), 'wav')).toBeNull();
    expect(await artifacts.read('x')).toBeNull();
    await expect(artifacts.remove('x')).resolves.toBeUndefined();
    expect(await artifacts.enforceSizeCap(0)).toBe(0);
  });
});

describe('voice artifact store — size cap', () => {
  it('evicts oldest-first until the directory is under the cap', async () => {
    const storage = new SizedInMemoryStorage();
    await storage.mkdir('/ethos');
    const { artifacts } = store(storage);

    // Written in age order — the fake storage stamps an increasing mtime.
    const oldest = (await artifacts.put(new Uint8Array(100), 'wav')) ?? '';
    const middle = (await artifacts.put(new Uint8Array(100), 'wav')) ?? '';
    const newest = (await artifacts.put(new Uint8Array(100), 'wav')) ?? '';

    // 300 bytes on disk, cap of 150 → the two oldest go.
    expect(await artifacts.enforceSizeCap(150)).toBe(200);
    expect(await artifacts.read(oldest)).toBeNull();
    expect(await artifacts.read(middle)).toBeNull();
    expect(await artifacts.read(newest)).not.toBeNull();
  });

  it('is a no-op when the directory is already under the cap', async () => {
    const storage = new SizedInMemoryStorage();
    await storage.mkdir('/ethos');
    const { artifacts } = store(storage);
    const ref = (await artifacts.put(new Uint8Array(10), 'wav')) ?? '';

    expect(await artifacts.enforceSizeCap(1_000)).toBe(0);
    expect(await artifacts.read(ref)).not.toBeNull();
  });

  it('never evicts entries whose size and mtime the backend does not report', async () => {
    // Plain InMemoryStorage omits both fields. Size 0 means nothing counts
    // toward the cap, so nothing is over it and nothing is deleted — the
    // conservative reading, and the one that never destroys an artifact a
    // backend simply could not describe.
    const storage = await seeded();
    const { artifacts } = store(storage);
    const ref = (await artifacts.put(new Uint8Array(5_000), 'wav')) ?? '';

    expect(await artifacts.enforceSizeCap(1)).toBe(0);
    expect(await artifacts.read(ref)).not.toBeNull();
  });
});
