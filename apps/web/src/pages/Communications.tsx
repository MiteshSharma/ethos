import type {
  BotBinding,
  SlackAppEntry,
  TelegramBotEntry,
  WhatsAppEntry,
} from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Divider,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useActiveCalls,
  useCallDetail,
  useCallsList,
} from '../features/communications/api/queries';
import { usePersonalityList } from '../features/personalities/api/queries';
import { CallRow } from '../features/voice/CallRow';
import {
  CALL_DIRECTION_FILTERS,
  CALL_STATUS_FILTERS,
  CALLS_EMPTY_COPY,
  CALLS_EMPTY_FILTERED_COPY,
  type CallFilter,
  callRowView,
  DEFAULT_CALL_FILTER,
  withoutActive,
} from '../features/voice/call-rows';
import { bridge, isDesktop } from '../lib/desktop';
import { rpc } from '../rpc';

type BindType = 'personality' | 'team';

interface AddBotFormValues {
  token?: string;
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  bindType: BindType;
  bindName: string;
}

// ---------------------------------------------------------------------------
// Telegram panel
// ---------------------------------------------------------------------------

function TelegramPanel() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [adding, setAdding] = useState(false);
  const [bindType, setBindType] = useState<BindType>('personality');
  const [form] = Form.useForm<AddBotFormValues>();

  const botsQuery = useQuery({
    queryKey: ['platforms', 'bots', 'telegram'],
    queryFn: () => rpc.platforms.botsListTelegram(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
    enabled: adding,
  });

  const teamsQuery = useQuery({
    queryKey: ['kanban', 'list'],
    queryFn: () => rpc.kanban.list(),
    enabled: adding && bindType === 'team',
  });

  const addMut = useMutation({
    mutationFn: (values: AddBotFormValues) =>
      rpc.platforms.botsAddTelegram({
        token: values.token ?? '',
        bind: { type: values.bindType, name: values.bindName } satisfies BotBinding,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'telegram'] });
      notification.success({ message: 'Telegram bot added', placement: 'topRight' });
      form.resetFields();
      setAdding(false);
    },
    onError: (err) =>
      notification.error({ message: 'Add failed', description: (err as Error).message }),
  });

  const removeMut = useMutation({
    mutationFn: (botKey: string) => rpc.platforms.botsRemoveTelegram({ botKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'telegram'] });
      notification.info({ message: 'Telegram bot removed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Remove failed', description: (err as Error).message }),
  });

  const bots: TelegramBotEntry[] = botsQuery.data?.bots ?? [];

  const columns = [
    {
      title: 'Bot ID',
      dataIndex: 'botKey',
      key: 'botKey',
      render: (k: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {k}
        </Typography.Text>
      ),
    },
    {
      title: 'Token',
      key: 'token',
      render: (_: unknown, row: TelegramBotEntry) => (
        <Badge
          status={row.tokenConfigured ? 'success' : 'default'}
          text={row.tokenConfigured ? 'configured' : 'missing'}
        />
      ),
    },
    {
      title: 'Binding',
      key: 'bind',
      render: (_: unknown, row: TelegramBotEntry) => (
        <Space>
          <Tag color={row.bind.type === 'personality' ? 'blue' : 'purple'}>{row.bind.type}</Tag>
          <Typography.Text>{row.bind.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, row: TelegramBotEntry) => (
        <Popconfirm
          title="Remove this bot?"
          description="The bot token and binding will be deleted from config."
          okText="Remove"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeMut.mutate(row.botKey)}
        >
          <Button size="small" danger>
            Remove
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const bindOptions =
    bindType === 'personality'
      ? (personalitiesQuery.data?.items ?? []).map((p) => ({
          label: p.name,
          value: p.id,
        }))
      : (teamsQuery.data?.teams ?? []).map((t) => ({
          label: t.name,
          value: t.name,
        }));

  return (
    <Card
      size="small"
      title="Telegram bots"
      extra={
        <Typography.Link href="https://core.telegram.org/bots" target="_blank" rel="noreferrer">
          Setup guide ↗
        </Typography.Link>
      }
      style={{ maxWidth: 720 }}
    >
      {botsQuery.isLoading ? (
        <Spin />
      ) : (
        <Table
          dataSource={bots}
          columns={columns}
          rowKey="botKey"
          pagination={false}
          size="small"
          locale={{ emptyText: 'No bots configured yet.' }}
          style={{ marginBottom: bots.length > 0 ? 16 : 0 }}
        />
      )}

      {!adding && (
        <Button type="dashed" onClick={() => setAdding(true)} style={{ marginTop: 8 }}>
          + Add Telegram bot
        </Button>
      )}

      {adding && (
        <Card size="small" style={{ marginTop: 12, background: 'var(--ethos-bg)' }}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ bindType: 'personality' }}
            onFinish={(values) => addMut.mutate(values)}
          >
            <Form.Item
              label="Bot token"
              name="token"
              rules={[{ required: true, message: 'Paste the token from BotFather' }]}
            >
              <Input.Password autoComplete="off" placeholder="123456:ABC-DEF..." />
            </Form.Item>

            <Form.Item label="Bind to" style={{ marginBottom: 8 }}>
              <Segmented
                options={[
                  { label: 'Personality', value: 'personality' },
                  { label: 'Team', value: 'team' },
                ]}
                value={bindType}
                onChange={(v) => {
                  const t = v as BindType;
                  setBindType(t);
                  form.setFieldValue('bindType', t);
                  form.setFieldValue('bindName', undefined);
                }}
              />
            </Form.Item>

            <Form.Item name="bindType" hidden>
              <Input />
            </Form.Item>

            <Form.Item
              name="bindName"
              rules={[{ required: true, message: `Select a ${bindType}` }]}
            >
              <Select
                placeholder={`Select ${bindType}…`}
                loading={
                  bindType === 'personality' ? personalitiesQuery.isLoading : teamsQuery.isLoading
                }
                options={bindOptions}
              />
            </Form.Item>

            <Space>
              <Button type="primary" htmlType="submit" loading={addMut.isPending}>
                Save bot
              </Button>
              <Button
                onClick={() => {
                  setAdding(false);
                  form.resetFields();
                }}
              >
                Cancel
              </Button>
            </Space>
          </Form>
        </Card>
      )}

      <AccessControlSection platform="telegram" />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Slack panel
// ---------------------------------------------------------------------------

function SlackPanel() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [adding, setAdding] = useState(false);
  const [bindType, setBindType] = useState<BindType>('personality');
  const [form] = Form.useForm<AddBotFormValues>();

  const botsQuery = useQuery({
    queryKey: ['platforms', 'bots', 'slack'],
    queryFn: () => rpc.platforms.botsListSlack(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
    enabled: adding,
  });

  const teamsQuery = useQuery({
    queryKey: ['kanban', 'list'],
    queryFn: () => rpc.kanban.list(),
    enabled: adding && bindType === 'team',
  });

  const addMut = useMutation({
    mutationFn: (values: AddBotFormValues) =>
      rpc.platforms.botsAddSlack({
        botToken: values.botToken ?? '',
        appToken: values.appToken ?? '',
        signingSecret: values.signingSecret ?? '',
        bind: { type: values.bindType, name: values.bindName } satisfies BotBinding,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'slack'] });
      notification.success({ message: 'Slack app added', placement: 'topRight' });
      form.resetFields();
      setAdding(false);
    },
    onError: (err) =>
      notification.error({ message: 'Add failed', description: (err as Error).message }),
  });

  const removeMut = useMutation({
    mutationFn: (botKey: string) => rpc.platforms.botsRemoveSlack({ botKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'slack'] });
      notification.info({ message: 'Slack app removed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Remove failed', description: (err as Error).message }),
  });

  const apps: SlackAppEntry[] = botsQuery.data?.bots ?? [];

  const columns = [
    {
      title: 'Bot ID',
      dataIndex: 'botKey',
      key: 'botKey',
      render: (k: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {k}
        </Typography.Text>
      ),
    },
    {
      title: 'Tokens',
      key: 'tokens',
      render: (_: unknown, row: SlackAppEntry) => (
        <Space size="small">
          <Badge status={row.botTokenConfigured ? 'success' : 'default'} text="bot" />
          <Badge status={row.appTokenConfigured ? 'success' : 'default'} text="app" />
          <Badge status={row.signingSecretConfigured ? 'success' : 'default'} text="secret" />
        </Space>
      ),
    },
    {
      title: 'Binding',
      key: 'bind',
      render: (_: unknown, row: SlackAppEntry) => (
        <Space>
          <Tag color={row.bind.type === 'personality' ? 'blue' : 'purple'}>{row.bind.type}</Tag>
          <Typography.Text>{row.bind.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, row: SlackAppEntry) => (
        <Popconfirm
          title="Remove this Slack app?"
          description="The app tokens and binding will be deleted from config."
          okText="Remove"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeMut.mutate(row.botKey)}
        >
          <Button size="small" danger>
            Remove
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const bindOptions =
    bindType === 'personality'
      ? (personalitiesQuery.data?.items ?? []).map((p) => ({
          label: p.name,
          value: p.id,
        }))
      : (teamsQuery.data?.teams ?? []).map((t) => ({
          label: t.name,
          value: t.name,
        }));

  return (
    <Card
      size="small"
      title="Slack apps"
      extra={
        <Typography.Link href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
          Setup guide ↗
        </Typography.Link>
      }
      style={{ maxWidth: 720 }}
    >
      {botsQuery.isLoading ? (
        <Spin />
      ) : (
        <Table
          dataSource={apps}
          columns={columns}
          rowKey="botKey"
          pagination={false}
          size="small"
          locale={{ emptyText: 'No Slack apps configured yet.' }}
          style={{ marginBottom: apps.length > 0 ? 16 : 0 }}
        />
      )}

      {!adding && (
        <Button type="dashed" onClick={() => setAdding(true)} style={{ marginTop: 8 }}>
          + Add Slack app
        </Button>
      )}

      {adding && (
        <Card size="small" style={{ marginTop: 12, background: 'var(--ethos-bg)' }}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ bindType: 'personality' }}
            onFinish={(values) => addMut.mutate(values)}
          >
            <Form.Item
              label="Bot token"
              name="botToken"
              rules={[{ required: true, message: 'Required' }]}
            >
              <Input.Password autoComplete="off" placeholder="xoxb-…" />
            </Form.Item>
            <Form.Item
              label="App token"
              name="appToken"
              rules={[{ required: true, message: 'Required' }]}
            >
              <Input.Password autoComplete="off" placeholder="xapp-…" />
            </Form.Item>
            <Form.Item
              label="Signing secret"
              name="signingSecret"
              rules={[{ required: true, message: 'Required' }]}
              extra="From Slack app dashboard → Basic Information → App Credentials."
            >
              <Input.Password autoComplete="off" />
            </Form.Item>

            <Form.Item label="Bind to" style={{ marginBottom: 8 }}>
              <Segmented
                options={[
                  { label: 'Personality', value: 'personality' },
                  { label: 'Team', value: 'team' },
                ]}
                value={bindType}
                onChange={(v) => {
                  const t = v as BindType;
                  setBindType(t);
                  form.setFieldValue('bindType', t);
                  form.setFieldValue('bindName', undefined);
                }}
              />
            </Form.Item>

            <Form.Item name="bindType" hidden>
              <Input />
            </Form.Item>

            <Form.Item
              name="bindName"
              rules={[{ required: true, message: `Select a ${bindType}` }]}
            >
              <Select
                placeholder={`Select ${bindType}…`}
                loading={
                  bindType === 'personality' ? personalitiesQuery.isLoading : teamsQuery.isLoading
                }
                options={bindOptions}
              />
            </Form.Item>

            <Space>
              <Button type="primary" htmlType="submit" loading={addMut.isPending}>
                Save app
              </Button>
              <Button
                onClick={() => {
                  setAdding(false);
                  form.resetFields();
                }}
              >
                Cancel
              </Button>
            </Space>
          </Form>
        </Card>
      )}

      <AccessControlSection platform="slack" />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Legacy single-bot panels (Discord, Email — unchanged from v1)
// ---------------------------------------------------------------------------

interface PlatformShape {
  id: 'discord' | 'email';
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

const LEGACY_PLATFORMS: ReadonlyArray<PlatformShape> = [
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

interface AddWhatsAppFormValues {
  id: string;
  default_mode: 'mention_only' | 'all';
  owner_number: string;
  phone_number: string;
  bind_type: BindType;
  bind_name: string;
}

function WhatsAppPanel() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [adding, setAdding] = useState(false);
  const [bindType, setBindType] = useState<BindType>('personality');
  const [form] = Form.useForm<AddWhatsAppFormValues>();

  const botsQuery = useQuery({
    queryKey: ['platforms', 'bots', 'whatsapp'],
    queryFn: () => rpc.platforms.botsListWhatsApp(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
    enabled: adding,
  });

  const teamsQuery = useQuery({
    queryKey: ['kanban', 'list'],
    queryFn: () => rpc.kanban.list(),
    enabled: adding && bindType === 'team',
  });

  const addMut = useMutation({
    mutationFn: async (values: AddWhatsAppFormValues) => {
      await rpc.platforms.botsAddWhatsApp({
        id: values.id,
        defaultMode: values.default_mode,
        phoneNumber: values.phone_number.trim(),
        bind: { type: values.bind_type, name: values.bind_name } satisfies BotBinding,
      });
      // Owner number is stored on the channel filter, not the bot entry. Read
      // the current filter first so we don't clobber the allowlist or enabled flag.
      const current = await rpc.platforms.getChannelFilter({ platform: 'whatsapp' });
      const ownerUserId = `${values.owner_number.trim()}@s.whatsapp.net`;
      await rpc.platforms.setChannelFilter({
        platform: 'whatsapp',
        filter: { ...current.filter, ownerUserId },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'whatsapp'] });
      qc.invalidateQueries({ queryKey: ['platforms', 'channelFilter', 'whatsapp'] });
      qc.invalidateQueries({ queryKey: ['platforms', 'list'] });
      notification.success({ message: 'WhatsApp enabled', placement: 'topRight' });
      form.resetFields();
      setAdding(false);
    },
    onError: (err) =>
      notification.error({ message: 'Enable failed', description: (err as Error).message }),
  });

  const removeMut = useMutation({
    mutationFn: (botKey: string) => rpc.platforms.botsRemoveWhatsApp({ botKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platforms', 'bots', 'whatsapp'] });
      qc.invalidateQueries({ queryKey: ['platforms', 'list'] });
      notification.info({ message: 'WhatsApp bot removed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Remove failed', description: (err as Error).message }),
  });

  const bots: WhatsAppEntry[] = botsQuery.data?.bots ?? [];

  const columns = [
    {
      title: 'Bot ID',
      dataIndex: 'botKey',
      key: 'botKey',
      render: (k: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {k}
        </Typography.Text>
      ),
    },
    {
      title: 'Mode',
      dataIndex: 'defaultMode',
      key: 'defaultMode',
      render: (m: string) => <Tag>{m}</Tag>,
    },
    {
      title: 'Binding',
      key: 'bind',
      render: (_: unknown, row: WhatsAppEntry) =>
        row.bind ? (
          <Space>
            <Tag color={row.bind.type === 'personality' ? 'blue' : 'purple'}>{row.bind.type}</Tag>
            <Typography.Text>{row.bind.name}</Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: 'Pairing',
      key: 'paired',
      render: (_: unknown, row: WhatsAppEntry) =>
        row.paired ? (
          <Badge status="success" text="Paired" />
        ) : (
          <Space direction="vertical" size={2}>
            <Badge status="default" text="Not paired" />
            {row.phoneNumber && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Linking {row.phoneNumber}
              </Typography.Text>
            )}
            <Typography.Link href={`/setup/whatsapp/${row.botKey}`} style={{ fontSize: 12 }}>
              Open WhatsApp setup to get your pairing code ↗
            </Typography.Link>
          </Space>
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, row: WhatsAppEntry) => (
        <Popconfirm
          title="Remove this WhatsApp bot?"
          description="The bot's routing config will be deleted from config.yaml."
          okText="Remove"
          okButtonProps={{ danger: true }}
          onConfirm={() => removeMut.mutate(row.botKey)}
        >
          <Button size="small" danger>
            Remove
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const bindOptions =
    bindType === 'personality'
      ? (personalitiesQuery.data?.items ?? []).map((p) => ({
          label: p.name,
          value: p.id,
        }))
      : (teamsQuery.data?.teams ?? []).map((t) => ({
          label: t.name,
          value: t.name,
        }));

  return (
    <Card
      size="small"
      title="WhatsApp (Baileys)"
      extra={
        <Typography.Link
          href="https://github.com/WhiskeySockets/Baileys"
          target="_blank"
          rel="noreferrer"
        >
          Baileys docs ↗
        </Typography.Link>
      }
      style={{ maxWidth: 720 }}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        WhatsApp pairs via Baileys — no Cloud API credentials needed. Enable a bot with the phone
        number to link, restart the gateway, then enter the pairing code shown in setup (or scan the
        QR as a fallback).
      </Typography.Paragraph>

      {botsQuery.isLoading ? (
        <Spin />
      ) : (
        <Table
          dataSource={bots}
          columns={columns}
          rowKey="botKey"
          pagination={false}
          size="small"
          locale={{ emptyText: 'No WhatsApp bots enabled yet.' }}
          style={{ marginBottom: bots.length > 0 ? 16 : 0 }}
        />
      )}

      {!adding && (
        <Button type="dashed" onClick={() => setAdding(true)} style={{ marginTop: 8 }}>
          + Enable WhatsApp
        </Button>
      )}

      {adding && (
        <Card size="small" style={{ marginTop: 12, background: 'var(--ethos-bg)' }}>
          <Form
            form={form}
            layout="vertical"
            initialValues={{ default_mode: 'mention_only', bind_type: 'personality' }}
            onFinish={(values) => addMut.mutate(values)}
          >
            <Form.Item
              label="Name / ID"
              name="id"
              rules={[{ required: true, message: 'Give this bot a stable id' }]}
            >
              <Input autoComplete="off" placeholder="default" />
            </Form.Item>

            <Form.Item label="Reply mode" name="default_mode">
              <Select
                options={[
                  { label: 'Mention only', value: 'mention_only' },
                  { label: 'All messages', value: 'all' },
                ]}
              />
            </Form.Item>

            <Form.Item
              label="Phone number to link"
              name="phone_number"
              rules={[{ required: true, message: 'Required' }]}
              extra="The WhatsApp number this bot links to, in E.164 format without the + (e.g. 14155551234). You'll enter a pairing code on this phone."
            >
              <Input autoComplete="off" placeholder="14155551234" />
            </Form.Item>

            <Form.Item
              label="Owner number"
              name="owner_number"
              rules={[{ required: true, message: 'Required' }]}
              extra="E.164 format without the + (e.g. 14155551234). Only this number can talk to the bot until you add more under Access Control."
            >
              <Input autoComplete="off" placeholder="14155551234" />
            </Form.Item>

            <Form.Item label="Bind to" style={{ marginBottom: 8 }}>
              <Segmented
                options={[
                  { label: 'Personality', value: 'personality' },
                  { label: 'Team', value: 'team' },
                ]}
                value={bindType}
                onChange={(v) => {
                  const t = v as BindType;
                  setBindType(t);
                  form.setFieldValue('bind_type', t);
                  form.setFieldValue('bind_name', undefined);
                }}
              />
            </Form.Item>

            <Form.Item name="bind_type" hidden>
              <Input />
            </Form.Item>

            <Form.Item
              name="bind_name"
              rules={[{ required: true, message: `Select a ${bindType}` }]}
            >
              <Select
                placeholder={`Select ${bindType}…`}
                loading={
                  bindType === 'personality' ? personalitiesQuery.isLoading : teamsQuery.isLoading
                }
                options={bindOptions}
              />
            </Form.Item>

            <Space>
              <Button type="primary" htmlType="submit" loading={addMut.isPending}>
                Enable WhatsApp
              </Button>
              <Button
                onClick={() => {
                  setAdding(false);
                  form.resetFields();
                }}
              >
                Cancel
              </Button>
            </Space>
          </Form>
        </Card>
      )}

      <Alert
        type="info"
        showIcon
        message="Restart the gateway (or re-run `ethos serve`) to apply, then open the setup link next to a bot above to see its pairing code."
        style={{ marginTop: 16 }}
      />

      <AccessControlSection platform="whatsapp" />
    </Card>
  );
}

function LegacyPlatformPanel({
  shape,
  status,
}: {
  shape: PlatformShape;
  status?: { configured: boolean; fields: Record<string, boolean> };
}) {
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

      <AccessControlSection platform={shape.id} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Access control section (reusable per-platform)
// ---------------------------------------------------------------------------

const PLATFORM_HINTS: Record<string, string> = {
  telegram: 'Send /start to @userinfobot. The number shown is your user ID.',
  slack: 'Open your Slack profile → click the … menu → "Copy member ID".',
  discord: 'Enable Developer Mode → right-click your name → "Copy User ID".',
  email: "Use the sender's full email address (globs supported: *@example.com).",
  whatsapp: 'Your WhatsApp phone number in E.164 format (e.g., +14155551234).',
};

function AccessControlSection({ platform }: { platform: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [enabled, setEnabled] = useState(false);
  const [ownerUserId, setOwnerUserId] = useState('');
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [newId, setNewId] = useState('');
  const [saved, setSaved] = useState(false);

  const filterQuery = useQuery({
    queryKey: ['platforms', 'channelFilter', platform],
    queryFn: () => rpc.platforms.getChannelFilter({ platform }),
  });

  useEffect(() => {
    if (filterQuery.data) {
      setEnabled(filterQuery.data.filter.enabled);
      setOwnerUserId(filterQuery.data.filter.ownerUserId);
      setAllowlist(filterQuery.data.filter.allowlist);
    }
  }, [filterQuery.data]);

  const saveMut = useMutation({
    mutationFn: () =>
      rpc.platforms.setChannelFilter({
        platform,
        filter: { enabled, ownerUserId, allowlist },
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['platforms', 'channelFilter', platform] });
      setEnabled(data.filter.enabled);
      setOwnerUserId(data.filter.ownerUserId);
      setAllowlist(data.filter.allowlist);
      setSaved(true);
      notification.success({ message: 'Access control saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const hint = PLATFORM_HINTS[platform] ?? '';

  const addId = () => {
    const trimmed = newId.trim();
    if (trimmed && !allowlist.includes(trimmed)) {
      setAllowlist([...allowlist, trimmed]);
    }
    setNewId('');
  };

  return (
    <>
      <Divider style={{ margin: '24px 0 16px' }} />
      <Card size="small" title="Access Control" style={{ maxWidth: 720 }}>
        {filterQuery.isLoading ? (
          <Spin />
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Switch checked={enabled} onChange={setEnabled} />
              <Typography.Text>Restrict to specific users</Typography.Text>
            </div>

            {enabled && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
                    Owner ID
                  </Typography.Text>
                  <Input
                    value={ownerUserId}
                    onChange={(e) => setOwnerUserId(e.target.value)}
                    placeholder="Owner user ID"
                    style={{ maxWidth: 400 }}
                  />
                  {hint && (
                    <Typography.Text
                      type="secondary"
                      style={{ display: 'block', marginTop: 4, fontSize: 12 }}
                    >
                      {hint}
                    </Typography.Text>
                  )}
                </div>

                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                    Additional users
                  </Typography.Text>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                    {allowlist.map((id) => (
                      <Tag
                        key={id}
                        closable
                        onClose={() => setAllowlist(allowlist.filter((x) => x !== id))}
                      >
                        {id}
                      </Tag>
                    ))}
                  </div>
                  <Space.Compact>
                    <Input
                      value={newId}
                      onChange={(e) => setNewId(e.target.value)}
                      onPressEnter={addId}
                      placeholder="Add user ID"
                      style={{ maxWidth: 300 }}
                    />
                    <Button onClick={addId}>Add</Button>
                  </Space.Compact>
                </div>
              </>
            )}

            <Button
              type="primary"
              style={{ marginTop: 16 }}
              loading={saveMut.isPending}
              onClick={() => saveMut.mutate()}
            >
              Save access control
            </Button>

            {saved && (
              <Alert
                type="info"
                showIcon
                message="Restart the gateway (or re-run `ethos serve`) to apply changes."
                style={{ marginTop: 16 }}
              />
            )}
          </>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Gateway status pill (DT4) — desktop only
// ---------------------------------------------------------------------------

const GATEWAY_STATE_CONFIG = {
  running: { color: 'success', label: 'Running' },
  stopped: { color: 'default', label: 'Stopped' },
  crashed: { color: 'error', label: 'Crashed' },
  starting: { color: 'processing', label: 'Starting' },
} as const;

function GatewayControl() {
  const [status, setStatus] = useState<{
    state: 'running' | 'stopped' | 'crashed' | 'starting';
    serviceInstalled: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    bridge?.gateway.status().then(setStatus);
  }, []);

  useEffect(() => {
    if (!isDesktop || !bridge) return;
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (!isDesktop || !bridge || !status) return null;
  const b = bridge;

  const cfg = GATEWAY_STATE_CONFIG[status.state];

  const handleToggle = async () => {
    setLoading(true);
    try {
      if (status.state === 'running') {
        await b.gateway.stop();
      } else {
        await b.gateway.start();
      }
      // Wait briefly for state to propagate, then refresh
      setTimeout(refresh, 1500);
    } finally {
      setLoading(false);
    }
  };

  const handleViewLogs = async () => {
    const { path } = await b.gateway.logPath();
    await b.shell.openExternal({ url: `file://${path}` });
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <Tag color={cfg.color}>
        <Badge status={cfg.color as 'success' | 'default' | 'error' | 'processing'} /> Gateway:{' '}
        {cfg.label}
      </Tag>
      <Button
        size="small"
        type={status.state === 'running' ? 'default' : 'primary'}
        loading={loading}
        onClick={handleToggle}
      >
        {status.state === 'running' ? 'Stop' : 'Start'}
      </Button>
      <Typography.Link onClick={handleViewLogs} style={{ fontSize: 12 }}>
        View logs
      </Typography.Link>
      {!status.serviceInstalled && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          (no OS service — using fallback)
        </Typography.Text>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calls (voice V4, DR1/DR3/DR4)
//
// Call history lives HERE — under Communications, behind a filter chip — and
// not behind a new sidebar item, because a phone call is one more channel the
// agent answers on, alongside Telegram and Slack. The trunk credentials, the
// number→bot table and the inbound guards live in Settings → Voice; this tab is
// the record of what actually happened.
// ---------------------------------------------------------------------------

/** One second, because the ticking duration is read as a clock. It keeps
 *  ticking under `prefers-reduced-motion`: a duration is DATA, not motion, and
 *  freezing it would make a live call look hung. Only the dot's pulse stops,
 *  and the stylesheet does that. */
const LIVE_TICK_MS = 1_000;

/** A clock that only runs while something on screen needs it. With no call in
 *  progress there is nothing to re-render every second, so nothing does. */
function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function CallFilterChips({
  filter,
  onChange,
}: {
  filter: CallFilter;
  onChange: (next: CallFilter) => void;
}) {
  return (
    <div className="call-filter-bar">
      <span className="call-filter-label">Direction</span>
      {CALL_DIRECTION_FILTERS.map((f) => (
        <button
          key={f.value}
          type="button"
          aria-pressed={filter.direction === f.value}
          className={`call-filter-chip${filter.direction === f.value ? ' active' : ''}`}
          onClick={() => onChange({ ...filter, direction: f.value })}
        >
          {f.label}
        </button>
      ))}
      <span className="call-filter-label">State</span>
      {CALL_STATUS_FILTERS.map((f) => (
        <button
          key={f.value}
          type="button"
          aria-pressed={filter.status === f.value}
          className={`call-filter-chip${filter.status === f.value ? ' active' : ''}`}
          onClick={() => onChange({ ...filter, status: f.value })}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

/** The text the list deliberately withholds, fetched only when a row is opened. */
function CallTranscriptModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detailQuery = useCallDetail(id);
  const call = detailQuery.data?.call ?? null;
  return (
    <Modal
      open={id !== null}
      onCancel={onClose}
      footer={null}
      width={720}
      title={id ? <span className="call-mono">{id}</span> : null}
    >
      {detailQuery.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
          <Spin />
        </div>
      ) : detailQuery.error ? (
        <Typography.Text type="danger">
          Transcript unreadable — {(detailQuery.error as Error).message}
        </Typography.Text>
      ) : call === null ? (
        // A pruned id is an empty pane, not an error: retention is allowed to
        // have removed it, and saying so is more use than "not found".
        <Typography.Text type="secondary">
          That call is no longer in the log — retention may have removed it.
        </Typography.Text>
      ) : (
        <>
          {call.summary ? (
            <Typography.Paragraph style={{ marginTop: 0 }}>{call.summary}</Typography.Paragraph>
          ) : null}
          {call.transcript ? (
            <pre className="call-transcript">{call.transcript}</pre>
          ) : (
            <Typography.Text type="secondary">This call kept no transcript.</Typography.Text>
          )}
        </>
      )}
    </Modal>
  );
}

function CallsPanel() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<CallFilter>(DEFAULT_CALL_FILTER);
  const [transcriptId, setTranscriptId] = useState<string | null>(null);

  const listQuery = useCallsList(filter);
  const activeQuery = useActiveCalls();
  const personalitiesQuery = usePersonalityList();
  const avatarByPersonalityId = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of personalitiesQuery.data?.items ?? []) {
      if (p.display?.avatar_url) map.set(p.id, p.display.avatar_url);
    }
    return map;
  }, [personalitiesQuery.data]);

  const active = activeQuery.data?.calls ?? [];
  const now = useTickingNow(active.length > 0);
  const history = withoutActive(listQuery.data?.calls ?? [], active);
  const filtered = filter.direction !== 'all' || filter.status !== 'all';

  return (
    <div className="calls-panel">
      {active.length > 0 ? (
        <>
          <Typography.Text strong style={{ fontSize: 13 }}>
            In progress
          </Typography.Text>
          <div className="call-list">
            {active.map((call) => (
              <CallRow
                key={call.id}
                call={call}
                view={callRowView(call, now)}
                onOpenTranscript={setTranscriptId}
                avatarUrl={
                  call.personalityId ? avatarByPersonalityId.get(call.personalityId) : undefined
                }
              />
            ))}
          </div>
        </>
      ) : null}

      <CallFilterChips filter={filter} onChange={setFilter} />

      {listQuery.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
          <Spin />
        </div>
      ) : listQuery.error ? (
        // Never the empty state on a failed read: "no calls yet" and "we could
        // not read the log" are different facts, and the first one sends the
        // operator off to re-check a trunk that is working fine.
        <Typography.Text type="danger">
          Call history unreadable — {(listQuery.error as Error).message}
        </Typography.Text>
      ) : history.length > 0 ? (
        <div className="call-list">
          {history.map((call) => (
            <CallRow
              key={call.id}
              call={call}
              view={callRowView(call, now)}
              onOpenTranscript={setTranscriptId}
              avatarUrl={
                call.personalityId ? avatarByPersonalityId.get(call.personalityId) : undefined
              }
            />
          ))}
        </div>
      ) : filtered ? (
        <div className="call-empty">
          <Typography.Text type="secondary">{CALLS_EMPTY_FILTERED_COPY}</Typography.Text>
          <Button size="small" onClick={() => setFilter(DEFAULT_CALL_FILTER)}>
            Clear filters
          </Button>
        </div>
      ) : active.length > 0 ? null : (
        <div className="call-empty">
          <Typography.Text type="secondary">{CALLS_EMPTY_COPY}</Typography.Text>
          <Button type="primary" onClick={() => navigate('/settings')}>
            Configure a trunk
          </Button>
        </div>
      )}

      <CallTranscriptModal id={transcriptId} onClose={() => setTranscriptId(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root Communications component
// ---------------------------------------------------------------------------

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
      <GatewayControl />
      <Tabs
        defaultActiveKey="telegram"
        items={[
          { key: 'telegram', label: 'Telegram', children: <TelegramPanel /> },
          { key: 'slack', label: 'Slack', children: <SlackPanel /> },
          { key: 'whatsapp', label: 'WhatsApp', children: <WhatsAppPanel /> },
          { key: 'calls', label: 'Calls', children: <CallsPanel /> },
          ...LEGACY_PLATFORMS.map((shape) => {
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
              children: <LegacyPlatformPanel shape={shape} status={status} />,
            };
          }),
        ]}
      />
    </div>
  );
}
