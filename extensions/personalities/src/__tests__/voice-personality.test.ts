// The built-in `voice` personality (voice V1a §4) and its prompt budget.
//
// Latency decision L5 puts a HARD ~2k-token cap on this personality's static
// prompt: it routes to a fast model precisely so a spoken turn answers inside
// the mouth-to-ear budget, and every token of static prompt is time-to-first-
// sentence paid on every utterance. A prompt budget that only lives in a plan
// document erodes — one useful paragraph at a time — so it lives here instead.

import { readFile } from 'node:fs/promises';
import { estimateTokens, SPOKEN_STYLE_BLOCK } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { createPersonalityRegistry } from '../index';

/** Latency decision L5. */
const STATIC_PROMPT_TOKEN_BUDGET = 2_000;

async function voicePersonality() {
  const registry = await createPersonalityRegistry(new FsStorage());
  const config = registry.get('voice');
  if (!config) throw new Error('built-in `voice` personality is missing');
  return config;
}

describe('built-in `voice` personality', () => {
  it('ships as a built-in', async () => {
    const registry = await createPersonalityRegistry(new FsStorage());
    expect(registry.list().map((p) => p.id)).toContain('voice');
  });

  it('declares the voice identity the TTS surfaces read', async () => {
    const config = await voicePersonality();
    expect(config.voice?.tts_voice).toBe('af_bella');
    expect(config.voice?.tier).toBe('pipeline');
    // Fast-lane model (L5). Present as a FIELD, not just as the base model:
    // it is what `resolveVoicePreferences` and the character sheet read.
    expect(config.voice?.model).toBeTruthy();
    expect(config.voice?.languages?.es).toBe('ef_dora');
  });

  it('routes to a fast model, and nothing turns thinking on', async () => {
    const config = await voicePersonality();
    // A non-thinking model: `thinkingBudget` is a per-completion option that
    // nothing in the personality path sets, so a model without extended
    // thinking is how "thinking off" is expressed — there is no personality
    // field to switch it off with, and adding one is forbidden.
    expect(config.model).toBe('claude-haiku-4-5');
    expect(JSON.stringify(config)).not.toContain('thinking');
  });

  it('carries a restricted toolset — nothing that writes, shells out, or spawns', async () => {
    const config = await voicePersonality();
    const toolset = config.toolset ?? [];
    expect(toolset.length).toBeGreaterThan(0);
    for (const forbidden of [
      'terminal',
      'write_file',
      'patch_file',
      'process_start',
      'execute_code',
      'run_code',
    ]) {
      expect(toolset).not.toContain(forbidden);
    }
    // Escalation path (L5): heavy work leaves the spoken lane.
    expect(toolset).toContain('delegate_task');
  });

  it('is the first built-in that can actually be dialed — it lists `voice_session`', async () => {
    const config = await voicePersonality();
    expect(config.toolset).toContain('voice_session');
  });

  // The gate. SOUL.md is the personality's whole static identity contribution,
  // and the spoken-style injector is the only other static block this
  // personality adds; together they are what a spoken turn pays before a single
  // word of the user's question.
  it('keeps its static prompt under the ~2k-token latency budget', async () => {
    const config = await voicePersonality();
    const soul = config.soulFile ? await readFile(config.soulFile, 'utf8') : '';
    expect(soul.length).toBeGreaterThan(0);

    const staticPrompt = `${soul.trim()}\n\n${SPOKEN_STYLE_BLOCK}`;
    const tokens = estimateTokens(staticPrompt);

    // Reported on failure so the message says how far over it went.
    expect(
      tokens,
      `voice personality static prompt is ${tokens} tokens (${staticPrompt.length} chars), ` +
        `budget is ${STATIC_PROMPT_TOKEN_BUDGET}`,
    ).toBeLessThan(STATIC_PROMPT_TOKEN_BUDGET);
  });

  it('does not read code, URLs or paths aloud — stated in SOUL.md, not just implied', async () => {
    const config = await voicePersonality();
    const soul = config.soulFile ? await readFile(config.soulFile, 'utf8') : '';
    expect(soul).toMatch(/never read code, file paths, URLs/i);
  });
});
