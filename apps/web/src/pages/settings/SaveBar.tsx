// The page Save, sticky at the bottom of the detail column.
//
// It calls `form.submit()` rather than carrying `htmlType="submit"`, because the
// shell's `<Form>` renders `component={false}` and there is no `<form>` node to
// submit (D2). The dirty count and the affected-category list are Phase 2.

import { Button } from 'antd';

export function SaveBar({ loading, onSave }: { loading: boolean; onSave: () => void }) {
  return (
    <div className="settings-savebar">
      <Button type="primary" loading={loading} onClick={onSave}>
        Save
      </Button>
    </div>
  );
}
