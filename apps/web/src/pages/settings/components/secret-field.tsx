// SecretField — the one Set / Replace / Clear control for a vault credential
// (plan/phases/keys-secrets-page.md, "The Set/Replace/Clear component").
//
// Three states, and the transitions between them are the whole component:
//
//   unset   — nothing stored. "Set" opens the editor.
//   masked  — a value is stored; only its masked preview is ever shown.
//             "Replace" opens the editor, "Clear" deletes it.
//   editing — one `Input.Password` per field, empty. Save writes; Cancel drops.
//
// Two rules it exists to enforce:
//
//   1. A real value is NEVER round-tripped into the input. The stored preview
//      is a `placeholder`, never a `value` — so the DOM the browser (and any
//      extension reading it) sees holds only what the operator just typed.
//   2. A blank Save is a NO-OP, not a clear. Deleting a credential is the
//      Popconfirm-gated destructive action and nothing else, so an operator
//      who opens the editor, thinks better of it and presses Save cannot wipe
//      a working key by pressing the friendly-looking button.
//
// Built on `SettingRow`, not `Card` — DESIGN.md:165 "Cards earn existence": a
// credential row is a row, and it is the densest thing on the page.
//
// THREE SHAPES, three layouts:
//
//   single — one `SettingRow`, control on the right. The common case.
//   multi  — one credential spread over sibling refs (Slack's bot/app/signing
//            triple, LiveKit's key/secret pair). Rendered as models.tsx renders
//            its own multi-field groups (`AuxModelFieldGroup`): a `ROW_BOX_STYLE`
//            box — raw primitives, not the `Card` primitive — with a bold group
//            label, then one `SettingRow` per field, then ONE action bar. One
//            Save, all-or-nothing: the service refuses a partial write, so a
//            per-field Save button would be a button that mostly fails.
//   blob   — a document minted by a sign-in flow, not typed. No editor at all;
//            see `ConnectionRow`.
//
// `onTest` renders only where the catalog entry carries a `probe`. Exa, Tavily
// and Brave are the only three with a real live probe today (they reflect
// `NamedSecretsService.testKey`); a Test button on anything else would be a
// button that cannot answer the question it asks.

import { Button, Input, Popconfirm, Space, Tag, Typography } from 'antd';
import { type ReactNode, useState } from 'react';
import type { rpc } from '../../../rpc';
import { ROW_BOX_STYLE } from './primitives';
import { SettingRow } from './setting-row';

/** One row of `rpc.keys.list()` — the contract's own type, never a copy. */
export type KeyEntryView = Awaited<
  ReturnType<typeof rpc.keys.list>
>['categories'][number]['entries'][number];

const MONO = { fontFamily: 'Geist Mono, monospace', fontSize: 12 } as const;

export type SecretFieldState = 'unset' | 'masked' | 'editing';

export function SecretField({
  entry,
  onSave,
  onClear,
  onTest,
  saving,
  clearing,
}: {
  entry: KeyEntryView;
  /** Called only with a COMPLETE set of non-blank values. */
  onSave: (values: Record<string, string>) => void;
  onClear: () => void;
  /** Rendered only when `entry.probe` is set — see the header note. */
  onTest?: () => Promise<{ ok: boolean; error?: string }>;
  saving?: boolean;
  clearing?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [test, setTest] = useState<{ status: 'idle' | 'testing' | 'ok' | 'error'; error?: string }>(
    {
      status: 'idle',
    },
  );

  const anySet = entry.set || entry.fields.some((f) => f.set);
  const state: SecretFieldState = editing ? 'editing' : anySet ? 'masked' : 'unset';

  // Every field must carry a non-blank value. A `multi` credential is
  // all-or-nothing (the service rejects a partial write anyway), and a blank
  // `single` is the no-op this component exists to guarantee.
  const complete =
    entry.fields.length > 0 && entry.fields.every((f) => (values[f.key] ?? '').trim().length > 0);

  const openEditor = () => {
    setValues({});
    setTest({ status: 'idle' });
    setEditing(true);
  };

  const closeEditor = () => {
    setValues({});
    setEditing(false);
  };

  const handleSave = () => {
    // Guarded here as well as on the button's `disabled`: a blank Save must be
    // inert however it is reached, not merely hard to reach.
    if (!complete) return;
    const trimmed: Record<string, string> = {};
    for (const field of entry.fields) trimmed[field.key] = (values[field.key] ?? '').trim();
    onSave(trimmed);
    closeEditor();
  };

  const handleTest = async () => {
    if (!onTest) return;
    setTest({ status: 'testing' });
    try {
      const result = await onTest();
      setTest(result.ok ? { status: 'ok' } : { status: 'error', error: result.error });
    } catch (err) {
      setTest({ status: 'error', error: (err as Error).message });
    }
  };

  const passwordInput = (field: KeyEntryView['fields'][number]) => (
    <Input.Password
      key={field.key}
      size="small"
      autoComplete="off"
      aria-label={field.label}
      // The stored value is a PLACEHOLDER, never a value — rule 1.
      placeholder={field.set ? field.preview : `paste ${field.label.toLowerCase()}`}
      value={values[field.key] ?? ''}
      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
    />
  );

  const editorActions = (
    <Space size={8}>
      <Button
        size="small"
        type="primary"
        disabled={!complete}
        loading={saving}
        onClick={handleSave}
      >
        Save
      </Button>
      <Button size="small" onClick={closeEditor}>
        Cancel
      </Button>
      {entry.getKeyUrl ? <GetKeyLink href={entry.getKeyUrl} /> : null}
    </Space>
  );

  const restingActions = (
    <>
      {entry.canSet ? (
        <Button size="small" onClick={openEditor}>
          {state === 'masked' ? 'Replace' : 'Set'}
        </Button>
      ) : null}
      {entry.probe && onTest ? (
        <Button size="small" onClick={handleTest} loading={test.status === 'testing'}>
          Test
        </Button>
      ) : null}
      {test.status === 'ok' ? <Tag color="success">Key accepted</Tag> : null}
      {test.status === 'error' ? <Tag color="error">{test.error ?? 'Failed'}</Tag> : null}
      {state === 'masked' && entry.canClear ? (
        <Popconfirm
          title="Clear this key"
          description="The stored value is deleted. Anything using it stops working until you set a new one."
          okText="Clear"
          okButtonProps={{ danger: true }}
          cancelText="Cancel"
          onConfirm={onClear}
        >
          <Button size="small" danger loading={clearing}>
            Clear
          </Button>
        </Popconfirm>
      ) : null}
      {state === 'unset' && entry.getKeyUrl ? <GetKeyLink href={entry.getKeyUrl} /> : null}
    </>
  );

  // --- multi: the models.tsx group box, one Save for the whole credential ---
  if (entry.shape === 'multi') {
    return (
      <div style={ROW_BOX_STYLE}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          {entry.label}
        </Typography.Text>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
          {entry.canSet
            ? 'These are written together — saving replaces every field, and a partial save is refused.'
            : 'Managed under Security & access.'}
        </Typography.Paragraph>
        {entry.fields.map((field) => (
          <SettingRow key={field.key} label={field.label} help={field.ref}>
            {state === 'editing' ? (
              <div style={{ width: 280 }}>{passwordInput(field)}</div>
            ) : (
              <MaskedText>{field.set ? field.preview : 'Not set'}</MaskedText>
            )}
          </SettingRow>
        ))}
        <div style={{ marginTop: 10 }}>
          {state === 'editing' ? (
            editorActions
          ) : (
            <Space size={8} wrap>
              {restingActions}
            </Space>
          )}
        </div>
      </div>
    );
  }

  // --- single: one row, control on the right ------------------------------
  const refs = entry.fields.map((f) => f.ref);
  const help = entry.canSet
    ? refs.join('  ·  ')
    : `${refs.join('  ·  ')} — managed under Security & access.`;

  return (
    <SettingRow label={entry.label} help={help}>
      {state === 'editing' ? (
        <Space direction="vertical" size={6} style={{ width: 280 }}>
          {entry.fields.map(passwordInput)}
          {editorActions}
        </Space>
      ) : (
        <Space size={8} wrap>
          {state === 'masked' ? (
            <MaskedText>{entry.fields.map((f) => f.preview).join('  ·  ')}</MaskedText>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Not set
            </Typography.Text>
          )}
          {restingActions}
        </Space>
      )}
    </SettingRow>
  );
}

/**
 * ConnectionRow — a `blob` entry: an authorization minted by a sign-in flow,
 * not a value anyone types. Today that is codex only.
 *
 * There is no Set, no Replace and no Test, because none of the three has a
 * backing operation: `KeysService.set` refuses a blob, the device-auth flow
 * lives in the CLI (an explicit non-goal of this plan), and no probe exists.
 * What is left is a status line and Disconnect.
 *
 * "Disconnect", not "Revoke", and the help text says why: `CodexTokenStore`
 * has no `revoke()`. Clearing deletes the LOCAL token document; the upstream
 * authorization is untouched. Labelling that button "Revoke" would promise an
 * upstream effect that never happens.
 */
export function ConnectionRow({
  entry,
  onClear,
  clearing,
}: {
  entry: KeyEntryView;
  onClear: () => void;
  clearing?: boolean;
}) {
  const accountId = entry.details?.accountId;
  const expiresAt = entry.details?.expiresAt;
  const expiry = expiresAt ? new Date(expiresAt) : null;
  const expiryValid = expiry !== null && !Number.isNaN(expiry.getTime());
  const expired = expiryValid && expiry.getTime() <= Date.now();

  const status = !entry.set
    ? 'Not connected'
    : expired
      ? 'Expired'
      : expiryValid
        ? `Connected — expires ${expiry.toLocaleString()}`
        : 'Connected';

  const help = entry.set
    ? 'Issued by the CLI sign-in flow. Disconnecting deletes the token stored on this machine; it does not revoke the authorization upstream.'
    : 'Sign in from the CLI to connect this account.';

  return (
    <SettingRow label={entry.label} help={help}>
      <Space size={8} wrap>
        {expired ? (
          <Tag color="warning">Expired</Tag>
        ) : entry.set ? (
          <Tag color="success">Connected</Tag>
        ) : null}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {status}
        </Typography.Text>
        {accountId ? <MaskedText>{accountId}</MaskedText> : null}
        {entry.set && entry.canClear ? (
          <Popconfirm
            title="Disconnect this account"
            description="The token stored on this machine is deleted. Access upstream is not revoked — sign in again from the CLI to reconnect."
            okText="Disconnect"
            okButtonProps={{ danger: true }}
            cancelText="Cancel"
            onConfirm={onClear}
          >
            <Button size="small" danger loading={clearing}>
              Disconnect
            </Button>
          </Popconfirm>
        ) : null}
      </Space>
    </SettingRow>
  );
}

function MaskedText({ children }: { children: ReactNode }) {
  return (
    <Typography.Text type="secondary" style={MONO}>
      {children}
    </Typography.Text>
  );
}

function GetKeyLink({ href }: { href: string }) {
  return (
    <Typography.Link href={href} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
      Get a key
    </Typography.Link>
  );
}
