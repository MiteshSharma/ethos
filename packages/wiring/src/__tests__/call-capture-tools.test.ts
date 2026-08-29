import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { isCallCaptureToolsEnabled, resolveCallCaptureDocumentsWorkdir } from '../build-agent-loop';
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
    // Both take an options object now — `tapCaptureOpts`/`micCaptureOpts` —
    // populated with a `binaryPath` override only when `wiringCtx.
    // callCaptureNativeDir` is set (bundled callers, e.g. desktop). Empty
    // `{}` for every other caller, so behavior is unchanged from the bare
    // `new TapCapture()` / `new MicCapture()` this test asserted before.
    expect(src).toMatch(/tapCapture: new TapCapture\(tapCaptureOpts\)/);
    expect(src).toMatch(/micCapture: new MicCapture\(micCaptureOpts\)/);
    expect(src).toMatch(/getSummaryProvider: async \(\) => llm/);
    // The fix under test: dispatch is a bound function returned through
    // CreateAgentLoopResult, not a Tool registered into the LLM-visible registry.
    expect(src).toMatch(/runCallCapture\(callCaptureOpts,/);
    // P4 — the Documents-tab mirror: `documentsWorkdir` is resolved per
    // invocation via the extracted, separately-unit-tested
    // `resolveCallCaptureDocumentsWorkdir` helper (see the describe block
    // below). `storage` is constructed per invocation too — never threaded
    // through as the raw `wiringCtx.storage` — confined to that same
    // `documentsWorkdir` via `ScopedStorage`, mirroring the boundary
    // `DocumentsService` enforces for reads of the same directory (finding
    // #7: the mirror write must not bypass the personality fs boundary).
    expect(src).toMatch(
      /resolveCallCaptureDocumentsWorkdir\(\s*personalities\.get\(personalityId\)/,
    );
    expect(src).toMatch(/storage: new ScopedStorage\(wiringCtx\.storage, \{/);
    expect(src).toMatch(/read: \[documentsWorkdir\]/);
    expect(src).toMatch(/write: \[documentsWorkdir\]/);
    expect(src).toMatch(/alwaysDeny: defaultAlwaysDeny\(\)/);
    // The block runs from the gate check through the next named section
    // ("Ch.6a — In-process watcher" immediately follows it in the file).
    const gateIdx = src.indexOf('isCallCaptureToolsEnabled(process.platform, config)');
    const nextSectionIdx = src.indexOf('Ch.6a', gateIdx);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(nextSectionIdx).toBeGreaterThan(gateIdx);
    const callCaptureBlock = src.slice(gateIdx, nextSectionIdx);
    // No `tools.register(tool)` call site anywhere in the call-capture block
    // (other unrelated tool-registration loops — vision, web, memory — are
    // fine and expected; this only asserts none of them is call-capture's).
    expect(callCaptureBlock).not.toMatch(/tools\.register\(tool\)/);
    // The raw, process-wide storage must never reach `runCallCapture`
    // directly within this block — only wrapped in `ScopedStorage`. (Other
    // unrelated sections of build-agent-loop.ts legitimately pass
    // `storage: wiringCtx.storage` straight through to other collaborators —
    // this assertion is scoped to the call-capture block only.)
    expect(callCaptureBlock).not.toMatch(/storage: wiringCtx\.storage,/);
  });
});

// P4 — plan/phases/call-capture-desktop-ux.md: the per-call transcript
// mirrors into the bound personality's `fs_reach.workdir` (surfaced in the
// web app's Documents tab) only when that personality DECLARES a workdir.
// `deriveFsReachPaths` itself falls back to `cwd` when undeclared — this
// helper must not forward that fallback into the mirror path, or every
// personality with no declared workdir would start mirroring transcripts
// into the process's cwd. Extracted from `buildAgentLoop` for the same
// testability reason `isCallCaptureToolsEnabled` above is.
describe('resolveCallCaptureDocumentsWorkdir', () => {
  const vars = { ethosHome: '/home/user/.ethos', self: 'receptionist', cwd: '/some/cwd' };

  function personality(id: string, workdir?: string): PersonalityConfig {
    return {
      id,
      name: id,
      ...(workdir ? { fs_reach: { workdir } } : {}),
    };
  }

  it('is undefined when no personality is found for the id', () => {
    expect(resolveCallCaptureDocumentsWorkdir(undefined, vars)).toBeUndefined();
  });

  it('is undefined when the personality declares no fs_reach.workdir', () => {
    expect(resolveCallCaptureDocumentsWorkdir(personality('receptionist'), vars)).toBeUndefined();
  });

  it('is undefined when the personality declares fs_reach but no workdir within it', () => {
    const p: PersonalityConfig = {
      id: 'receptionist',
      name: 'receptionist',
      fs_reach: { read: ['x'] },
    };
    expect(resolveCallCaptureDocumentsWorkdir(p, vars)).toBeUndefined();
  });

  it('resolves the substituted, absolute workdir when fs_reach.workdir is declared', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fs_reach substitution token, not a JS template string.
    const p = personality('receptionist', '${ETHOS_HOME}/workspace/${self}');
    expect(resolveCallCaptureDocumentsWorkdir(p, vars)).toBe(
      '/home/user/.ethos/workspace/receptionist',
    );
  });

  it('does not silently fall back to cwd the way deriveFsReachPaths itself would', () => {
    // deriveFsReachPaths(personality, vars).workdir === vars.cwd when
    // undeclared — assert the helper refuses that fallback rather than
    // forwarding it as a documentsWorkdir.
    const undeclared = resolveCallCaptureDocumentsWorkdir(personality('receptionist'), vars);
    expect(undeclared).not.toBe(vars.cwd);
    expect(undeclared).toBeUndefined();
  });
});
