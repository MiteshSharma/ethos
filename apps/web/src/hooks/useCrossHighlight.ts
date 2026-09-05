import { type RefObject, useEffect } from 'react';

// Cross-highlight on hover (plan/phases/teams-as-a-scope.md D12, T4): every
// element that belongs to a member carries `data-p="<personalityId>"` — rail
// avatar, member row, tile, structure node, ledger line, recent session.
// Hovering any of them lights up all of them and dims the rest, across
// panes. ONE delegated `mouseover`/`mouseout` pair on the shell root, active
// only inside a team; the classes are what `team-panes.css` styles.

export const HL_ROOT_CLASS = 'is-hl-on';
export const HL_CLASS = 'is-hl';

export function useCrossHighlight(root: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const el = root.current;
    if (!el || !active) return;

    const clear = () => {
      el.classList.remove(HL_ROOT_CLASS);
      for (const x of el.querySelectorAll(`.${HL_CLASS}`)) x.classList.remove(HL_CLASS);
    };

    const onOver = (e: MouseEvent) => {
      const hit = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-p]') : null;
      const id = hit?.dataset.p;
      if (!id) return;
      el.classList.add(HL_ROOT_CLASS);
      for (const x of el.querySelectorAll<HTMLElement>('[data-p]')) {
        x.classList.toggle(HL_CLASS, x.dataset.p === id);
      }
    };

    const onOut = (e: MouseEvent) => {
      const hit = e.target instanceof Element ? e.target.closest('[data-p]') : null;
      if (!hit) return;
      // Moving between children of the same carrier is not a leave.
      const related = e.relatedTarget;
      if (related instanceof Element && related.closest('[data-p]') === hit) return;
      clear();
    };

    el.addEventListener('mouseover', onOver);
    el.addEventListener('mouseout', onOut);
    return () => {
      el.removeEventListener('mouseover', onOver);
      el.removeEventListener('mouseout', onOut);
      clear();
    };
  }, [root, active]);
}
