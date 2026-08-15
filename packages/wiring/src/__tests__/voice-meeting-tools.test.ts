import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import { createMeetingTools } from '@ethosagent/tools-meeting';
import { createVoiceTools } from '@ethosagent/tools-voice';
import { describe, expect, it } from 'vitest';
import { createApprovalDangerPredicate } from '../approval-seams';
import { APPROVAL_SURFACE_ALWAYS_ASK } from '../danger-predicate';
import type { WiringConfig } from '../index';
import { SPOKEN_CONFIRMATION_TOOLS } from '../spoken-confirmation';
import { resolveSipTrunkClient } from '../voice-stack';

// Regression guard for the voice/meeting integration gap: the tool packages were
// built with green tests but never registered into the tool registry, so the
// `voice_session` capability the web talk-mode gates on never appeared in the
// catalog/picker. These tests lock the two halves of the fix:
//   1. the factories default-registerable with no live infra, and
//   2. compose-tools.ts actually wiring them.

describe('voice + meeting tools registration (default install)', () => {
  it('voice_session is registered and ALWAYS available in the voice toolset', () => {
    const registry = new DefaultToolRegistry();
    for (const tool of createVoiceTools()) registry.register(tool);

    const voiceGroup = registry.getForToolset('voice');
    const voiceSession = voiceGroup.find((t) => t.name === 'voice_session');
    expect(voiceSession, 'voice_session must be in the catalog for the picker').toBeDefined();
    expect(voiceSession?.isAvailable?.() ?? true).toBe(true);
  });

  it('call and meet_join are registered but hidden until live infra is wired', () => {
    const registry = new DefaultToolRegistry();
    for (const tool of createVoiceTools()) registry.register(tool);
    for (const tool of createMeetingTools()) registry.register(tool);

    // Unavailable tools are filtered from the LLM's definitions too.
    const definitionNames = new Set(registry.toDefinitions().map((d) => d.name));
    expect(definitionNames.has('call')).toBe(false);
    expect(definitionNames.has('meet_join')).toBe(false);
    // The capability marker still shows in the LLM-visible set.
    expect(definitionNames.has('voice_session')).toBe(true);
  });

  it('compose-tools wires both factories (guards the "built but never registered" gap)', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..');
    const src = await readFile(join(root, 'packages/wiring/src/compose-tools.ts'), 'utf8');
    // `createVoiceTools` now takes the trunk caller-ID from `voice.trunk`, so
    // the guard checks the call site, not its (now non-empty) argument list.
    expect(src).toMatch(/createVoiceTools\(/);
    expect(src).toMatch(/createMeetingTools\(\)/);
    // The call log has to reach the tool, or an agent-PLACED call writes no row
    // and the Communications call list stays inbound-only.
    expect(src).toMatch(/callLog: opts\.callLog/);
  });
});

// E3 — `call` goes live. Its availability is derived from the SAME config
// derivation the voice stack uses (`resolveSipTrunkClient`), so "the tool is
// advertised" and "the deployment can dial" cannot disagree.
describe('call tool availability tracks the configured trunk', () => {
  function voiceConfig(voice: WiringConfig['voice']): WiringConfig {
    return { provider: 'anthropic', model: 'm', apiKey: 'k', ...(voice ? { voice } : {}) };
  }

  function advertised(config: WiringConfig): Set<string> {
    const registry = new DefaultToolRegistry();
    const trunk = resolveSipTrunkClient(config);
    for (const tool of createVoiceTools({
      ...(trunk ? { trunk } : {}),
      ...(config.voice?.trunk?.fromNumber ? { fromNumber: config.voice.trunk.fromNumber } : {}),
    })) {
      registry.register(tool);
    }
    return new Set(registry.toDefinitions().map((d) => d.name));
  }

  const TRUNKED: WiringConfig['voice'] = {
    bots: [],
    livekit: { url: 'wss://lk.example', apiKey: 'k', apiSecret: 's' },
    trunk: { provider: 'livekit', trunkId: 'T1', fromNumber: '+15550001111' },
  };

  it('advertises call once a trunk is configured', () => {
    expect(advertised(voiceConfig(TRUNKED)).has('call')).toBe(true);
  });

  it('does not advertise call with no voice block at all', () => {
    expect(advertised(voiceConfig(undefined)).has('call')).toBe(false);
  });

  it('does not advertise call when the trunk has no LiveKit credentials to sign with', () => {
    expect(
      advertised(voiceConfig({ bots: [], trunk: { provider: 'twilio', trunkId: 'T1' } })).has(
        'call',
      ),
    ).toBe(false);
  });

  it('keeps its clear error when it is not configured', async () => {
    const call = createVoiceTools().find((t) => t.name === 'call');
    const result = await call?.execute({ to_number: '+15551230000' }, {} as never);
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
  });

  // The gate that matters: a live `call` tool is one an autonomous turn could
  // reach, so the approval surface must flag it BEFORE the capability is on.
  it('is flagged by the approval predicate — always ask, and never confirmable by a caller', async () => {
    expect(APPROVAL_SURFACE_ALWAYS_ASK).toContain('call');
    expect(SPOKEN_CONFIRMATION_TOOLS).toContain('call');

    const predicate = createApprovalDangerPredicate({
      hooks: [new DefaultHookRegistry()],
      personalities: new DefaultPersonalityRegistry(),
      getProvider: async () => {
        throw new Error('provider must not be constructed here');
      },
      model: 'unused',
      alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
    });
    const payload = {
      sessionId: 's1',
      toolCallId: 'tc-1',
      toolName: 'call',
      args: { to_number: '+15551230000' },
    };
    expect(await predicate(payload)).toMatch(/requires explicit approval/);
  });
});
