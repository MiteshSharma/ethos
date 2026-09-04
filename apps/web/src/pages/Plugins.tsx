import type { PluginInfo } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Collapse,
  Empty,
  Input,
  Skeleton,
  Switch,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  type PluginCredentialSchema,
  PluginSettingsDrawer,
} from '../components/PluginSettingsDrawer';
import { PluginStatusNote } from '../components/PluginStatusNote';
import { PersonalityMark } from '../components/ui/PersonalityMark';
import { personalityKeys } from '../features/personalities/api/keys';
import { usePersonalityGet } from '../features/personalities/api/queries';
import { useCreateFlag } from '../hooks/useCreateFlag';
import { splitByAttachment, usedByPersonalityIds } from '../lib/attachmentLists';
import { client, rpc } from '../rpc';

function InstallPluginSection() {
  const { notification } = AntApp.useApp();
  const qc = useQueryClient();
  const [packageSpec, setPackageSpec] = useState('');

  const mut = useMutation({
    mutationFn: (spec: string) => rpc.plugins.install({ packageSpec: spec }),
    onSuccess: () => {
      notification.success({ message: 'Plugin installed' });
      setPackageSpec('');
      qc.invalidateQueries({ queryKey: ['plugins', 'list'] });
    },
    onError: (err) => {
      notification.error({
        message: 'Install failed',
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
      <Input
        placeholder="Package spec, e.g. @scope/my-plugin@1.0.0"
        value={packageSpec}
        onChange={(e) => setPackageSpec(e.target.value)}
        onPressEnter={() => packageSpec.trim() && mut.mutate(packageSpec.trim())}
        disabled={mut.isPending}
        style={{ flex: 1 }}
      />
      <Button
        type="primary"
        loading={mut.isPending}
        disabled={!packageSpec.trim()}
        onClick={() => mut.mutate(packageSpec.trim())}
      >
        Install
      </Button>
    </div>
  );
}

// Plugins page — global matrix of plugins × personalities.
//
// Antd Table, rows = plugins, cols = personalities.
// Below 900px: pivots to per-plugin Collapse accordion.
//
// Attachment toggles call personalities.update({ plugins: [...] })
// optimistically per-personality per-plugin. Rollback on error.
//
// P2 (plan/phases/personality-first-ui.md): `/plugins` (Library, this whole
// matrix, unchanged) and `/p/:personalityId/plugins` (workspace —
// `personalities.get() → plugins[]`, just this agent's row) are two
// different components sharing one route name, same split as Skills/MCP.

export function Plugins() {
  const { personalityId } = useParams<{ personalityId?: string }>();
  if (personalityId) return <WorkspacePluginsPanel personalityId={personalityId} />;
  return <LibraryPluginsPage />;
}

function LibraryPluginsPage() {
  const {
    data: pluginsData,
    isLoading: pluginsLoading,
    error: pluginsError,
  } = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const { data: personalitiesData, isLoading: persLoading } = useQuery({
    queryKey: personalityKeys.list(),
    queryFn: () => rpc.personalities.list({}),
  });

  const isLoading = pluginsLoading || persLoading;
  const [installOpen, setInstallOpen] = useState(false);
  const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);

  // P5 — StageHeader's "+ New Plugin" action navigates here with
  // `?create=1`; this force-opens the same inline install section the
  // page's own button toggles (never re-closes it, unlike the toggle).
  const shouldCreate = useCreateFlag();
  useEffect(() => {
    if (shouldCreate) setInstallOpen(true);
  }, [shouldCreate]);

  const settingsPlugin = settingsPluginId
    ? ((pluginsData?.plugins ?? []).find((p) => p.id === settingsPluginId) ?? null)
    : null;

  const { data: credKeysData } = useQuery({
    queryKey: ['plugins', 'credentialKeys', settingsPluginId],
    queryFn: () => {
      const id = settingsPluginId;
      if (!id) return { keys: [] };
      return rpc.plugins.listCredentialKeys({ pluginId: id });
    },
    enabled: Boolean(settingsPluginId),
  });

  const credentials = useMemo((): PluginCredentialSchema[] => {
    if (!settingsPluginId) return [];
    // Zerodha: hardcoded because the access token uses kind:'oauth' which
    // listCredentialKeys doesn't surface (it only knows 'secret'/'text').
    if (settingsPluginId === 'tools-india-broker-zerodha') {
      return [
        { ref: 'brokers/zerodha/apiKey', label: 'API Key', kind: 'secret' },
        { ref: 'brokers/zerodha/apiSecret', label: 'API Secret', kind: 'secret' },
        {
          ref: 'brokers/zerodha/accessToken',
          label: 'Access Token',
          kind: 'oauth',
          oauthRef: 'zerodha',
        },
      ];
    }
    return (credKeysData?.keys ?? []).map((k) => ({
      ref: k.key,
      label: k.label,
      kind: k.type as 'text' | 'secret',
      description: k.description ?? undefined,
    }));
  }, [settingsPluginId, credKeysData]);

  if (pluginsError) {
    return (
      <Typography.Text type="danger">
        Failed to load plugins: {(pluginsError as Error).message}
      </Typography.Text>
    );
  }

  const plugins = pluginsData?.plugins ?? [];
  const personalities = personalitiesData?.items ?? [];

  return (
    <div className="plugins-tab">
      <header className="page-header-row">
        <h1 className="page-h1">All plugins</h1>
        <span className="page-subtitle">
          {plugins.length} {plugins.length === 1 ? 'plugin' : 'plugins'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="page-action-btn" onClick={() => setInstallOpen((o) => !o)}>
          + New Plugin
        </button>
      </header>
      {installOpen && <InstallPluginSection />}
      <PluginsMatrix
        plugins={plugins}
        personalities={personalities}
        loading={isLoading}
        onSettingsOpen={setSettingsPluginId}
      />
      {settingsPlugin && (
        <PluginSettingsDrawer
          pluginId={settingsPlugin.id}
          name={settingsPlugin.name}
          version={settingsPlugin.version}
          description={settingsPlugin.description ?? undefined}
          credentials={credentials}
          tools={[]}
          theme="dark"
          client={client}
          onClose={() => setSettingsPluginId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace panel — P3: two lists, attached and installed-but-not-attached,
// each row with a toggle. Both go through `personalities.update({ id,
// plugins })` — the same RPC the Library matrix's `AttachCell` already uses,
// just scoped to this one personality instead of iterating the whole roster.
// ---------------------------------------------------------------------------

function WorkspacePluginsPanel({ personalityId }: { personalityId: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const personalityQuery = usePersonalityGet(personalityId);
  const { data: pluginsData, isLoading: pluginsLoading } = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const attachedIds = personalityQuery.data?.personality.plugins ?? [];
  const allPlugins = pluginsData?.plugins ?? [];
  const { attached, notAttached } = splitByAttachment(
    allPlugins,
    new Set(attachedIds),
    (p) => p.id,
  );

  // Shared query keys, not a dedicated round trip (P3's "Done when" bar):
  // `personalityKeys.list()` feeds the ScopeNav fraction and the Library
  // matrix/"Used by"; `personalityKeys.detail(id)` is this panel's own read.
  const toggleMut = useMutation({
    mutationFn: ({ pluginId, attach }: { pluginId: string; attach: boolean }) => {
      const next = attach
        ? [...attachedIds, pluginId]
        : attachedIds.filter((id) => id !== pluginId);
      return rpc.personalities.update({ id: personalityId, plugins: next });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: personalityKeys.list() });
      qc.invalidateQueries({ queryKey: personalityKeys.detail(personalityId) });
    },
    onError: (err) =>
      notification.error({ message: 'Update failed', description: (err as Error).message }),
  });

  function toggle(pluginId: string, attach: boolean) {
    toggleMut.mutate({ pluginId, attach });
  }

  if (personalityQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load this agent: {(personalityQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const isLoading = personalityQuery.isLoading || pluginsLoading;

  return (
    <div className="plugins-tab">
      <header className="page-header-row">
        <h1 className="page-h1">Plugins</h1>
        <span className="page-subtitle">
          {attached.length} {attached.length === 1 ? 'plugin' : 'plugins'}
        </span>
      </header>
      {isLoading ? (
        <Skeleton active paragraph={{ rows: 5 }} />
      ) : (
        <>
          <PluginsSectionLabel>Attached ({attached.length})</PluginsSectionLabel>
          {attached.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No plugins attached to this agent. Attach one from the library below."
            />
          ) : (
            <PluginsToggleTable
              plugins={attached}
              checked
              pending={toggleMut.isPending ? toggleMut.variables?.pluginId : undefined}
              onToggle={(id) => toggle(id, false)}
            />
          )}

          <PluginsSectionLabel>Installed, not attached ({notAttached.length})</PluginsSectionLabel>
          {notAttached.length === 0 ? (
            <Typography.Text type="secondary">
              Every installed plugin is already attached to this agent.
            </Typography.Text>
          ) : (
            <PluginsToggleTable
              plugins={notAttached}
              checked={false}
              pending={toggleMut.isPending ? toggleMut.variables?.pluginId : undefined}
              onToggle={(id) => toggle(id, true)}
            />
          )}
        </>
      )}
    </div>
  );
}

function PluginsSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        margin: '20px 0 10px',
      }}
    >
      {children}
    </div>
  );
}

function PluginsToggleTable({
  plugins,
  checked,
  pending,
  onToggle,
}: {
  plugins: PluginInfo[];
  checked: boolean;
  pending: string | undefined;
  onToggle: (pluginId: string) => void;
}) {
  return (
    <Table<PluginInfo>
      rowKey="id"
      dataSource={plugins}
      pagination={false}
      size="small"
      columns={[
        {
          title: 'Plugin',
          key: 'plugin',
          render: (_, p) => (
            <div>
              <div style={{ fontWeight: 500 }}>
                {p.name}
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 11, marginLeft: 6, fontWeight: 400 }}
                >
                  v{p.version}
                </Typography.Text>
              </div>
              <Typography.Text
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
                type="secondary"
              >
                {p.id}
              </Typography.Text>
              <PluginStatusNote plugin={p} />
            </div>
          ),
        },
        {
          title: '',
          key: 'toggle',
          width: 90,
          align: 'right' as const,
          render: (_, p) => (
            <Switch
              size="small"
              checked={checked}
              loading={pending === p.id}
              onChange={() => onToggle(p.id)}
              aria-label={`${checked ? 'Detach' : 'Attach'} ${p.name}`}
            />
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Matrix — plugins × personalities. Responsive: table above 900px,
// per-plugin accordion below 900px.
// ---------------------------------------------------------------------------

function PluginsMatrix({
  plugins,
  personalities,
  loading,
  onSettingsOpen,
}: {
  plugins: PluginInfo[];
  personalities: import('@ethosagent/web-contracts').Personality[];
  loading: boolean;
  onSettingsOpen: (pluginId: string) => void;
}) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 900);

  // Detect viewport width changes.
  if (typeof window !== 'undefined') {
    const mq = window.matchMedia('(max-width: 899px)');
    mq.onchange = (e) => setNarrow(e.matches);
  }

  if (loading) {
    return <Skeleton active paragraph={{ rows: 5 }} />;
  }

  if (plugins.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No plugins installed.{' '}
            <Typography.Text code>ethos plugin install &lt;path&gt;</Typography.Text> drops one into
            ~/.ethos/plugins/.
          </span>
        }
      />
    );
  }

  // Unattached: plugins with zero personality attachments anywhere.
  const unattached = plugins.filter((p) =>
    personalities.every((pers) => !(pers.plugins ?? []).includes(p.id)),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {unattached.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`${unattached.length} ${unattached.length === 1 ? 'plugin is' : 'plugins are'} installed but not attached to any personality — they're inert until attached.`}
          closable
        />
      ) : null}
      {narrow ? (
        <PluginsAccordion
          plugins={plugins}
          personalities={personalities}
          onSettingsOpen={onSettingsOpen}
        />
      ) : (
        <PluginsTable
          plugins={plugins}
          personalities={personalities}
          onSettingsOpen={onSettingsOpen}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full matrix table (≥900px)
// ---------------------------------------------------------------------------

function PluginsTable({
  plugins,
  personalities,
  onSettingsOpen,
}: {
  plugins: PluginInfo[];
  personalities: import('@ethosagent/web-contracts').Personality[];
  onSettingsOpen: (pluginId: string) => void;
}) {
  const navigate = useNavigate();
  const attachments = useMemo(
    () => personalities.map((p) => ({ personalityId: p.id, itemIds: p.plugins ?? [] })),
    [personalities],
  );
  const personalityCols = personalities.map((pers) => ({
    title: <span style={{ fontSize: 12 }}>{pers.name}</span>,
    key: pers.id,
    width: 120,
    align: 'center' as const,
    render: (_: unknown, plugin: PluginInfo) => <AttachCell plugin={plugin} personality={pers} />,
  }));

  return (
    <Table<PluginInfo>
      aria-label="Plugin attachment matrix"
      rowKey="id"
      dataSource={plugins}
      pagination={false}
      size="small"
      columns={[
        {
          title: 'Plugin',
          key: 'plugin',
          render: (_, p) => (
            <div>
              <div style={{ fontWeight: 500 }}>
                {p.name}
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 11, marginLeft: 6, fontWeight: 400 }}
                >
                  v{p.version}
                </Typography.Text>
              </div>
              <Typography.Text
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
                type="secondary"
              >
                {p.id}
              </Typography.Text>
              <PluginStatusNote plugin={p} />
            </div>
          ),
        },
        {
          title: 'Used by',
          key: 'usedBy',
          width: 100,
          render: (_: unknown, p: PluginInfo) => (
            <PluginUsedByMarks
              personalityIds={usedByPersonalityIds(p.id, attachments)}
              personalities={personalities}
            />
          ),
        },
        ...personalityCols,
        {
          title: '',
          key: 'page',
          width: 100,
          render: (_: unknown, p: PluginInfo) =>
            p.pluginContractMajor != null && p.pluginContractMajor >= 2 ? (
              <Button
                size="small"
                type="link"
                onClick={() => navigate(`/plugins/${encodeURIComponent(p.id)}`)}
              >
                View Page
              </Button>
            ) : null,
        },
        {
          title: '',
          key: 'settings',
          width: 80,
          render: (_: unknown, p: PluginInfo) => (
            <Button size="small" onClick={() => onSettingsOpen(p.id)}>
              Settings
            </Button>
          ),
        },
      ]}
    />
  );
}

// P3 "Used by" — a compact marks summary of the same attachment state the
// matrix's checkbox columns already carry (`attachments` is derived from the
// same `personalities` prop, no extra fetch). Kept alongside the full matrix
// rather than replacing it: the matrix is where attach/detach actually
// happens; this is the at-a-glance answer for "who has this" without
// scanning across every column.
function PluginUsedByMarks({
  personalityIds,
  personalities,
}: {
  personalityIds: string[];
  personalities: import('@ethosagent/web-contracts').Personality[];
}) {
  if (personalityIds.length === 0) {
    return <Typography.Text type="secondary">none</Typography.Text>;
  }
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {personalityIds.map((id) => (
        <Tooltip key={id} title={personalities.find((p) => p.id === id)?.name ?? id}>
          <span style={{ display: 'inline-flex' }}>
            <PersonalityMark
              personalityId={id}
              size={16}
              avatarUrl={personalities.find((p) => p.id === id)?.display?.avatar_url}
            />
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-plugin accordion (< 900px)
// ---------------------------------------------------------------------------

function PluginsAccordion({
  plugins,
  personalities,
  onSettingsOpen,
}: {
  plugins: PluginInfo[];
  personalities: import('@ethosagent/web-contracts').Personality[];
  onSettingsOpen: (pluginId: string) => void;
}) {
  const navigate = useNavigate();
  return (
    <Collapse
      accordion={false}
      items={plugins.map((plugin) => ({
        key: plugin.id,
        label: (
          <span>
            <span style={{ fontWeight: 500 }}>{plugin.name}</span>{' '}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              v{plugin.version}
            </Typography.Text>{' '}
            <Typography.Text
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
              type="secondary"
            >
              {plugin.id}
            </Typography.Text>
            {/* The reason lives in the panel; the header only has to say the
                panel is worth opening — a control here would fight the toggle. */}
            {plugin.status === 'failed' ? (
              <Typography.Text type="danger" style={{ fontSize: 11 }}>
                {' '}
                ✗ Not loaded
              </Typography.Text>
            ) : null}
          </span>
        ),
        children: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <PluginStatusNote plugin={plugin} />
            {personalities.map((pers) => (
              <div key={pers.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <AttachCell plugin={plugin} personality={pers} />
                <span>{pers.name}</span>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              {plugin.pluginContractMajor != null && plugin.pluginContractMajor >= 2 ? (
                <Button
                  size="small"
                  type="link"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => navigate(`/plugins/${encodeURIComponent(plugin.id)}`)}
                >
                  View Page
                </Button>
              ) : null}
              <Button size="small" onClick={() => onSettingsOpen(plugin.id)}>
                Settings
              </Button>
            </div>
          </div>
        ),
      }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Single attach cell — optimistic Switch/Checkbox toggle
// ---------------------------------------------------------------------------

function AttachCell({
  plugin,
  personality,
}: {
  plugin: PluginInfo;
  personality: import('@ethosagent/web-contracts').Personality;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const current = personality.plugins ?? [];
  const isOn = current.includes(plugin.id);

  const mut = useMutation({
    mutationFn: (next: string[]) => rpc.personalities.update({ id: personality.id, plugins: next }),
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: ['personalities', 'list'] });
      const prev = qc.getQueryData<{
        items: import('@ethosagent/web-contracts').Personality[];
      }>(['personalities', 'list']);
      qc.setQueryData<{
        items: import('@ethosagent/web-contracts').Personality[];
        nextCursor: string | null;
        defaultId: string;
      }>(['personalities', 'list'], (old) => {
        if (!old) return old;
        return {
          ...old,
          items: old.items.map((p) => (p.id === personality.id ? { ...p, plugins: next } : p)),
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['personalities', 'list'], ctx.prev);
      notification.error({
        message: 'Attach failed',
        description: `Could not update ${personality.name}`,
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
    },
  });

  function toggle(on: boolean) {
    const next = on ? [...current, plugin.id] : current.filter((id) => id !== plugin.id);
    mut.mutate(next);
  }

  return (
    <Checkbox
      checked={isOn}
      disabled={mut.isPending}
      onChange={(e) => toggle(e.target.checked)}
      aria-label={`Attach ${plugin.name} to ${personality.name}`}
    />
  );
}
