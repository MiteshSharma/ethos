import type { ContextInjector, InjectionResult, PromptContext } from '@ethosagent/types';

// How a voice-capable personality TALKS — the static half of the voice story
// (voice V1a §4).
//
// Static-input rule (see `packages/core/src/__tests__/prompt-prefix-stability.test.ts`):
// the content is built ONCE from the personality id and never consults the
// turn. It must stay byte-identical across turns, because a session mixes typed
// and spoken turns and a per-turn variation here would break the cached static
// prefix for BOTH. The per-turn fact — "this particular turn arrived as
// speech" — is a message-level annotation instead (`./voice-origin`).
//
// Which means: this block is present on typed turns too, for a voice
// personality. That is deliberate. It describes how the personality speaks, the
// same way SOUL.md does; the annotation is what says when it is speaking.

const SPOKEN_STYLE = `## Speaking out loud

Your replies are synthesized to audio. Write for the ear, not the eye.

- Answer in one to three short sentences. If a full answer needs more, give the headline first and offer the rest.
- No markdown: no headings, bullets, tables, bold, or emoji. They are read aloud as noise or silently dropped.
- Never read code, file paths, URLs, IDs, or hashes aloud. Say what they mean ("the config file in your home directory"), and offer to send the exact text.
- Numbers, dates and units go in the form a person would say them.
- Say "one moment" before anything slow, then answer. Silence sounds like a dropped call.
- Heavy work does not belong in a spoken turn: acknowledge it out loud, hand it to a background job, and speak the result when it lands.
- Before anything consequential — spending, sending, deleting, calling someone — say what you are about to do and wait for a clear yes.`;

export interface SpokenStyleInjectorOptions {
  /** Only this personality gets the block. Static input; never per-turn. */
  personalityId: string;
}

/**
 * Build the spoken-style injector for a voice-capable personality.
 *
 * Wiring gates construction on the personality actually being voice-capable
 * (a declared `voice` block, or `voice_session` in its toolset) — a text-only
 * personality must not pay ~900 chars of prompt to be told how to talk.
 */
export function createSpokenStyleInjector(opts: SpokenStyleInjectorOptions): ContextInjector {
  const { personalityId } = opts;
  return {
    id: `spoken-style:${personalityId}`,
    // After the skills index (100) and platform formatting (90), alongside the
    // other personality-scoped guidance blocks (ui-guidance is 31).
    priority: 32,
    shouldInject(ctx: PromptContext): boolean {
      return ctx.personalityId === personalityId;
    },
    async inject(_ctx: PromptContext): Promise<InjectionResult | null> {
      return { content: SPOKEN_STYLE, position: 'append' };
    },
  };
}

/** The rendered block, exported so the prompt-budget test can measure it. */
export const SPOKEN_STYLE_BLOCK = SPOKEN_STYLE;
