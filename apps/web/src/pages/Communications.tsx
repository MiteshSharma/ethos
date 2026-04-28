import type { PlatformId, PlatformStatus } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Badge,
  Button,
  Card,
  Form,
  Input,
  Popconfirm,
  Spin,
  Tabs,
  Typography,
} from 'antd';
import { rpc } from '../rpc';

// Communications tab — v1.
//
// Per-platform connection state + setup. The web tab edits the same
// flat keys the gateway already reads from ~/.ethos/config.yaml
// (telegramToken, slackBotToken, …). Sensitive values never round-
// trip through reads — the server only emits per-field configured
// flags. Setup is paste-token-and-save; live validation against the
// upstream platform happens when the gateway boots, not here.

interface PlatformShape {
  id: PlatformId;
  label: string;
  fields: ReadonlyArray<{
    name: string;
    label: string;
    placeholder?: string;
    secret: boolean;
    helper?: string;
  }>;
  helpUrl?: string;
}

const PLATFORMS: ReadonlyArray<PlatformShape> = [
  {
    id: 'telegram',
    label: 'Telegram',
    fields: [
      {
        name: 'token',
        label: 'Bot token',
        placeholder: '123456:ABC-DEF...',
        secret: true,
        helper: 'From BotFather. Stored at telegramToken in config.yaml.',
      },
    ],
    helpUrl: 'https://core.telegram.org/bots',
  },
  {
    id: 'slack',
    label: 'Slack',
    fields: [
      { name: 'botToken', label: 'Bot token', placeholder: 'xoxb-…', secret: true },
      { name: 'appToken', label: 'App token', placeholder: 'xapp-…', secret: true },
      {
        name: 'signingSecret',
        label: 'Signing secret',
        secret: true,
        helper: 'From the Slack app dashboard, Basic Information → App Credentials.',
      },
    ],
    helpUrl: 'https://api.slack.com/apps',
  },
  {
    id: 'discord',
    label: 'Discord',
    fields: [
      {
        name: 'token',
        label: 'Bot token',
        secret: true,
        helper: 'Stored at discordToken in config.yaml.',
      },
    ],
    helpUrl: 'https://discord.com/developers/applications',
  },
  {
    id: 'email',
    label: 'Email',
    fields: [
      { name: 'imapHost', label: 'IMAP host', placeholder: 'imap.example.com', secret: false },
      { name: 'imapPort', label: 'IMAP port', placeholder: '993', secret: false },
      { name: 'user', label: 'Username', placeholder: 'me@example.com', secret: false },
      { name: 'password', label: 'Password / app password', secret: true },
      { name: 'smtpHost', label: 'SMTP host', placeholder: 'smtp.example.com', secret: false },
      { name: 'smtpPort', label: 'SMTP port', placeholder: '587', secret: false },
    ],
  },
];

export function Communications() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['platforms', 'list'],
    queryFn: () => rpc.platforms.list(),
  });

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load platforms: {(error as Error).message}
      </Typography.Text>
    );
  }

  const statusById = new Map((data?.platforms ?? []).map((p) => [p.id, p] as const));

  return (
    <div className="comms-tab">
      <Tabs
        defaultActiveKey="telegram"
        items={PLATFORMS.map((shape) => {
          const status = statusById.get(shape.id);
          return {
            key: shape.id,
            label: (
              <span>
                {shape.label}{' '}
                <Badge
                  status={status?.configured ? 'success' : 'default'}
                  style={{ marginLeft: 6 }}
                />
              </span>
            ),
            children: <PlatformPanel shape={shape} status={status} />,
          };
        })}
      />
    </div>
  );
}

function PlatformPanel({ shape, status }: { shape: PlatformShape; status?: PlatformStatus }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<Record<string, string>>();

  const setMut = useMutation({
    mutationFn: (fields: Record<string, string>) => rpc.platforms.set({ id: shape.id, fields }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'list'] });
      notification.success({ message: `${shape.label} saved`, placement: 'topRight' });
      form.resetFields();
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const clearMut = useMutation({
    mutationFn: () => rpc.platforms.clear({ id: shape.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'list'] });
      notification.info({ message: `${shape.label} disconnected`, placement: 'topRight' });
      form.resetFields();
    },
    onError: (err) =>
      notification.error({ message: 'Clear failed', description: (err as Error).message }),
  });

  const onFinish = (values: Record<string, string>) => {
    // Drop empty strings — the server preserves existing values for
    // those, so this lets users rotate one secret without re-typing
    // every other.
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v && v.length > 0) cleaned[k] = v;
    }
    if (Object.keys(cleaned).length === 0) {
      notification.info({
        message: 'Nothing to save',
        description: 'Enter at least one field.',
        placement: 'topRight',
      });
      return;
    }
    setMut.mutate(cleaned);
  };

  const overallConfigured = status?.configured ?? false;

  return (
    <Card
      size="small"
      title={
        <span>
          {shape.label}{' '}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {overallConfigured ? '· connected' : '· not configured'}
          </Typography.Text>
        </span>
      }
      extra={
        shape.helpUrl ? (
          <Typography.Link href={shape.helpUrl} target="_blank" rel="noreferrer">
            Setup guide ↗
          </Typography.Link>
        ) : null
      }
      style={{ maxWidth: 640 }}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Stored values are never sent back to this page. Enter a new value to rotate; leave a field
        blank to keep its current value.
      </Typography.Paragraph>

      <Form layout="vertical" form={form} onFinish={onFinish}>
        {shape.fields.map((field) => {
          const fieldConfigured = status?.fields[field.name] ?? false;
          const placeholder = fieldConfigured
            ? `<set>${field.placeholder ? ` (placeholder: ${field.placeholder})` : ''}`
            : field.placeholder;
          return (
            <Form.Item key={field.name} label={field.label} name={field.name} extra={field.helper}>
              {field.secret ? (
                <Input.Password autoComplete="off" placeholder={placeholder} />
              ) : (
                <Input autoComplete="off" placeholder={placeholder} />
              )}
            </Form.Item>
          );
        })}

        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="primary" htmlType="submit" loading={setMut.isPending}>
            Save
          </Button>
          <Popconfirm
            title={`Disconnect ${shape.label}?`}
            description="All stored values for this platform are removed from config.yaml."
            okText="Disconnect"
            okButtonProps={{ danger: true }}
            onConfirm={() => clearMut.mutate()}
          >
            <Button danger disabled={!overallConfigured} loading={clearMut.isPending}>
              Disconnect
            </Button>
          </Popconfirm>
        </div>
      </Form>
    </Card>
  );
}
