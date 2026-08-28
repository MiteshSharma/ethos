// plan/phases/single-process-boot-profile.md §7 Phase 1 — the extraction.
//
// The whole point of Phase 1 is that the gateway-role and serve-role
// constructor logic is reachable WITHOUT running `runGatewayStart` /
// `runServe`: a third entry point (the merged `boot` profile of §6) has to be
// able to call these pieces individually instead of copy-pasting ~2800 lines.
// These tests assert exactly that property — each seam is a named, exported,
// individually-callable function — plus the one behaviour that is cheap to
// exercise without a live process.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildGateway,
  buildGatewayAdapters,
  createGatewayAttachmentCache,
  registerGatewayClarifySurfaces,
} from '../commands/gateway';

describe('single-process boot profile — Phase 1 extraction', () => {
  it('exposes every gateway-role construction seam as a callable export', () => {
    expect(typeof createGatewayAttachmentCache).toBe('function');
    expect(typeof buildGatewayAdapters).toBe('function');
    expect(typeof registerGatewayClarifySurfaces).toBe('function');
    expect(typeof buildGateway).toBe('function');
  });

  // `commands/serve.ts` imports `@ethosagent/acp-server`, which is an APP
  // (`apps/acp-server`) and therefore has no path alias in the root tsconfig —
  // the module is not resolvable from a vitest run rooted at the repo. That is
  // why every existing test that covers serve.ts (serve-callcapture-wiring,
  // approval-seams) asserts against its SOURCE rather than importing it, and
  // why this one does too.
  it('exposes every serve-role construction seam as a top-level export', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, 'apps/ethos/src/commands/serve.ts'), 'utf8');
    for (const name of [
      'buildServeAcpServer',
      'buildServeA2aCore',
      'buildServeA2aSurface',
      'buildServeWebApi',
    ]) {
      expect(src).toMatch(new RegExp(`^export (async )?function ${name}\\(`, 'm'));
    }
  });

  // With nothing configured there is no adapter to bind a surface to, so no
  // surface can correlate a reply — and the Gateway must then be built WITHOUT
  // a `clarifyMessageCorrelator` rather than with one that always returns null,
  // which is what the original inline code did via `?: undefined`.
  it('registerGatewayClarifySurfaces omits the correlator when no adapter is configured', async () => {
    const result = await registerGatewayClarifySurfaces({
      bots: [],
      adapters: [],
      // Never reached: every per-platform builder returns early on an empty
      // adapter list, before it touches the loop.
      systemLoop: null as never,
      resolveApprovalRoute: () => undefined,
    });
    expect(result.clarifyMessageCorrelator).toBeUndefined();
    expect('clarifyMessageCorrelator' in result).toBe(false);
  });
});
