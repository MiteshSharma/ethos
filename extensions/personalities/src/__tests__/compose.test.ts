// `compose()` is the wiring-facing entry point (`extensions/personalities/src/compose.ts`)
// that `packages/wiring/src/build-infrastructure.ts` calls to build the AgentLoop's own
// personality registry. It's the exact call path the desktop app's bundled main process
// goes through — `import.meta.dirname` inside `loadBuiltins()` resolves relative to the
// bundled output file post-electron-vite, not the source tree, so a bundled caller must
// supply `WiringContext.builtinPersonalitiesDir` and this test proves that field actually
// reaches `createPersonalityRegistry()` rather than being silently dropped along the way.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Logger } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compose } from '../compose';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-personalities-compose-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const logStub: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logStub,
};

describe('compose() personality construction', () => {
  it('forwards ctx.builtinPersonalitiesDir to createPersonalityRegistry, replacing loadBuiltins()', async () => {
    const dataDir = join(testDir, 'data');
    const builtinsDir = join(testDir, 'bundled-builtins');
    const personaDir = join(builtinsDir, 'bundle-persona');
    await mkdir(personaDir, { recursive: true });
    await writeFile(join(personaDir, 'config.yaml'), 'name: Bundle Persona\n');
    await writeFile(join(personaDir, 'SOUL.md'), '# Bundle Persona');
    // `ctx.dataDir/personalities` is also read by compose() — left absent here;
    // loadFromDirectory tolerates a missing directory (returns []).

    const ctx: WiringContext = {
      storage: new FsStorage(),
      dataDir,
      workingDir: testDir,
      log: logStub,
      builtinPersonalitiesDir: builtinsDir,
    };

    const { personalities } = await compose(ctx);

    const ids = personalities.list().map((p) => p.id);
    expect(ids).toContain('bundle-persona');
    // The real built-ins must NOT be present — proof the override REPLACED
    // loadBuiltins(), not supplemented it.
    expect(ids).not.toContain('researcher');
  });

  it('without ctx.builtinPersonalitiesDir, falls back to the real built-ins unchanged', async () => {
    const dataDir = join(testDir, 'data');
    const ctx: WiringContext = {
      storage: new FsStorage(),
      dataDir,
      workingDir: testDir,
      log: logStub,
    };

    const { personalities } = await compose(ctx);

    const ids = personalities.list().map((p) => p.id);
    expect(ids).toContain('researcher');
  });
});
