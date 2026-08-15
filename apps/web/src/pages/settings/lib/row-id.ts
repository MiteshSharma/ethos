/**
 * One counter for every repeatable-row editor on the Settings surface.
 *
 * The rows live in `SettingsShell` and are rendered by panes that mount and
 * unmount as you navigate, so `_id` has to be unique across ALL of them or React
 * reuses a row's DOM for a different row. It was a module-scope `let` inside
 * `Settings.tsx` when every editor lived in one file; the split makes it a
 * function because an imported binding cannot be incremented from another
 * module.
 */
let next = 1;

export function nextRowId(): number {
  return next++;
}
