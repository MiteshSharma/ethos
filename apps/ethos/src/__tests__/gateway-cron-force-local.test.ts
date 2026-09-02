// plan/phases/cron-fire-url-collapse.md T13 — the D1 invariant, at the
// app-wiring level.
//
// `cron.fireUrl` is the whole mode switch: present → external mode, no
// in-process interval. `ethos gateway` builds no web API, so it can never be
// fired externally — honouring a fire URL there would silently stop every
// scheduled job and every cron-backed watcher, with no error and no failing
// request. `buildCronTriggers` forces the local interval on for any process
// that says `hasHttpSurface: false`, and records why in `notices`.
//
// Two idioms, following `gateway-platform-webhook-wiring.test.ts`:
//
//  - RUNTIME, for the policy itself. `buildCronTriggers` is a pure function of
//    (engine, config, opts), so the gateway's answer and serve/boot's answer
//    both run for real here against a stub engine.
//  - SOURCE-TEXT, for the fact that each command passes the right option and
//    prints the notice. Those three lines live inside `runGatewayStart` /
//    `runServe` / `runBoot`, each of which boots an entire process and cannot
//    be invoked from a unit test — the same reason the sibling wiring suites
//    assert against source.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CronEngine } from '@ethosagent/cron';
import { buildCronTriggers, HttpFireTrigger, LocalIntervalTrigger } from '@ethosagent/cron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => readFile(join(ROOT, rel), 'utf8');

const FIRE_URL = 'https://agent.example.com/cron/fire';

function makeEngine(): { engine: CronEngine; fire: ReturnType<typeof vi.fn> } {
  const fire = vi.fn(async () => {});
  return { engine: { fire }, fire };
}

// Matched on 'cron:' and on the URL, never on punctuation — the external-mode
// notice contains an em dash.
const namesTheFireUrl = (notice: string) => notice.includes('cron:') && notice.includes(FIRE_URL);

describe('ethos gateway keeps ticking regardless of cron.fireUrl (D1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a local interval anyway, and says why', () => {
    const { engine } = makeEngine();
    const triggers = buildCronTriggers(engine, { fireUrl: FIRE_URL }, { hasHttpSurface: false });

    expect(triggers.local).toBeInstanceOf(LocalIntervalTrigger);
    expect(triggers.notices.filter(namesTheFireUrl)).toHaveLength(1);
  });

  it('that interval actually fires the engine once started', async () => {
    const { engine, fire } = makeEngine();
    const triggers = buildCronTriggers(
      engine,
      { fireUrl: FIRE_URL },
      { hasHttpSurface: false, localIntervalMs: 1_000 },
    );

    triggers.local?.start();
    expect(fire).toHaveBeenCalledTimes(1); // immediate check-on-start
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fire).toHaveBeenCalledTimes(2);
    triggers.local?.stop();
  });

  it('still constructs the (unused) HttpFireTrigger — config no longer gates it (D2)', () => {
    const { engine } = makeEngine();
    const triggers = buildCronTriggers(engine, { fireUrl: FIRE_URL }, { hasHttpSurface: false });

    expect(triggers.external).toBeInstanceOf(HttpFireTrigger);
  });

  it('passes hasHttpSurface: false explicitly, prints the notice, and starts the interval', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    // Explicit rather than defaulted, so the invariant is visible at the site
    // it protects — a reader of gateway.ts can see that this process forces
    // the local interval without going to read `buildCronTriggers`.
    expect(src).toContain('hasHttpSurface: false,');
    expect(src).toContain('for (const notice of cronTriggers.notices) {');
    expect(src).toContain('cronTriggers.local?.start();');
  });
});

describe('ethos serve / ethos boot honour cron.fireUrl and say so at boot', () => {
  it('external mode leaves no in-process interval, with a notice naming the URL', () => {
    const { engine } = makeEngine();
    const triggers = buildCronTriggers(engine, { fireUrl: FIRE_URL }, { hasHttpSurface: true });

    expect(triggers.local).toBeNull();
    expect(triggers.notices.filter(namesTheFireUrl)).toHaveLength(1);
    expect(triggers.external).toBeInstanceOf(HttpFireTrigger);
  });

  it('says nothing at all when no fireUrl is configured — the unchanged default', () => {
    const { engine } = makeEngine();
    const triggers = buildCronTriggers(engine, undefined, { hasHttpSurface: true });

    expect(triggers.local).toBeInstanceOf(LocalIntervalTrigger);
    expect(triggers.notices).toEqual([]);
  });

  for (const file of ['apps/ethos/src/commands/serve.ts', 'apps/ethos/src/commands/boot.ts']) {
    it(`${file} passes hasHttpSurface: true and prints the notices`, async () => {
      const src = await read(file);
      expect(src).toContain('hasHttpSurface: true,');
      expect(src).toContain('for (const notice of cronTriggers.notices)');
    });
  }

  it('serve.ts hands the fire trigger to createWebApi unconditionally (D2)', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src).toContain('cronFireTrigger: cronTriggers.external,');
    // The conditional spread is dead code now that `external` is non-nullable.
    expect(src).not.toContain('cronTriggers.external ?');
  });
});
