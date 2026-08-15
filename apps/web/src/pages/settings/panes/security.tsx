// Security & access — approval mode (with the admin gate), named secrets,
// web-search defaults, API keys, A2A. Moved verbatim from `Settings.tsx`
// (§4.2 rows 5, 11, 19, 20, 21 and the API-keys section), off `Card` onto
// `SettingRow` / `SectionHeading` (Phase 4).
//
// Four of these five sections SAVE ON THEIR OWN and not with the page Save:
// named secrets, API keys and A2A are mutations against separate stores, and
// web-search defaults has its own button. They render inside the outlet, and
// therefore inside the shell's `<Form>` — which is exactly why that form carries
// `component={false}` (D2): with a real `<form>` node, pressing Enter in the
// named-secret or API-key name field would submit the PAGE form and write ~107
// config keys as a side effect of typing.
//
// `Admin` is here, not in Developer: enabling a system-operations console is a
// privilege decision (O2), and it lands as the LAST row of `approval mode` —
// the section is already the privilege-decision section of this category — not
// as a section of its own.
//
// §8.g, fixed HERE: the button used to follow the SAVED value for both its
// visibility and its margin, while the checkbox wrote the FORM value — ticking
// the box did nothing visible until Save + refetch. `AdminPanelGate` below is
// the fix: the button still follows the SAVED value (the server gate,
// `admin.service.ts:18` → `config.service.ts`, reads the config FILE, not the
// browser's form store, so a live-value button would 403), but the LIVE value
// is acknowledged immediately with an honest note instead of staying silent.

import type { ApiKeyMetadata, ApiKeyScope } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Radio,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AddSecretModal } from '../../../components/tool-settings/SecretPicker';
import { ToolSettingsForm } from '../../../components/tool-settings/ToolSettingsForm';
import {
  useNamedSecretDelete,
  useToolSettingsSetDefault,
} from '../../../features/settings/api/mutations';
import {
  useNamedSecretsList,
  useToolSettingsDefault,
  useToolSettingsSchemas,
} from '../../../features/settings/api/queries';
import { rpc } from '../../../rpc';
import { AdvancedBlock } from '../components/advanced';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';
import { useSettingsPane } from '../pane-context';

const WEB_SEARCH_PROVIDERS = ['exa', 'tavily', 'brave'] as const;
type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];
function isWebSearchProvider(v: string | undefined): v is WebSearchProvider {
  return v === 'exa' || v === 'tavily' || v === 'brave';
}

export function SecurityPane() {
  const { config: configData } = useSettingsPane();

  return (
    <>
      <SectionHeading id="approval-mode">approval mode</SectionHeading>

      <SettingRow label="Approval mode" formName="approvalMode">
        <Form.Item name="approvalMode" style={{ marginBottom: 0 }}>
          <Radio.Group>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Radio value="manual">
                <span style={{ fontWeight: 500 }}>Manual</span>
                <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                  Ask before every sensitive tool call.
                </span>
              </Radio>
              <Radio value="smart">
                <span style={{ fontWeight: 500 }}>Smart</span>
                <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                  Ask only for high-risk operations. Routine tools run automatically.
                </span>
              </Radio>
              <Radio value="off">
                <span style={{ fontWeight: 500 }}>Off</span>
                <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                  Run all tools without asking. Use only on trusted machines.
                </span>
              </Radio>
            </div>
          </Radio.Group>
        </Form.Item>
      </SettingRow>

      <AdvancedBlock>
        <SettingRow
          label="Enable admin panel"
          formName="adminEnabled"
          help="Enable the admin console for system-level operations. Takes effect on save."
        >
          <Form.Item name="adminEnabled" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Checkbox />
          </Form.Item>
        </SettingRow>
        <AdminPanelGate savedEnabled={configData?.adminEnabled} />
      </AdvancedBlock>

      <SectionHeading id="named-secrets">named secrets</SectionHeading>
      <NamedSecretsSection />

      <SectionHeading id="web-search-defaults">web-search defaults</SectionHeading>
      <WebSearchDefaultsSection />

      <SectionHeading id="api-keys">API keys</SectionHeading>
      <ApiKeysSection />

      <SectionHeading id="a2a">A2A</SectionHeading>
      <A2aSection />
    </>
  );
}

// ---------------------------------------------------------------------------
// Admin panel gate (§8.g). The button follows the SAVED value — the server
// gate (`admin.service.ts:18` → `ConfigService.adminEnabled()` →
// `config.service.ts:1672`–`:1674`) reads `admin.enabled` from the config FILE,
// not the browser's form store, so a button driven by the live value would
// navigate to a panel the server 403s. The note follows the LIVE value, so
// ticking the box is acknowledged the instant it happens — honestly, without
// promising a button pressing it would not honour. Exported for T16
// (`__tests__/admin-panel-gate.test.ts`), which pins all three rendered states.
// ---------------------------------------------------------------------------

export function AdminPanelGate({ savedEnabled }: { savedEnabled: boolean | undefined }) {
  const navigate = useNavigate();
  return (
    <Form.Item noStyle shouldUpdate={(prev, cur) => prev.adminEnabled !== cur.adminEnabled}>
      {({ getFieldValue }) => {
        const liveEnabled = Boolean(getFieldValue('adminEnabled'));
        if (liveEnabled && savedEnabled) {
          return <Button onClick={() => navigate('/admin')}>Open admin panel</Button>;
        }
        if (liveEnabled) {
          return (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Save to enable, then open the admin panel.
            </Typography.Text>
          );
        }
        if (savedEnabled) {
          return (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Still enabled until you save — the panel is reachable.
            </Typography.Text>
          );
        }
        return null;
      }}
    </Form.Item>
  );
}

// ---------------------------------------------------------------------------
// Named secrets — the vault manager. Add / delete provider keys; values are
// masked on read and never round-tripped back to the browser.
// ---------------------------------------------------------------------------

type NamedSecretRow = Awaited<ReturnType<typeof rpc.namedSecrets.list>>['secrets'][number];

function NamedSecretsSection() {
  const listQuery = useNamedSecretsList();
  const deleteMut = useNamedSecretDelete();
  const { modal } = AntApp.useApp();
  const [addOpen, setAddOpen] = useState(false);

  const handleDelete = (row: NamedSecretRow) => {
    modal.confirm({
      title: 'Delete secret',
      content: `Delete "${row.provider}/${row.name}"? Any personality bound to it falls back to the default provider.`,
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: () => deleteMut.mutate({ provider: row.provider, name: row.name }),
    });
  };

  const columns: ColumnsType<NamedSecretRow> = [
    {
      title: 'Provider',
      dataIndex: 'provider',
      key: 'provider',
      render: (provider: string) => <Tag style={{ margin: 0 }}>{provider}</Tag>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => (
        <Typography.Text style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>
          {name}
        </Typography.Text>
      ),
    },
    {
      title: 'Value',
      dataIndex: 'preview',
      key: 'preview',
      render: (preview: string) => (
        <Typography.Text
          type="secondary"
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
        >
          {preview}
        </Typography.Text>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, row: NamedSecretRow) => (
        <Button size="small" danger onClick={() => handleDelete(row)} loading={deleteMut.isPending}>
          Delete
        </Button>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 640, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <Typography.Paragraph type="secondary" style={{ margin: 0, flex: 1 }}>
          Provider keys reusable across personalities. A personality references a secret by name;
          the value stays here and is never shown again.
        </Typography.Paragraph>
        <Button size="small" onClick={() => setAddOpen(true)}>
          Add secret
        </Button>
      </div>
      <Table
        size="small"
        rowKey={(r) => `${r.provider}/${r.name}`}
        columns={columns}
        dataSource={listQuery.data?.secrets ?? []}
        loading={listQuery.isLoading}
        pagination={false}
        locale={{ emptyText: 'No secrets yet. Add one to bind it from a personality.' }}
      />
      {addOpen ? (
        <AddSecretModal
          lockProvider={false}
          onClose={() => setAddOpen(false)}
          onCreated={() => setAddOpen(false)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Web-search defaults — the global default provider + bound secret
// (`toolSettings._default.web_search`), rendered from the tool's settingsSchema.
// Mirrors the "Model routing" / "Voice" cards. Optional test-key probe reuses
// the provider test-connection pattern.
// ---------------------------------------------------------------------------

function WebSearchDefaultsSection() {
  const schemasQuery = useToolSettingsSchemas();
  const defaultQuery = useToolSettingsDefault();
  const setDefault = useToolSettingsSetDefault();
  const [values, setValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testError, setTestError] = useState<string | undefined>();

  const schema = schemasQuery.data?.tools.find((t) => t.name === 'web_search')?.settingsSchema;

  useEffect(() => {
    if (!dirty && defaultQuery.data) {
      setValues(defaultQuery.data.values.web_search ?? {});
    }
  }, [defaultQuery.data, dirty]);

  // No web_search tool wired (no schema) → nothing to configure.
  if (!schema) return null;

  const handleTest = async () => {
    const provider = values.provider;
    const name = values.secret;
    if (!isWebSearchProvider(provider) || !name) return;
    setTestStatus('testing');
    setTestError(undefined);
    try {
      const res = await rpc.namedSecrets.testKey({ provider, name });
      if (res.ok) setTestStatus('ok');
      else {
        setTestStatus('error');
        setTestError(res.error);
      }
    } catch (err) {
      setTestStatus('error');
      setTestError((err as Error).message);
    }
  };

  const canTest = isWebSearchProvider(values.provider) && !!values.secret;

  return (
    <div style={{ maxWidth: 640, marginBottom: 16 }}>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        The provider and key <Typography.Text code>web_search</Typography.Text> uses when a
        personality doesn&apos;t bind its own. A personality&apos;s own setting always wins. This
        section saves on its own button, below — which backend the tool is forced to use is a
        separate control, Web search backend, under Models &amp; backends, saved with the page.
      </Typography.Paragraph>
      <ToolSettingsForm
        schema={schema}
        value={values}
        onChange={(next) => {
          setValues(next);
          setDirty(true);
          setTestStatus('idle');
        }}
      />
      <Space style={{ marginTop: 16 }}>
        <Button
          type="primary"
          loading={setDefault.isPending}
          onClick={() =>
            setDefault.mutate({ web_search: values }, { onSuccess: () => setDirty(false) })
          }
        >
          Save
        </Button>
        <Tooltip
          title={
            canTest ? 'Test the bound key against the provider' : 'Pick a provider and key to test'
          }
        >
          <Button onClick={handleTest} loading={testStatus === 'testing'} disabled={!canTest}>
            Test key
          </Button>
        </Tooltip>
        {testStatus === 'ok' && <Tag color="success">Key accepted</Tag>}
        {testStatus === 'error' && <Tag color="error">{testError ?? 'Failed'}</Tag>}
      </Space>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent-to-Agent (A2A) — serve-wide enable/disable toggle. Live gate: the
// switch calls `a2a.settings.set` on flip (not the page Save button). Enabling
// exposes the discovery + peering surface; peers stay default-deny regardless.
// When A2A is not wired on this server the `get` returns NOT_AVAILABLE (503) —
// render the switch disabled with a subtle note rather than erroring loudly.
// ---------------------------------------------------------------------------

/** True when an oRPC client error carries the `NOT_AVAILABLE` code. */
function isNotAvailable(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'NOT_AVAILABLE'
  );
}

function A2aSection() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const settingsQuery = useQuery({
    queryKey: ['a2a', 'settings'],
    queryFn: () => rpc.a2a.settings.get(),
    retry: false,
  });

  const setMut = useMutation({
    mutationFn: (enabled: boolean) => rpc.a2a.settings.set({ enabled }),
    onSuccess: (data) => {
      qc.setQueryData(['a2a', 'settings'], data);
      notification.success({
        message: data.enabled ? 'A2A enabled' : 'A2A disabled',
        placement: 'topRight',
      });
    },
    onError: (err) =>
      notification.error({ message: 'Failed to update A2A', description: (err as Error).message }),
  });

  const unavailable = isNotAvailable(settingsQuery.error);
  const loadError = settingsQuery.error && !unavailable ? settingsQuery.error : null;
  const enabled = settingsQuery.data?.enabled ?? false;

  return (
    <div style={{ maxWidth: 640, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Switch
          checked={enabled}
          disabled={unavailable || Boolean(loadError) || settingsQuery.isLoading}
          loading={settingsQuery.isLoading || setMut.isPending}
          onChange={(next) => setMut.mutate(next)}
        />
        <Typography.Text>{enabled ? 'Enabled' : 'Disabled'}</Typography.Text>
      </div>
      {loadError ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          Failed to load A2A status: {(loadError as Error).message}
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {unavailable
            ? 'Unavailable on this server.'
            : 'Enabling exposes the A2A discovery and peering surface. Peers are still default-deny.'}
        </Typography.Text>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API Keys management section
// ---------------------------------------------------------------------------

const ALL_SCOPES: ApiKeyScope[] = [
  'sessions:read',
  'sessions:write',
  'chat',
  'chat:send',
  'personalities:read',
  'memory:read',
  'memory:write',
  'tools:approve',
  'events:subscribe',
];

/**
 * Hints for the scopes whose names don't explain themselves. `chat` and
 * `chat:send` are one letter apart in the checkbox list and gate completely
 * different surfaces, so both are annotated. Unlisted scopes render bare.
 */
const SCOPE_HINTS: Partial<Record<ApiKeyScope, string>> = {
  chat: 'OpenAI-compatible API (/v1/models, /v1/chat/completions) — for Cursor, Aider, the OpenAI SDKs',
  'chat:send': 'chat.send and chat.abort RPC — for a Mission Control built on @ethosagent/sdk',
};

interface CreateKeyForm {
  name: string;
  scopes: ApiKeyScope[];
  origins: string[];
}

function ApiKeysSection() {
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  // T1-ALLOW-MODAL-FORM: the create-key modal's own form. It holds THREE fields
  // that never reach `config.update` — name, scopes, origins — so it is not a
  // second instance for page-Save-backed values, which is the thing §5.3 forbids.
  const [form] = Form.useForm<CreateKeyForm>();

  const keysQuery = useQuery({
    queryKey: ['apiKeys'],
    queryFn: () => rpc.apiKeys.list({}),
  });

  const createMut = useMutation({
    mutationFn: (input: { name: string; scopes: ApiKeyScope[]; allowedOrigins: string[] }) =>
      rpc.apiKeys.create(input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['apiKeys'] });
      setCreateOpen(false);
      form.resetFields();
      setRevealedSecret(data.secret);
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to create API key',
        description: (err as Error).message,
      }),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => rpc.apiKeys.revoke({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apiKeys'] });
      notification.success({ message: 'API key revoked', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to revoke API key',
        description: (err as Error).message,
      }),
  });

  const handleRevoke = (id: string, name: string) => {
    modal.confirm({
      title: 'Revoke API key',
      content: `Revoke "${name}"? External Mission Controls using this key will lose access immediately.`,
      okText: 'Revoke',
      okButtonProps: { danger: true },
      onOk: () => revokeMut.mutate(id),
    });
  };

  const handleCreate = (values: CreateKeyForm) => {
    createMut.mutate({
      name: values.name,
      scopes: values.scopes,
      allowedOrigins: values.origins.filter((o) => o.trim().length > 0),
    });
  };

  const copySecret = async () => {
    if (!revealedSecret) return;
    try {
      await navigator.clipboard.writeText(revealedSecret);
      notification.success({ message: 'Copied to clipboard', placement: 'topRight' });
    } catch {
      notification.error({ message: 'Copy failed — select and copy manually' });
    }
  };

  const columns: ColumnsType<ApiKeyMetadata> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: 'Prefix',
      dataIndex: 'prefix',
      key: 'prefix',
      render: (prefix: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {prefix}
        </Typography.Text>
      ),
    },
    {
      title: 'Scopes',
      dataIndex: 'scopes',
      key: 'scopes',
      render: (scopes: ApiKeyScope[]) => (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {scopes.map((s) => (
            <Tag key={s} style={{ margin: 0, fontSize: 11 }}>
              {s}
            </Tag>
          ))}
        </span>
      ),
    },
    {
      title: 'Allowed Origins',
      dataIndex: 'allowedOrigins',
      key: 'allowedOrigins',
      render: (origins: string[]) =>
        origins.length > 0 ? (
          <Tooltip title={origins.join(', ')}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {origins.length} origin{origins.length !== 1 ? 's' : ''}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            none
          </Typography.Text>
        ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {new Date(v).toLocaleDateString()}
        </Typography.Text>
      ),
    },
    {
      title: 'Last Used',
      dataIndex: 'lastUsed',
      key: 'lastUsed',
      render: (v: string | null) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {v ? new Date(v).toLocaleDateString() : 'never'}
        </Typography.Text>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      render: (_: unknown, record: ApiKeyMetadata) =>
        record.revokedAt ? <Tag color="default">Revoked</Tag> : <Tag color="green">Active</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: ApiKeyMetadata) =>
        record.revokedAt ? null : (
          <Button
            size="small"
            danger
            onClick={() => handleRevoke(record.id, record.name)}
            loading={revokeMut.isPending}
          >
            Revoke
          </Button>
        ),
    },
  ];

  const keys = keysQuery.data?.items ?? [];

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <Typography.Paragraph type="secondary" style={{ margin: 0, flex: 1 }}>
          Bearer tokens for external Mission Controls. Each key is scoped to specific operations and
          origins.
        </Typography.Paragraph>
        <Button type="primary" size="small" onClick={() => setCreateOpen(true)}>
          Create API Key
        </Button>
      </div>

      <Table<ApiKeyMetadata>
        columns={columns}
        dataSource={keys}
        rowKey="id"
        size="small"
        loading={keysQuery.isLoading}
        pagination={false}
        locale={{ emptyText: 'No API keys created yet.' }}
        rowClassName={(record) => (record.revokedAt ? 'api-key-revoked' : '')}
        scroll={{ x: true }}
      />

      {/* Create modal */}
      <Modal
        title="Create API Key"
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending}
        okText="Create"
        destroyOnClose
      >
        {/* T1-ALLOW-MODAL-FORM: modal-local, portalled, and none of its fields
            is written by the page Save. */}
        <Form<CreateKeyForm>
          form={form}
          layout="vertical"
          onFinish={handleCreate}
          initialValues={{ origins: [''] }}
        >
          <Form.Item
            label="Name"
            name="name"
            rules={[
              { required: true, message: 'Name is required' },
              { max: 100, message: 'Max 100 characters' },
            ]}
          >
            <Input placeholder="e.g. Production frontend" />
          </Form.Item>

          <Form.Item
            label="Scopes"
            name="scopes"
            rules={[{ required: true, message: 'Select at least one scope' }]}
          >
            <Checkbox.Group
              options={ALL_SCOPES.map((s) => ({
                value: s,
                label: SCOPE_HINTS[s] ? (
                  <>
                    {s}{' '}
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      — {SCOPE_HINTS[s]}
                    </Typography.Text>
                  </>
                ) : (
                  s
                ),
              }))}
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            />
          </Form.Item>

          <Form.Item label="Allowed Origins">
            <Form.List
              name="origins"
              rules={[
                {
                  validator: async (_, origins: string[]) => {
                    const filled = (origins ?? []).filter((o) => o.trim().length > 0);
                    if (filled.length === 0) {
                      throw new Error('At least one origin is required');
                    }
                  },
                },
              ]}
            >
              {(fields, { add, remove }, { errors }) => (
                <>
                  {fields.map((field) => (
                    <Space
                      key={field.key}
                      align="start"
                      style={{ display: 'flex', marginBottom: 8 }}
                    >
                      <Form.Item
                        {...field}
                        validateTrigger={['onChange', 'onBlur']}
                        rules={[
                          {
                            validator: async (_, value: string) => {
                              if (!value || value.trim().length === 0) return;
                              try {
                                const u = new URL(value);
                                if (u.origin !== value) {
                                  throw new Error(
                                    'Must be a valid origin (scheme + host, no path)',
                                  );
                                }
                              } catch {
                                throw new Error(
                                  'Must be a valid origin (e.g. https://example.com)',
                                );
                              }
                            },
                          },
                        ]}
                        noStyle
                      >
                        <Input placeholder="https://example.com" style={{ width: 300 }} />
                      </Form.Item>
                      {fields.length > 1 ? (
                        <Button size="small" onClick={() => remove(field.name)}>
                          Remove
                        </Button>
                      ) : null}
                    </Space>
                  ))}
                  <Form.Item>
                    <Button type="dashed" onClick={() => add('')} style={{ width: 300 }}>
                      Add origin
                    </Button>
                    <Form.ErrorList errors={errors} />
                  </Form.Item>
                </>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>

      {/* Secret reveal modal */}
      <Modal
        title="Copy your API key"
        open={revealedSecret !== null}
        onCancel={() => setRevealedSecret(null)}
        footer={[
          <Button key="copy" type="primary" onClick={copySecret}>
            Copy to clipboard
          </Button>,
          <Button key="close" onClick={() => setRevealedSecret(null)}>
            Done
          </Button>,
        ]}
        closable
      >
        <Typography.Paragraph type="warning" style={{ marginBottom: 12 }}>
          This secret will not be shown again. Copy it now and store it securely.
        </Typography.Paragraph>
        <Input.TextArea
          value={revealedSecret ?? ''}
          readOnly
          autoSize
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 13 }}
        />
      </Modal>

      <style>{`
        .api-key-revoked {
          opacity: 0.5;
        }
      `}</style>
    </div>
  );
}
