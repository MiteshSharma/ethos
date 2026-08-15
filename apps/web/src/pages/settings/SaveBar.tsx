// The page Save, sticky at the bottom of the detail column.
//
// It calls `form.submit()` rather than carrying `htmlType="submit"`, because the
// shell's `<Form>` renders `component={false}` and there is no `<form>` node to
// submit (D2).
//
// The count beside it is cross-category by construction (D9): the save writes
// every category at once, so a bar that only counted the pane on screen would
// under-report exactly what it is about to do. `3 changes · Voice, Memory`.

import { Button } from 'antd';
import type { DirtyState } from './lib/settings-dirty';
import type { SettingsCategory } from './lib/taxonomy';

export function SaveBar({
  loading,
  onSave,
  dirty,
  categories,
}: {
  loading: boolean;
  onSave: () => void;
  dirty: DirtyState;
  categories: SettingsCategory[];
}) {
  const labels = dirty.categories.map(
    (slug) => categories.find((c) => c.slug === slug)?.label ?? slug,
  );
  return (
    <div className="settings-savebar">
      <Button type="primary" loading={loading} onClick={onSave}>
        Save
      </Button>
      {dirty.count > 0 ? (
        <span className="settings-savebar-dirty">
          <span className="settings-savebar-count">{dirty.count}</span>
          {dirty.count === 1 ? ' change' : ' changes'}
          {labels.length > 0 ? ` · ${labels.join(', ')}` : ''}
        </span>
      ) : null}
    </div>
  );
}
