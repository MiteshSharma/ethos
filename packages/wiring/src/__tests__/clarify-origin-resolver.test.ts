import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackgroundJob } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { resolveJobClarifyOrigin } from '../build-agent-loop';

// G2/G3/D7 (plan/phases/pi-delegation.md §5/§6) — `ClarifyBridge` has carried
// `setOriginResolver()` since Phase 1's `clarify-bridge.ts`, but nothing in
// production wiring ever called it: `resolveRouting()` silently fell back to
// the request's own `surfaceType` for every background-job clarify, which is
// exactly the pre-fix behaviour the phase exists to correct. These tests lock
// the resolver's mapping (`resolveJobClarifyOrigin`, unit-testable in
// isolation — `buildAgentLoop` itself is a full composition root, impractical
// to construct here, per safety-conformance-wiring.test.ts) and that
// build-agent-loop.ts actually registers it.

function job(
  overrides: Partial<BackgroundJob> = {},
): Pick<BackgroundJob, 'originPlatform' | 'originBotKey' | 'originChatId' | 'originThreadId'> {
  return {
    originPlatform: 'telegram',
    originBotKey: 'bot1',
    originChatId: 'chat1',
    ...overrides,
  };
}

describe('resolveJobClarifyOrigin', () => {
  it('maps a job with a recorded clarify-capable origin platform to a ClarifyOriginLane', () => {
    const lane = resolveJobClarifyOrigin(job());
    expect(lane).toEqual({
      surfaceType: 'telegram',
      surfaceContext: { chatId: 'chat1', botKey: 'bot1' },
    });
  });

  it('folds originThreadId into surfaceContext when present', () => {
    const lane = resolveJobClarifyOrigin(job({ originThreadId: 'thread1' }));
    expect(lane).toEqual({
      surfaceType: 'telegram',
      surfaceContext: { chatId: 'chat1', botKey: 'bot1', threadId: 'thread1' },
    });
  });

  it('is null when the job has no originPlatform', () => {
    expect(resolveJobClarifyOrigin(job({ originPlatform: undefined }))).toBeNull();
  });

  it('is null when the job itself is null (not found in the store)', () => {
    expect(resolveJobClarifyOrigin(null)).toBeNull();
  });

  it('is null for an origin platform with no clarify surface (e.g. email)', () => {
    expect(resolveJobClarifyOrigin(job({ originPlatform: 'email' }))).toBeNull();
  });

  it('recognizes every ClarifySurfaceType platform value', () => {
    for (const platform of ['tui', 'cli', 'web', 'telegram', 'slack', 'discord', 'whatsapp']) {
      const lane = resolveJobClarifyOrigin(job({ originPlatform: platform }));
      expect(lane?.surfaceType).toBe(platform);
    }
  });

  it('omits chatId/botKey from surfaceContext when the job has none recorded', () => {
    const lane = resolveJobClarifyOrigin(job({ originBotKey: undefined, originChatId: undefined }));
    expect(lane).toEqual({ surfaceType: 'telegram', surfaceContext: {} });
  });
});

describe('ClarifyBridge origin resolver is wired in production', () => {
  it('build-agent-loop.ts registers setOriginResolver inside the backgroundEnabled block, backed by the job store', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, 'packages/wiring/src/build-agent-loop.ts'), 'utf8');
    expect(src).toMatch(/infra\.clarifyBridge\.setOriginResolver\(/);
    expect(src).toMatch(/resolveJobClarifyOrigin\(job\)/);

    // The registration must happen after jobStore is constructed and inside
    // the `if (backgroundEnabled)` block — a resolver with no jobs to look up
    // has nothing to resolve.
    const gateIdx = src.indexOf('if (backgroundEnabled) {');
    const jobStoreIdx = src.indexOf('jobStore = new SQLiteJobStore(', gateIdx);
    const resolverIdx = src.indexOf('infra.clarifyBridge.setOriginResolver(', gateIdx);
    const executorStartIdx = src.indexOf('backgroundExecutor = new BackgroundExecutor(', gateIdx);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(jobStoreIdx).toBeGreaterThan(gateIdx);
    expect(resolverIdx).toBeGreaterThan(jobStoreIdx);
    expect(executorStartIdx).toBeGreaterThan(resolverIdx);
  });
});
