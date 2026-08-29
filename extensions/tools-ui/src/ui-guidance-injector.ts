import type { ContextInjector, InjectionResult, PromptContext } from '@ethosagent/types';
import { isUiPlatform } from './ui-platform';

export interface UiTemplateEntry {
  name: string;
  description?: string;
}

export interface UiGuidanceInjectorOptions {
  personalityId: string;
  /** The personality's `ui/*.html` catalog, scanned ONCE at composition time. */
  templates: ReadonlyArray<UiTemplateEntry>;
}

const COMPOSITION_RULES = `## Composing a UI turn

You can answer on this surface with typed cards (\`emit_card\`) and Canvas (\`render_ui\`). Compose by shape, not by decoration — never reach for a card to make an answer look impressive.

- Prose is the durable answer. A card never replaces the explanation.
- Order: data cards first, then at most one short prose caption, then \`recommend_actions\` LAST — only when a genuine next step exists, and never more than 3.
- Match the kind to the shape of the data: a series -> \`metric_chart\`; rows -> \`data_table\`; one record -> \`detail\`; a set of like things -> \`item_list\`.
- Reach for \`render_ui\` only for shapes the eight card kinds cannot express.`;

/**
 * Tells a `ui`-capable personality HOW to compose a turn out of cards, and what
 * Canvas templates it owns.
 *
 * The content is built once, here, from static inputs only. It must stay
 * byte-identical across turns or it breaks the static prompt prefix that
 * prefix caching depends on — which is why the template catalog is passed in
 * rather than listed from disk per turn
 * (`packages/core/src/__tests__/prompt-prefix-stability.test.ts` is the gate).
 */
export function createUiGuidanceInjector(opts: UiGuidanceInjectorOptions): ContextInjector {
  const { personalityId, templates } = opts;
  const catalog =
    templates.length > 0
      ? `\n\n### Your Canvas templates\nPass the name to \`render_ui({ template })\`.\n${templates
          .map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ''}`)
          .join('\n')}`
      : '';
  const content = `${COMPOSITION_RULES}${catalog}`;

  return {
    id: `ui-guidance:${personalityId}`,
    priority: 31,
    shouldInject(ctx: PromptContext): boolean {
      // Personality AND platform: both tools refuse off-web, so on a CLI or
      // channel turn these rules are ~700 chars teaching an unusable move.
      // Platform is fixed per surface, so gating on it keeps the prefix stable.
      return ctx.personalityId === personalityId && isUiPlatform(ctx.platform);
    },
    async inject(_ctx: PromptContext): Promise<InjectionResult | null> {
      return { content };
    },
  };
}
