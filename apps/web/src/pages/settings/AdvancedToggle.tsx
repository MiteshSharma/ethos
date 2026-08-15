// The advanced switch, plus how many controls it is talking about.
//
// The count is derived from `SETTINGS_INDEX` (D8) — a hand-written figure here
// would be wrong within a release and nobody would notice, because nobody counts
// switches. Mono with tabular figures (DESIGN.md "Typography"), same treatment
// as every other number the operator also reads out of `config.yaml`.
//
// The toggle now DIMS rather than hides (D10), so the label says what it does.

import { Switch } from 'antd';
import { advancedCount } from './lib/settings-index';

export function AdvancedToggle({
  showAdvanced,
  onChange,
}: {
  showAdvanced: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className="settings-advanced-toggle">
      <span className="settings-advanced-label">Show advanced</span>
      <span className="settings-advanced-count">{advancedCount()} advanced</span>
      <Switch checked={showAdvanced} onChange={onChange} aria-label="Show advanced settings" />
    </span>
  );
}
