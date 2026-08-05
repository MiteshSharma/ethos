// Item 7 stage 3 — ghost-skill defense.
//
// Under `skills.injection_mode: 'index'` (the DEFAULT) only a stub table of
// skill names + descriptions enters the system prompt. The body of a skill
// arrives later, as a `get_skill` tool_result in the MESSAGE ARRAY — see
// `extensions/skills/src/get-skill-tool.ts`. Three shipped mechanisms can prune
// that message content, none of them skill-aware:
//
//   • tool-result aging hard-clear (`tool-result-aging.ts`) — replaces the body
//     with a generic "re-run the tool" placeholder;
//   • the compaction prefix drop (`manual-compact.ts` watermark reconstruct) —
//     removes the message entirely, leaving NO marker at all;
//   • tool-result dedup (`history.ts`) — replaces a repeat load with a pointer
//     BACK at an earlier copy that compaction may since have dropped.
//
// The result is a ghost: the stub in the prompt still tells the model it HAS
// the skill, while the instructions it would follow are gone. The model then
// confabulates the procedure instead of re-loading it. Every marker below
// exists to say the one thing that fixes that — "you no longer have this; call
// `get_skill` again".
//
// Scope: index mode ONLY. Under `injection_mode: 'full'` the body lives in the
// static prefix, which no pruner touches, so none of this machinery runs.
//
// The signal is the `get_skill` tool call itself, NOT `activeSkillFiles`
// (`stages/context-assembly.ts`) — that tracks skills the injector INJECTED,
// which is the exact complement of the population at risk here.

import type { Message, StoredMessage } from '@ethosagent/types';

/** The framework tool whose results carry skill bodies in index mode. */
export const GET_SKILL_TOOL = 'get_skill';

/** True when this personality's skills arrive as `get_skill` results. */
export function usesSkillIndexMode(injectionMode: 'full' | 'index' | undefined): boolean {
  return (injectionMode ?? 'index') === 'index';
}

/** Marker left in place of a pruned skill body. Names the skill and the fix. */
export function ghostSkillMarker(skillName: string): string {
  return (
    `[skill "${skillName}" was loaded earlier, but its instructions are no longer in ` +
    `context. Do NOT rely on memory of them — call get_skill("${skillName}") again ` +
    `before executing this skill.]`
  );
}

/** Marker for skills whose whole `get_skill` message was dropped by compaction. */
export function ghostSkillNotice(skillNames: string[]): string {
  const list = skillNames.map((n) => `"${n}"`).join(', ');
  return (
    `[compaction dropped the loaded instructions for ${skillNames.length} skill(s): ${list}. ` +
    'They are still listed as available, but you no longer have their bodies — call ' +
    'get_skill(name) again before executing any of them.]'
  );
}

function skillNameFromInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const name = (input as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/**
 * `tool_use_id` → skill name for every `get_skill` call in an LLM message view.
 * Empty when the history contains none, which is the common case — callers can
 * skip the whole defense on an empty map.
 */
export function skillCallsFromMessages(messages: Message[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type !== 'tool_use' || block.name !== GET_SKILL_TOOL) continue;
      const name = skillNameFromInput(block.input);
      if (name) out.set(block.id, name);
    }
  }
  return out;
}

/** Same map, derived from stored history (`toolCalls` on assistant rows). */
export function skillCallsFromHistory(history: StoredMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of history) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const tc of m.toolCalls) {
      if (tc.name !== GET_SKILL_TOOL) continue;
      const name = skillNameFromInput(tc.input);
      if (name) out.set(tc.id, name);
    }
  }
  return out;
}

/**
 * Skill names whose `get_skill` result rows sit inside `slice` — the names a
 * caller about to drop that slice must warn about. Deduped, in first-seen order
 * so the rendered notice is byte-stable across turns.
 */
export function droppedSkillNames(
  slice: StoredMessage[],
  skillCalls: Map<string, string>,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of slice) {
    if (m.role !== 'tool_result' || !m.toolCallId) continue;
    const name = skillCalls.get(m.toolCallId);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
