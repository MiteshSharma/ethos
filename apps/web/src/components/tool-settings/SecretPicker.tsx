import {
  NAMED_SECRET_PROVIDER_KINDS,
  type NamedSecretProvider,
  NamedSecretProviderSchema,
} from '@ethosagent/web-contracts';
import {
  App as AntApp,
  Button,
  Divider,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useNamedSecretCreate } from '../../features/settings/api/mutations';
import { useNamedSecretsList } from '../../features/settings/api/queries';

// SecretPicker — a dropdown over global NAMED secrets, filtered by kind (and,
// when the consuming tool has a sibling provider, by that provider). Values
// never leave the vault; the picker only ever handles secret NAMES. An inline
// "Add secret" shortcut writes a new secret into the vault without leaving the
// form.
//
// The add form offers every provider the vault accepts, grouped by kind. When
// `providerFilter` names one of them the form locks to it; otherwise, when the
// picker's `secretKind` maps to exactly one provider (x_search → xai), it locks
// to that one, so the created secret always lands where the tool will look.

/** Display labels, grouped the way the add form's Select shows them. */
const PROVIDER_GROUPS: Array<{ label: string; providers: Array<[NamedSecretProvider, string]> }> = [
  {
    label: 'Web search',
    providers: [
      ['exa', 'Exa'],
      ['tavily', 'Tavily'],
      ['brave', 'Brave Search'],
    ],
  },
  {
    label: 'X',
    providers: [
      ['xai', 'xAI (Grok, X search)'],
      ['x', 'X API (bearer token)'],
    ],
  },
];

function asNamedSecretProvider(v: string | undefined): NamedSecretProvider | undefined {
  const parsed = NamedSecretProviderSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/** The providers whose secrets a picker of `secretKind` offers. */
function providersOfKind(secretKind: string): NamedSecretProvider[] {
  return NamedSecretProviderSchema.options.filter(
    (p) => NAMED_SECRET_PROVIDER_KINDS[p] === secretKind,
  );
}

export interface SecretPickerProps {
  /** Currently bound secret NAME, or undefined when unset. */
  value?: string;
  onChange: (name: string | undefined) => void;
  /** Category of named secret to offer (matches `settingsSchema` secretKind). */
  secretKind: string;
  /** Narrow the offered secrets to a single provider (the sibling enum value). */
  providerFilter?: string;
  disabled?: boolean;
}

export function SecretPicker({
  value,
  onChange,
  secretKind,
  providerFilter,
  disabled,
}: SecretPickerProps) {
  const secretsQuery = useNamedSecretsList();
  const [addOpen, setAddOpen] = useState(false);
  const filterProvider = asNamedSecretProvider(providerFilter);
  const kindProviders = providersOfKind(secretKind);

  const secrets = (secretsQuery.data?.secrets ?? []).filter(
    (s) => s.kind === secretKind && (!providerFilter || s.provider === providerFilter),
  );

  const options = secrets.map((s) => ({
    value: s.name,
    label: (
      <Space size={8}>
        <span>{s.name}</span>
        <Typography.Text
          type="secondary"
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
        >
          {s.preview}
        </Typography.Text>
      </Space>
    ),
  }));

  return (
    <>
      <Select
        style={{ minWidth: 220, width: '100%' }}
        value={value ?? undefined}
        onChange={(v) => onChange(v || undefined)}
        options={options}
        placeholder={providerFilter ? `Select a ${providerFilter} key` : 'Select a secret'}
        loading={secretsQuery.isLoading}
        disabled={disabled}
        allowClear
        notFoundContent={
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            No secrets yet — add one below.
          </Typography.Text>
        }
        dropdownRender={(menu) => (
          <>
            {menu}
            <Divider style={{ margin: '4px 0' }} />
            <Button
              type="text"
              size="small"
              block
              style={{ textAlign: 'left' }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setAddOpen(true)}
            >
              + Add secret
            </Button>
          </>
        )}
      />
      {addOpen ? (
        <AddSecretModal
          initialProvider={
            filterProvider ?? (kindProviders.length === 1 ? kindProviders[0] : undefined)
          }
          lockProvider={filterProvider !== undefined || kindProviders.length === 1}
          onClose={() => setAddOpen(false)}
          onCreated={(name) => {
            setAddOpen(false);
            onChange(name);
          }}
        />
      ) : null}
    </>
  );
}

interface AddSecretForm {
  provider: NamedSecretProvider;
  name: string;
  value: string;
}

export function AddSecretModal({
  initialProvider,
  lockProvider,
  onClose,
  onCreated,
}: {
  initialProvider?: NamedSecretProvider;
  lockProvider: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<AddSecretForm>();
  const createMut = useNamedSecretCreate();

  const handleSubmit = (values: AddSecretForm) => {
    createMut.mutate(
      { provider: values.provider, name: values.name.trim(), value: values.value },
      {
        onSuccess: () => {
          form.resetFields();
          onCreated(values.name.trim());
        },
        onError: (err) =>
          notification.error({
            message: 'Failed to add secret',
            description: (err as Error).message,
          }),
      },
    );
  };

  return (
    <Modal
      title="Add secret"
      open
      onCancel={onClose}
      okText="Save secret"
      confirmLoading={createMut.isPending}
      onOk={() => form.submit()}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        The value is stored in the local vault and never shown again — a personality references it
        by name only.
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{ provider: initialProvider ?? 'exa' }}
      >
        <Form.Item name="provider" label="Provider" rules={[{ required: true }]}>
          <Select
            disabled={lockProvider}
            options={PROVIDER_GROUPS.map((g) => ({
              label: g.label,
              title: g.label,
              options: g.providers.map(([value, label]) => ({ value, label })),
            }))}
          />
        </Form.Item>
        <Form.Item
          name="name"
          label="Name"
          rules={[
            { required: true, message: 'Enter a name' },
            {
              pattern: /^[a-zA-Z0-9_-]+$/,
              message: 'Letters, digits, hyphens, underscores only',
            },
          ]}
        >
          <Input placeholder="e.g. main" autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="value"
          label="API key"
          rules={[{ required: true, message: 'Enter the key' }]}
        >
          <Input.Password placeholder="Paste the provider API key" autoComplete="off" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
