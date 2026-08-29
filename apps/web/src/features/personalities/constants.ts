// System/utility personalities (Debug Assistant, Personality Architect,
// Team Architect) are internal tooling, not agents a user picks as their
// "main agent" — so they're excluded from the sidebar rail, the personality
// picker modal, and the command palette's Agents group. They stay fully
// functional and visible everywhere else: the Personalities management
// page, session history, the current-session identity display, and
// internal flows (e.g. "Create with architect") that invoke them directly.
export const SYSTEM_PERSONALITY_IDS = new Set(['debug', 'personality-architect', 'team-architect']);

/** Excludes SYSTEM_PERSONALITY_IDS from a personality list, for surfaces
 *  where picking an entry means choosing a main agent. */
export function filterSelectablePersonalities<T extends { id: string }>(items: readonly T[]): T[] {
  return items.filter((p) => !SYSTEM_PERSONALITY_IDS.has(p.id));
}
