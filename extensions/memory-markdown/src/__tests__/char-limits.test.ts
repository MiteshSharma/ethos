// Item 8 — `memory.charLimits.{memory,user}`. The size cap is per key:
// MEMORY.md and USER.md take their own ceilings, every other key keeps 512K.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { MemoryContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { MarkdownFileMemoryProvider } from '../index';

const ctx: MemoryContext = {
  scopeId: 'personality:test',
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
};

/** Write `content` to `key` and read back what survived the cap. */
async function writeAndRead(
  provider: MarkdownFileMemoryProvider,
  key: string,
  content: string,
): Promise<string> {
  await provider.sync([{ key, action: 'replace', content }], ctx);
  return (await provider.read(key, ctx))?.content ?? '';
}

describe('MarkdownFileMemoryProvider — per-key char limits', () => {
  function makeProvider(charLimits?: { memory?: number; user?: number }) {
    return new MarkdownFileMemoryProvider({
      dir: '/data',
      storage: new InMemoryStorage(),
      ...(charLimits ? { charLimits } : {}),
    });
  }

  // The cap trims from the START and then to the next line boundary, so the
  // fixture is line-structured — a single unbroken line would trim to nothing.
  const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')}`).join(
    '\n',
  );

  it('applies the memory ceiling to MEMORY.md and the user ceiling to USER.md', async () => {
    const provider = makeProvider({ memory: 200, user: 500 });

    const memory = await writeAndRead(provider, 'MEMORY.md', lines);
    expect(memory.length).toBeLessThanOrEqual(200);
    const user = await writeAndRead(provider, 'USER.md', lines);
    expect(user.length).toBeLessThanOrEqual(500);
    // Each key got its OWN ceiling — the looser one kept strictly more.
    expect(user.length).toBeGreaterThan(memory.length);
    // Both kept the tail, not the head.
    expect(memory.endsWith('line-099\n')).toBe(true);
    expect(user.endsWith('line-099\n')).toBe(true);
  });

  it('leaves the other key at 512K when only one ceiling is configured', async () => {
    const provider = makeProvider({ memory: 200 });
    const body = 'x'.repeat(1000);

    expect((await writeAndRead(provider, 'MEMORY.md', body)).length).toBeLessThanOrEqual(200);
    // USER.md keeps the 512K default, so a 1000-char write is untouched.
    expect((await writeAndRead(provider, 'USER.md', body)).length).toBe(1001); // trailing newline
  });

  it('keeps the 512K default for both keys when unconfigured', async () => {
    const provider = makeProvider();
    const body = 'x'.repeat(1000);

    expect((await writeAndRead(provider, 'MEMORY.md', body)).length).toBe(1001);
    expect((await writeAndRead(provider, 'USER.md', body)).length).toBe(1001);
  });

  it('does not apply the MEMORY.md ceiling to an arbitrary key', async () => {
    const provider = makeProvider({ memory: 200, user: 200 });
    expect((await writeAndRead(provider, 'topic.md', 'x'.repeat(1000))).length).toBe(1001);
  });

  it('archives the trimmed prefix rather than dropping it', async () => {
    const storage = new InMemoryStorage();
    const provider = new MarkdownFileMemoryProvider({
      dir: '/data',
      storage,
      charLimits: { memory: 200 },
    });
    await provider.sync([{ key: 'MEMORY.md', action: 'replace', content: 'y'.repeat(1000) }], ctx);

    const archive = await storage.read('/data/personalities/test/memory-archive.md');
    expect(archive).toContain('overflow-archived');
    expect(archive).toContain('yyy');
  });
});
