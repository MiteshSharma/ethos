// SelfSaveMarker — "saves on its own" (plan §6.2, §6.4, D11). Placed next to
// every control that bypasses the page's Save button.
//
// One marker per distinct UI area, not one per `SETTINGS_INDEX` entry with
// `saves: 'self'` — several entries (e.g. the four create-API-key-modal
// fields) describe ONE control area, expanded in the index for
// searchability (D8), not because the UI grew that many independent widgets.
//
// No props: it is a dumb, literal marker. Pane authors place it manually next
// to the control(s) it describes.

export function SelfSaveMarker() {
  return <span className="settings-self-save-marker">saves on its own</span>;
}
