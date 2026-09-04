import { CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { Button, Typography } from 'antd';
import { useEffect } from 'react';

// One save affordance for every editable tab of the personality Edit modal.
//
// The point is that a tab never behaves differently from its neighbour: the
// bar always sits last in the pane, always says whether there is anything
// unsaved, and always carries the same verb. Tabs with their own CRUD flows
// (Skills) and read-only tabs (Character sheet) do not get one.
//
// The saved confirmation is NOT a timed toast — it holds until the next edit.
// A confirmation that disappears on its own is exactly what makes a user
// unsure whether the write landed, and the mutation's own notification
// already covers the momentary "it happened" signal.

export function TabSaveBar({
  dirty,
  saving,
  saveSucceeded,
  onSave,
  onDirtyChange,
}: {
  /** Draft differs from what is stored. */
  dirty: boolean;
  /** A save is in flight. */
  saving: boolean;
  /** The last save attempt succeeded (react-query's `mutation.isSuccess`). */
  saveSucceeded: boolean;
  onSave: () => void;
  /** Lets the modal's close-guard see this tab's dirty state. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  useEffect(() => {
    onDirtyChange?.(dirty);
    // A pane that goes away has nothing left to lose.
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        marginTop: 16,
        paddingTop: 16,
        borderTop: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 22 }}>
        {dirty ? (
          <>
            <ExclamationCircleOutlined
              style={{ color: 'var(--ethos-warning)', fontSize: 12 }}
              aria-hidden
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Unsaved changes
            </Typography.Text>
          </>
        ) : saveSucceeded && !saving ? (
          <>
            <CheckCircleOutlined
              style={{ color: 'var(--ethos-success)', fontSize: 12 }}
              aria-hidden
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Saved
            </Typography.Text>
          </>
        ) : null}
      </div>
      <Button type="primary" disabled={!dirty} loading={saving} onClick={onSave}>
        Save
      </Button>
    </div>
  );
}
