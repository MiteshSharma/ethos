// Pure logic for P4 (plan/phases/personality-first-ui.md) — the Identity
// page's Retire action. Split out so the built-in gate and confirm copy are
// unit-testable without mounting `PersonalityDetail.tsx`.

/**
 * Built-in personalities have no `~/.ethos/personalities/<id>/` directory to
 * remove — Retire stays hidden, the same gate the Personalities list page's
 * row menu already applies to its Delete item.
 */
export function canRetirePersonality(personality: { builtin?: boolean | null }): boolean {
  return !personality.builtin;
}

/**
 * Confirm-dialog copy for Retire. Same body copy as the list page's delete
 * confirm (`modal.confirm` in `Personalities.tsx`'s `PersonalityRowActions`)
 * — "Retire" in place of "Delete" per the P4 plan section ("copy may say
 * 'Retire' over `delete`"). The underlying call is still `personalities.delete`.
 */
export function retireConfirmCopy(name: string): {
  title: string;
  content: string;
  okText: string;
} {
  return {
    title: `Retire ${name}?`,
    content: 'The directory under ~/.ethos/personalities/ is removed.',
    okText: 'Retire',
  };
}
