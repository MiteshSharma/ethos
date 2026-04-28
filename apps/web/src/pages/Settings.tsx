import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Card,
  Form,
  Input,
  Radio,
  Select,
  Spin,
  Switch,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { rpc } from '../rpc';

// Settings tab — read/write surface for ~/.ethos/config.yaml.
//
// Two visibility modes:
//   • Default   — provider, model, API key (rotate), personality, memory mode.
//   • Advanced  — adds the modelRouting record + base URL.
//
// The raw API key never crosses the wire on read; the server returns
// `apiKeyPreview` (e.g. `sk-…abc1`) so users can confirm "which key" is
// active. On update, the plaintext key is sent only when the user types
// a fresh value into the field.

interface FormShape {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  personality: string;
  memory: 'markdown' | 'vector';
}

export function Settings() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [form] = Form.useForm<FormShape>();

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list(),
  });

  // Hydrate the form once the config arrives. Don't include `apiKey` —
  // the field stays empty so a stray submit doesn't accidentally
  // overwrite with empty (the service already drops empty strings, but
  // the UX is clearer if the field is just "leave blank to keep").
  useEffect(() => {
    if (configQuery.data) {
      form.setFieldsValue({
        provider: configQuery.data.provider,
        model: configQuery.data.model,
        baseUrl: configQuery.data.baseUrl ?? '',
        personality: configQuery.data.personality,
        memory: configQuery.data.memory,
      });
    }
  }, [configQuery.data, form]);

  const updateMut = useMutation({
    mutationFn: (patch: Parameters<typeof rpc.config.update>[0]) => rpc.config.update(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] });
      notification.success({ message: 'Settings saved', placement: 'topRight' });
      // Wipe the apiKey field after a successful save so the next render
      // doesn't show the value we just sent.
      form.setFieldValue('apiKey', '');
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  if (configQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (configQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load config: {(configQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const personalities = personalitiesQuery.data?.personalities ?? [];

  const onFinish = (values: FormShape) => {
    // Build the patch — drop unchanged fields and the empty apiKey.
    const patch: Parameters<typeof rpc.config.update>[0] = {
      provider: values.provider,
      model: values.model,
      personality: values.personality,
      memory: values.memory,
    };
    if (values.apiKey && values.apiKey.length > 0) patch.apiKey = values.apiKey;
    if (values.baseUrl !== undefined) patch.baseUrl = values.baseUrl;
    updateMut.mutate(patch);
  };

  return (
    <div className="settings-tab">
      <header className="settings-toolbar">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Settings
        </Typography.Title>
        <span className="settings-advanced-toggle">
          <span className="settings-advanced-label">Show advanced</span>
          <Switch checked={showAdvanced} onChange={setShowAdvanced} />
        </span>
      </header>

      <Form<FormShape> form={form} layout="vertical" onFinish={onFinish} style={{ maxWidth: 640 }}>
        <Card title="Provider" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Provider"
            name="provider"
            rules={[{ required: true, message: 'Required' }]}
          >
            <Input placeholder="anthropic | openrouter | openai-compat | ollama" />
          </Form.Item>

          <Form.Item label="Model" name="model" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="e.g. claude-opus-4-7" />
          </Form.Item>

          <Form.Item
            label="API key"
            name="apiKey"
            extra={`Active key: ${configQuery.data?.apiKeyPreview ?? '<unset>'}. Leave blank to keep.`}
          >
            <Input.Password autoComplete="off" placeholder="paste new key to rotate" />
          </Form.Item>

          {showAdvanced ? (
            <Form.Item
              label="Base URL"
              name="baseUrl"
              extra="Override only when self-hosting (e.g. a private OpenAI-compat gateway)."
            >
              <Input placeholder="https://openrouter.ai/api/v1" />
            </Form.Item>
          ) : null}
        </Card>

        <Card title="Default personality" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Personality"
            name="personality"
            rules={[{ required: true, message: 'Required' }]}
            extra="Used when chat doesn't override per-session."
          >
            <Select
              loading={personalitiesQuery.isLoading}
              options={personalities.map((p) => ({
                label: `${p.name}${p.builtin ? ' (built-in)' : ''}`,
                value: p.id,
              }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
        </Card>

        <Card title="Memory" size="small" style={{ marginBottom: 16 }}>
          <Form.Item
            label="Memory mode"
            name="memory"
            extra="Markdown is human-editable in ~/.ethos/MEMORY.md. Vector uses local embeddings."
          >
            <Radio.Group>
              <Radio.Button value="markdown">Markdown</Radio.Button>
              <Radio.Button value="vector">Vector</Radio.Button>
            </Radio.Group>
          </Form.Item>
        </Card>

        {showAdvanced ? (
          <Card title="Model routing" size="small" style={{ marginBottom: 16 }}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              Per-personality model overrides. Edit ~/.ethos/config.yaml directly to add entries —
              this surface lists the current overrides; full editing lands later.
            </Typography.Paragraph>
            <ModelRoutingView routing={configQuery.data?.modelRouting ?? {}} />
          </Card>
        ) : null}

        <Form.Item>
          <Button type="primary" htmlType="submit" loading={updateMut.isPending}>
            Save
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
}

function ModelRoutingView({ routing }: { routing: Record<string, string> }) {
  const entries = Object.entries(routing);
  if (entries.length === 0) {
    return <Typography.Text type="secondary">No per-personality overrides set.</Typography.Text>;
  }
  return (
    <ul style={{ margin: 0, paddingLeft: 16 }}>
      {entries.map(([personality, model]) => (
        <li key={personality} style={{ fontSize: 13, color: 'var(--ethos-text)' }}>
          <Typography.Text code>{personality}</Typography.Text>
          {' → '}
          <Typography.Text code>{model}</Typography.Text>
        </li>
      ))}
    </ul>
  );
}
