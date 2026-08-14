// Pure logic for the New Session personality picker. Extracted from the
// modal component so it can be unit-tested without a DOM.

export interface PickerPersonality {
  id: string;
  name: string;
  description?: string | null;
}

// Meta-personalities that should never start a chat.
export const HIDDEN_FROM_CHAT = new Set(['personality-architect', 'team-architect']);

/**
 * Applies the hidden-agent filter plus a case-insensitive name/description
 * substring match. An empty (or whitespace-only) query returns all visible
 * personalities.
 */
export function filterPersonalities<T extends PickerPersonality>(
  items: T[],
  query: string,
  hidden: Set<string> = HIDDEN_FROM_CHAT,
): T[] {
  const visible = items.filter((p) => !hidden.has(p.id));
  const q = query.trim().toLowerCase();
  if (!q) return visible;
  return visible.filter((p) => {
    const haystack = `${p.name} ${p.description ?? ''}`.toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Picks the initial highlighted id: the active personality when present in
 * the filtered list, otherwise the first item, otherwise null.
 */
export function resolveInitialSelection<T extends PickerPersonality>(
  filtered: T[],
  activeId: string | null,
): string | null {
  if (activeId && filtered.some((p) => p.id === activeId)) return activeId;
  return filtered[0]?.id ?? null;
}

/**
 * Moves the selection up (-1) or down (1) among the filtered list, clamped
 * at both ends (no wrap). Returns the resulting id, or the current id when
 * it can't move (empty list / current not found).
 */
export function moveSelection<T extends PickerPersonality>(
  filtered: T[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (filtered.length === 0) return currentId;
  const idx = filtered.findIndex((p) => p.id === currentId);
  if (idx === -1) return filtered[0]?.id ?? currentId;
  const nextIdx = Math.min(filtered.length - 1, Math.max(0, idx + direction));
  return filtered[nextIdx]?.id ?? currentId;
}

/**
 * The "new session" navigation contract: selecting a personality must start
 * a FRESH session under it. The `new=1` flag is what Chat.tsx keys on to
 * reset the active session — and it is required, because a session belongs
 * to the personality it started with, so a personality deep-link without it
 * is ignored rather than applied to a conversation already under way.
 */
export function buildNewSessionPath(id: string): string {
  return `/chat?personality=${encodeURIComponent(id)}&new=1`;
}
