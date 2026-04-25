import type { ContextInjector, InjectionResult, PromptContext } from '@ethosagent/types';

const GUIDANCE = `## Memory guidance

You have access to persistent memory across sessions via the \`memory_read\`, \`memory_write\`, and \`session_search\` tools.

**MEMORY.md** — rolling project context. Update it when:
- A significant decision is made
- A task is completed or abandoned
- Important facts about the current project emerge

**USER.md** — persistent user profile. Update it when:
- You learn about the user's role, expertise, or preferences
- Communication style preferences become clear
- Recurring patterns in how they work emerge

Keep entries concise. Use \`memory_write\` with \`action: "add"\` to append new facts. Use \`action: "remove"\` with \`substring_match\` to delete outdated entries before replacing them. Read memory at the start of new tasks to recall prior context.`.trim();

export class MemoryGuidanceInjector implements ContextInjector {
  readonly id = 'memory-guidance';
  readonly priority = 80;

  shouldInject(ctx: PromptContext): boolean {
    // Only inject if there's a meaningful conversation going on (not turn 0)
    return ctx.turnNumber > 0;
  }

  async inject(_ctx: PromptContext): Promise<InjectionResult | null> {
    return { content: GUIDANCE, position: 'append' };
  }
}
