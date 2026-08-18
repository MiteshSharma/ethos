import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCallCaptureToolsEnabled } from '../build-agent-loop';
import type { WiringConfig } from '../index';

// Regression guard for the same class of gap voice-meeting-tools.test.ts
// guards: a capability built with green tests but never wired into the loop.
// Section 0 of the call-capture Phase 4 integration closed exactly this gap.
// These tests lock:
//   1. the darwin+configured gate is exactly right (unit-testable in
//      isolation — `buildAgentLoop` itself is a full composition root,
//      impractical to construct here, per safety-conformance-wiring.test.ts),
//   2. build-agent-loop.ts wires `runCallCapture` (never a registered `Tool`
//      — the fix that closed the "LLM can call this directly" security hole),
//      gated on the same predicate.

function config(callCapture?: WiringConfig['callCapture']): WiringConfig {
  return {
    provider: 'anthropic',
    model: 'm',
    apiKey: 'k',
    ...(callCapture ? { callCapture } : {}),
  };
}

describe('isCallCaptureToolsEnabled', () => {
  it('is enabled on darwin with a bound personality', () => {
    expect(isCallCaptureToolsEnabled('darwin', config({ personalityId: 'receptionist' }))).toBe(
      true,
    );
  });

  it('is disabled on darwin with no callCapture config at all', () => {
    expect(isCallCaptureToolsEnabled('darwin', config())).toBe(false);
  });

  it('is disabled on darwin when personalityId is unset', () => {
    expect(isCallCaptureToolsEnabled('darwin', config({}))).toBe(false);
  });

  it('is disabled on every non-darwin platform, even when configured', () => {
    for (const platform of ['linux', 'win32', 'freebsd'] as NodeJS.Platform[]) {
      expect(isCallCaptureToolsEnabled(platform, config({ personalityId: 'receptionist' }))).toBe(
        false,
      );
    }
  });
});

describe('call capture is never registered as an LLM-callable tool', () => {
  it('build-agent-loop.ts gates the runCallCapture binding on isCallCaptureToolsEnabled, and never registers it into the tool registry', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, 'packages/wiring/src/build-agent-loop.ts'), 'utf8');
    expect(src).toMatch(/isCallCaptureToolsEnabled\(process\.platform, config\)/);
    expect(src).toMatch(/tapCapture: new TapCapture\(\)/);
    expect(src).toMatch(/micCapture: new MicCapture\(\)/);
    expect(src).toMatch(/getSummaryProvider: async \(\) => llm/);
    // The fix under test: dispatch is a bound function returned through
    // CreateAgentLoopResult, not a Tool registered into the LLM-visible registry.
    expect(src).toMatch(/runCallCapture\(callCaptureOpts,/);
    // No `tools.register(tool)` call site anywhere in the call-capture block
    // (other unrelated tool-registration loops — vision, web, memory — are
    // fine and expected; this only asserts none of them is call-capture's).
    // The block runs from the gate check through the next named section
    // ("Ch.6a — In-process watcher" immediately follows it in the file).
    const gateIdx = src.indexOf('isCallCaptureToolsEnabled(process.platform, config)');
    const nextSectionIdx = src.indexOf('Ch.6a', gateIdx);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(nextSectionIdx).toBeGreaterThan(gateIdx);
    const callCaptureBlock = src.slice(gateIdx, nextSectionIdx);
    expect(callCaptureBlock).not.toMatch(/tools\.register\(tool\)/);
  });
});
