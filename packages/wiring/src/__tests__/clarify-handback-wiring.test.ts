import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// D3 (plan/phases/stealth-browsing-and-takeover.md) — `ClarifyMeta.handbackUrl`
// is composed inside `ClarifyBridge` (unit-tested in
// packages/core/src/__tests__/clarify-handback-url.test.ts). What can only be
// asserted here is that production wiring actually HANDS the bridge the
// address: the bridge is constructed in one place, `buildInfrastructure`, and
// a bridge built without `webBaseUrl` silently degrades every takeover on
// every channel — the exact failure this closes.
//
// Source assertions rather than a live composition, for the same reason
// clarify-origin-resolver.test.ts uses them: `buildInfrastructure` is a full
// composition root (docker, plugins, provider registries), impractical to
// construct in a unit test.

const root = join(import.meta.dirname, '..', '..', '..', '..');
const read = (p: string) => readFile(join(root, p), 'utf8');

describe('webBaseUrl reaches the ClarifyBridge', () => {
  it('buildInfrastructure passes config.webBaseUrl into the bridge it constructs', async () => {
    const src = await read('packages/wiring/src/build-infrastructure.ts');
    const ctorIdx = src.indexOf('new ClarifyBridge(');
    expect(ctorIdx).toBeGreaterThan(-1);
    // Same call, not merely the same file.
    const ctorCall = src.slice(ctorIdx, src.indexOf(');', ctorIdx));
    expect(ctorCall).toContain('webBaseUrl: config.webBaseUrl');
  });

  it('WiringConfig declares webBaseUrl, so no second config key had to be invented', async () => {
    const src = await read('packages/wiring/src/index.ts');
    expect(src).toMatch(/^\s{2}webBaseUrl\?: string;$/m);
  });

  it('EthosConfig.webBaseUrl is the existing key, resolved ETHOS_PUBLIC_URL-first', async () => {
    const src = await read('packages/config/src/index.ts');
    expect(src).toMatch(/^\s{2}webBaseUrl\?: string;$/m);
    expect(src).toContain('webBaseUrl: process.env.ETHOS_PUBLIC_URL ?? kv.webBaseUrl ?? undefined');
  });

  it('the CLI wiring spreads the whole EthosConfig, so gateway and serve both carry it', async () => {
    // `createAgentLoop` builds its WiringConfig as `{ ...(await
    // withRotation(config)), … }`, and `withRotation` returns `{ ...config,
    // rotationKeys }` — every EthosConfig field, webBaseUrl included, reaches
    // buildInfrastructure without a per-field mapping line.
    const src = await read('apps/ethos/src/wiring.ts');
    expect(src).toContain('return { ...config, rotationKeys };');
    expect(src).toContain('const wiringConfig: WiringConfig = {\n    ...rotated,');
  });

  it('the desktop app builds its own WiringConfig with no webBaseUrl — it degrades by construction', async () => {
    // Desktop serves the UI on a loopback port picked at runtime; there is no
    // public address to compose from, so a takeover there must render the
    // old, link-less text rather than a guessed localhost URL.
    const src = await read('apps/desktop/src/main/serve.ts');
    const start = src.indexOf('const wiringConfig: WiringConfig = {');
    expect(start).toBeGreaterThan(-1);
    const literal = src.slice(start, src.indexOf('\n  };', start));
    expect(literal).not.toContain('webBaseUrl');
  });
});
