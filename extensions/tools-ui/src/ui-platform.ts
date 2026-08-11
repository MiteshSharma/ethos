import type { ToolResult } from '@ethosagent/types';

/**
 * Surfaces that can draw a card envelope.
 *
 * Cards ride `tool_end.structured.card` and are rendered by the web SPA;
 * desktop loads that same SPA, so it renders them too. Everywhere else — CLI,
 * cron, every channel adapter — the answer is prose.
 *
 * This is a BACKSTOP, not the gate. The real gate is the personality toolset
 * plus channel policy, which drops the `ui` toolset before the model ever sees
 * these tools. The check exists so a surface that slips through degrades into
 * a polite refusal instead of emitting a card nobody can see.
 */
export const UI_PLATFORMS = new Set(['web', 'desktop']);

export function isUiPlatform(platform: string | undefined): boolean {
  return platform !== undefined && UI_PLATFORMS.has(platform);
}

/** The one off-surface refusal, shared by `emit_card` and `render_ui`. */
export function offSurfaceRefusal(): ToolResult {
  return {
    ok: false,
    code: 'not_available',
    error: 'Cards render on the web surface; answer in prose here.',
  };
}
