import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DefaultToolRegistry } from '@ethosagent/core';
import { createMeetingTools } from '@ethosagent/tools-meeting';
import { createVoiceTools } from '@ethosagent/tools-voice';
import { describe, expect, it } from 'vitest';

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
  });
});
