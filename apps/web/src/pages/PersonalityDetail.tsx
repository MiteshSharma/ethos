import type { McpPolicy } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Input,
  Modal,
  Popconfirm,
  Result,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ConnectMcpModal } from '../components/mcp/ConnectMcpModal';
import { A2aPeersSection } from '../components/personality/A2aPeersSection';
import { CharacterSheetView } from '../components/personality/CharacterSheetView';
import { TriggersSection } from '../components/personality/TriggersSection';
import { ToolSettingsForm } from '../components/tool-settings/ToolSettingsForm';
import { PersonalityMark } from '../components/ui/PersonalityMark';
import { useToolSettingsSetForPersonality } from '../features/settings/api/mutations';
import {
  useToolSettingsForPersonality,
  useToolSettingsSchemas,
} from '../features/settings/api/queries';
import { canRetirePersonality, retireConfirmCopy } from '../lib/personalityIdentityActions';
import { buildIdentityRedirectPath } from '../lib/workspaceRoutes';
import { rpc } from '../rpc';
import {
  DuplicateModal,
  EditModal,
  type EditModalTabKey,
  initialSelectionFor,
  ServerToolChecklist,
  type ServerToolState,
} from './Personalities';

// ---------------------------------------------------------------------------
// MCP Section — shows per-server connection state, auth actions, tool checklists
// ---------------------------------------------------------------------------

const OAUTH_POPUP_WIDTH = 520;
const OAUTH_POPUP_HEIGHT = 720;

function McpSection({
  personalityId,
  mcpPolicy,
}: {
  personalityId: string;
  mcpPolicy: McpPolicy | null;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [toolState, setToolState] = useState<Record<string, ServerToolState>>({});
  const [dirty, setDirty] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  // Issue 2: per-server enabled state, derived from mcpPolicy
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>({});

  // OAuth flow state
  const [oauthServer, setOauthServer] = useState<string | null>(null);
  const [oauthState, setOauthState] = useState('');
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [bearerTokenServer, setBearerTokenServer] = useState<string | null>(null);
  const [bearerTokenInput, setBearerTokenInput] = useState('');
  const [testResult, setTestResult] = useState<{
    serverName: string;
    ok: boolean;
    tools: { name: string; description?: string }[];
    /** Raw error message from the thrown exception or the API. */
    error?: string;
    /** Classified failure kind — drives the guidance copy in the modal. */
    errorKind?:
      | 'auth_missing'
      | 'auth_rejected'
      | 'no_tools'
      | 'timeout'
      | 'connection_refused'
      | 'unknown';
  } | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingStartRef = useRef<number>(0);

  const { data, isLoading } = useQuery({
    queryKey: ['mcp', 'personalityServers', personalityId],
    queryFn: () => rpc.mcp.personalityServers({ personalityId }),
  });

  // Issue 2: initialize enabledMap from policy on first load
  useEffect(() => {
    if (!data) return;
    const init: Record<string, boolean> = {};
    for (const s of data.servers) {
      const policy = mcpPolicy?.servers?.[s.name];
      // Default to enabled unless explicitly disabled in mcp.yaml
      init[s.name] = policy?.enabled !== false;
    }
    setEnabledMap(init);
  }, [data, mcpPolicy]);

  const saveMut = useMutation({
    mutationFn: () => {
      // Only include enabled servers
      const mcpServers = servers.filter((s) => enabledMap[s.name] !== false).map((s) => s.name);
      const mcpTools: Record<string, string[]> = {};
      for (const server of mcpServers) {
        const st = toolState[server];
        if (!st || st.tools == null) continue;
        if (st.selected.size < st.tools.length) {
          mcpTools[server] = st.tools.filter((t) => st.selected.has(t));
        }
      }
      return rpc.personalities.update({
        id: personalityId,
        mcp_servers: mcpServers,
        mcp_tools: mcpTools,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', personalityId] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', personalityId] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      setDirty(false);
      notification.success({ message: 'Tool selection saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const removeMut = useMutation({
    mutationFn: (serverName: string) => {
      const filtered = servers.filter((s) => s.name !== serverName).map((s) => s.name);
      return rpc.personalities.update({ id: personalityId, mcp_servers: filtered });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', personalityId] });
      qc.invalidateQueries({ queryKey: ['mcp', 'personalityServers', personalityId] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', personalityId] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'Server removed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to remove server',
        description: (err as Error).message,
      }),
  });

  const reconnectMut = useMutation({
    mutationFn: (input: { name: string; personalityId?: string }) => rpc.mcp.reconnect(input),
    onSuccess: (result, variables) => {
      if (!result.ok) {
        notification.error({
          message: 'Authentication failed',
          description: 'detail' in result ? result.detail : result.code,
        });
        return;
      }
      setOauthServer(variables.name);
      setOauthState(result.state);
      const popup = window.open(
        result.authorizeUrl,
        '_blank',
        `width=${OAUTH_POPUP_WIDTH},height=${OAUTH_POPUP_HEIGHT}`,
      );
      if (!popup || popup.closed) {
        sessionStorage.setItem('ethos:mcp_oauth_return', `/personalities/${personalityId}`);
        window.location.href = result.authorizeUrl;
        return;
      }
      popupRef.current = popup;
      startPolling();
    },
    onError: (err) =>
      notification.error({
        message: 'Authentication failed',
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  const setTokenMut = useMutation({
    mutationFn: ({ server, token }: { server: string; token: string }) =>
      rpc.personalities.mcpSetToken({ personalityId, server, token }),
    onSuccess: () => {
      setBearerTokenServer(null);
      setBearerTokenInput('');
      qc.invalidateQueries({ queryKey: ['mcp', 'personalityServers', personalityId] });
      notification.success({ message: 'Token saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to save token',
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingStartRef.current = Date.now();
    pollingRef.current = setInterval(async () => {
      try {
        const result = await rpc.mcp.status();
        if (result.status === 'connected') {
          stopPolling();
          popupRef.current?.close();
          popupRef.current = null;
          setOauthServer(null);
          setOauthState('');
          qc.invalidateQueries({ queryKey: ['mcp', 'personalityServers', personalityId] });
          notification.success({ message: 'Authentication successful', placement: 'topRight' });
        } else if (result.status === 'error') {
          stopPolling();
          popupRef.current?.close();
          popupRef.current = null;
          setOauthServer(null);
          notification.error({ message: 'Authentication failed', description: result.error });
        } else if (result.status === 'expired') {
          if (Date.now() - pollingStartRef.current >= 5 * 60 * 1000) {
            stopPolling();
            popupRef.current?.close();
            popupRef.current = null;
            setOauthServer(null);
            setOauthState('');
            notification.error({ message: 'Authorization session expired' });
          }
        }
      } catch {
        // Keep polling
      }
    }, 2000);
  }, [stopPolling, personalityId, qc, notification]);

  // Listen for BroadcastChannel from OAuth popup
  useEffect(() => {
    if (!oauthServer) return;

    const channel = new BroadcastChannel('ethos:mcp_oauth');

    channel.onmessage = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown> | null;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ethos:mcp_oauth_success' && msg.state === oauthState) {
        stopPolling();
        popupRef.current?.close();
        popupRef.current = null;
        setOauthServer(null);
        setOauthState('');
        qc.invalidateQueries({ queryKey: ['mcp', 'personalityServers', personalityId] });
        notification.success({ message: 'Authentication successful', placement: 'topRight' });
      } else if (msg.type === 'ethos:mcp_oauth_error' && msg.state === oauthState) {
        stopPolling();
        popupRef.current?.close();
        popupRef.current = null;
        setOauthServer(null);
        setOauthState('');
        const detail = typeof msg.detail === 'string' ? msg.detail : undefined;
        const code = typeof msg.code === 'string' ? msg.code : undefined;
        notification.error({
          message: 'Authentication failed',
          description: detail ?? code ?? 'OAuth failed',
        });
      }
    };

    return () => channel.close();
  }, [oauthServer, oauthState, stopPolling, personalityId, qc, notification]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const handleDiscovered = (serverName: string, discovered: string[]) => {
    setToolState((prev) => {
      if (prev[serverName]?.tools != null) return prev;
      const policyTools = initialSelectionFor(serverName, mcpPolicy);
      const selected = new Set(policyTools ?? discovered);
      return { ...prev, [serverName]: { tools: discovered, selected } };
    });
  };

  const handleToggle = (serverName: string, toolName: string) => {
    setToolState((prev) => {
      const st = prev[serverName];
      if (!st) return prev;
      const selected = new Set(st.selected);
      if (selected.has(toolName)) selected.delete(toolName);
      else selected.add(toolName);
      return { ...prev, [serverName]: { ...st, selected } };
    });
    setDirty(true);
  };

  const handleTest = async (serverName: string) => {
    setTestingServer(serverName);
    try {
      const result = await rpc.mcp.serverTools({ personalityId, serverName });
      if (result.available && result.tools.length > 0) {
        setTestResult({ serverName, ok: true, tools: result.tools });
      } else {
        const server = data?.servers.find((s) => s.name === serverName);
        const authMissing = server?.auth_status === 'missing';
        setTestResult({
          serverName,
          ok: false,
          tools: [],
          error: authMissing
            ? 'No authentication token is configured for this server.'
            : 'Server connected but returned no tools.',
          errorKind: authMissing ? 'auth_missing' : 'no_tools',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      const errorKind =
        lower.includes('timeout') || lower.includes('timed out')
          ? 'timeout'
          : lower.includes('401') || lower.includes('unauthorized')
            ? 'auth_rejected'
            : lower.includes('403') || lower.includes('forbidden')
              ? 'auth_rejected'
              : lower.includes('econnrefused') || lower.includes('connection refused')
                ? 'connection_refused'
                : 'unknown';
      setTestResult({ serverName, ok: false, tools: [], error: msg, errorKind });
    } finally {
      setTestingServer(null);
    }
  };

  const handleAuthenticate = (serverName: string) => {
    reconnectMut.mutate({ name: serverName, personalityId });
  };

  const servers = data?.servers ?? [];

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div style={{ marginBottom: 32 }}>
        <Typography.Title level={5} style={{ marginBottom: 12 }}>
          MCP Servers
        </Typography.Title>
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          No MCP servers attached to this personality.
        </Typography.Text>
        <Button onClick={() => setConnectOpen(true)}>Connect a server</Button>
        <ConnectMcpModal
          open={connectOpen}
          personalityId={personalityId}
          existingServers={[]}
          onClose={() => setConnectOpen(false)}
          onConnected={() => setConnectOpen(false)}
        />
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 32 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <Typography.Title level={5} style={{ margin: 0 }}>
          MCP Servers
        </Typography.Title>
        <Button onClick={() => setConnectOpen(true)}>Connect server</Button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {servers.map((server) => (
          <div
            key={server.name}
            style={{
              borderBottom: '1px solid var(--border-subtle, #2A2A2A)',
              paddingBottom: 12,
              opacity: enabledMap[server.name] === false ? 0.5 : 1,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              {/* Issue 2: enable/disable toggle */}
              <Tooltip
                title={enabledMap[server.name] === false ? 'Enable server' : 'Disable server'}
              >
                <Switch
                  size="small"
                  checked={enabledMap[server.name] !== false}
                  onChange={(checked) => {
                    setEnabledMap((prev) => ({ ...prev, [server.name]: checked }));
                    setDirty(true);
                  }}
                />
              </Tooltip>
              <Typography.Text strong>{server.name}</Typography.Text>
              {server.transport ? (
                <Tag bordered={false} style={{ fontSize: 11 }}>
                  {server.transport}
                </Tag>
              ) : null}
              {/* Issue 7: SSE deprecation tag */}
              {server.transport === 'sse' ? (
                <Tag color="warning" bordered={false} style={{ fontSize: 11 }}>
                  deprecated
                </Tag>
              ) : null}
              {server.url ? (
                <Typography.Text
                  type="secondary"
                  style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
                >
                  {server.url}
                </Typography.Text>
              ) : null}
              {server.auth_status === 'authorized' ? (
                <Tag color="green" bordered={false} style={{ fontSize: 11 }}>
                  Connected
                </Tag>
              ) : server.auth_status === 'missing' ? (
                <Tag color="orange" bordered={false} style={{ fontSize: 11 }}>
                  Pending authentication
                </Tag>
              ) : (
                <Tag color="red" bordered={false} style={{ fontSize: 11 }}>
                  Token expired
                </Tag>
              )}
              <div style={{ flex: 1 }} />
              <Popconfirm
                title={`Remove ${server.name}?`}
                description="This server will be disconnected from this personality."
                onConfirm={() => removeMut.mutate(server.name)}
                okText="Remove"
                okButtonProps={{ danger: true }}
              >
                <Button size="small" danger loading={removeMut.isPending}>
                  Remove
                </Button>
              </Popconfirm>
            </div>

            {server.auth_status === 'missing' && server.auth_type === 'bearer' ? (
              <div style={{ paddingLeft: 0, paddingTop: 4 }}>
                <Button
                  size="small"
                  onClick={() => {
                    setBearerTokenInput('');
                    setBearerTokenServer(server.name);
                  }}
                >
                  Set token
                </Button>
              </div>
            ) : server.auth_status === 'missing' ? (
              <div style={{ paddingLeft: 0, paddingTop: 4 }}>
                <Button
                  size="small"
                  onClick={() => handleAuthenticate(server.name)}
                  loading={reconnectMut.isPending && oauthServer === server.name}
                  disabled={!server.url}
                >
                  Authenticate
                </Button>
              </div>
            ) : null}

            {server.auth_status === 'expired' ? (
              <div style={{ paddingLeft: 0, paddingTop: 4, marginBottom: 4 }}>
                <Button
                  size="small"
                  onClick={() => handleAuthenticate(server.name)}
                  loading={reconnectMut.isPending && oauthServer === server.name}
                  disabled={!server.url}
                >
                  Re-authenticate
                </Button>
              </div>
            ) : null}

            {server.auth_status === 'authorized' ? (
              <div
                style={{ paddingLeft: 0, paddingTop: 4, marginBottom: 4, display: 'flex', gap: 8 }}
              >
                <Button
                  size="small"
                  loading={testingServer === server.name}
                  onClick={() => handleTest(server.name)}
                >
                  Test connection
                </Button>
                {server.auth_type === 'bearer' ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setBearerTokenInput('');
                      setBearerTokenServer(server.name);
                    }}
                  >
                    Update token
                  </Button>
                ) : null}
                {server.auth_type === 'none' && server.transport !== 'stdio' ? (
                  <Button
                    size="small"
                    onClick={() => {
                      setBearerTokenInput('');
                      setBearerTokenServer(server.name);
                    }}
                  >
                    Set bearer token
                  </Button>
                ) : null}
              </div>
            ) : null}
            {server.auth_status === 'authorized' || server.auth_status === 'expired' ? (
              <ServerToolChecklist
                personalityId={personalityId}
                serverName={server.name}
                state={toolState[server.name]}
                onDiscovered={(tools) => handleDiscovered(server.name, tools)}
                onToggle={(toolName) => handleToggle(server.name, toolName)}
              />
            ) : null}
          </div>
        ))}
      </div>

      {dirty ? (
        <Button
          type="primary"
          loading={saveMut.isPending}
          onClick={() => saveMut.mutate()}
          style={{ marginTop: 12 }}
        >
          Save tool selection
        </Button>
      ) : null}

      <Modal
        open={bearerTokenServer !== null}
        title={`Bearer Token — ${bearerTokenServer ?? ''}`}
        onCancel={() => setBearerTokenServer(null)}
        onOk={() => {
          if (bearerTokenServer && bearerTokenInput.trim()) {
            setTokenMut.mutate({ server: bearerTokenServer, token: bearerTokenInput.trim() });
          }
        }}
        okText="Save token"
        confirmLoading={setTokenMut.isPending}
        okButtonProps={{ disabled: !bearerTokenInput.trim() }}
        width={460}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          Paste the bearer token for this server. It is stored securely and sent as an{' '}
          <Typography.Text code style={{ fontSize: 11 }}>
            Authorization: Bearer …
          </Typography.Text>{' '}
          header on every request.
        </Typography.Paragraph>
        <Input.Password
          value={bearerTokenInput}
          onChange={(e) => setBearerTokenInput(e.target.value)}
          placeholder="Paste bearer token"
          autoFocus
        />
      </Modal>
      <Modal
        open={testResult !== null}
        onCancel={() => setTestResult(null)}
        footer={
          <Button type="primary" onClick={() => setTestResult(null)}>
            Close
          </Button>
        }
        title={`Test Connection — ${testResult?.serverName ?? ''}`}
        width={520}
      >
        {testResult?.ok ? (
          <div>
            <Result
              status="success"
              title="Connected"
              subTitle={`${testResult.tools.length} tool${testResult.tools.length === 1 ? '' : 's'} available`}
              style={{ paddingBlock: 16 }}
            />
            <div
              style={{
                maxHeight: 280,
                overflowY: 'auto',
                border: '1px solid var(--color-border, #f0f0f0)',
                borderRadius: 6,
                padding: '8px 12px',
              }}
            >
              {testResult.tools.map((t) => (
                <div key={t.name} style={{ marginBottom: 6 }}>
                  <Typography.Text code style={{ fontSize: 11 }}>
                    {t.name}
                  </Typography.Text>
                  {t.description ? (
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 11, marginLeft: 8, display: 'inline' }}
                    >
                      {t.description}
                    </Typography.Text>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Result
            status="error"
            title="Connection Failed"
            subTitle={(() => {
              switch (testResult?.errorKind) {
                case 'auth_missing':
                  return 'No authentication token configured.';
                case 'auth_rejected':
                  return 'Server rejected the credentials.';
                case 'no_tools':
                  return 'Server connected but returned no tools.';
                case 'timeout':
                  return 'Server did not respond within 10 seconds.';
                case 'connection_refused':
                  return 'Connection refused — server may be down.';
                default:
                  return 'An unexpected error occurred.';
              }
            })()}
            extra={
              <div style={{ textAlign: 'left', maxWidth: 420, margin: '0 auto' }}>
                {testResult?.error ? (
                  <Typography.Text
                    code
                    style={{
                      display: 'block',
                      fontSize: 11,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      marginBottom: 12,
                    }}
                  >
                    {testResult.error}
                  </Typography.Text>
                ) : null}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {testResult?.errorKind === 'auth_missing' &&
                    'Set a bearer token via Edit Personality, or use Authenticate to complete OAuth.'}
                  {testResult?.errorKind === 'auth_rejected' &&
                    'The token may be expired or have insufficient permissions. Update the bearer token or re-authenticate.'}
                  {testResult?.errorKind === 'no_tools' &&
                    'The token might lack the required permissions, or this account has no tools on this server.'}
                  {testResult?.errorKind === 'timeout' &&
                    'Check that the server URL is correct and the server is reachable from this machine.'}
                  {testResult?.errorKind === 'connection_refused' &&
                    'Verify the server URL and port. The server may not be running or may be blocking connections.'}
                  {testResult?.errorKind === 'unknown' &&
                    'Check the server URL, authentication settings, and network connectivity.'}
                </Typography.Text>
              </div>
            }
            style={{ paddingBlock: 16 }}
          />
        )}
      </Modal>
      <ConnectMcpModal
        open={connectOpen}
        personalityId={personalityId}
        existingServers={servers.map((s) => s.name)}
        onClose={() => setConnectOpen(false)}
        onConnected={() => setConnectOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PersonalityDetail page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool settings — per-personality config for every tool in the toolset that
// declares a `settingsSchema` (Phase 2). Presented uniformly for both built-in
// and custom personalities; the storage target differs by type (custom →
// tools.yaml, built-in → global toolSettings slot) and is surfaced in the note.
// ---------------------------------------------------------------------------

function ToolSettingsSection({
  personalityId,
  toolset,
}: {
  personalityId: string;
  toolset: string[];
}) {
  const schemasQuery = useToolSettingsSchemas();
  const settingQuery = useToolSettingsForPersonality(personalityId);
  const saveMut = useToolSettingsSetForPersonality(personalityId);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [dirty, setDirty] = useState(false);

  const configurable = (schemasQuery.data?.tools ?? []).filter((t) => toolset.includes(t.name));

  useEffect(() => {
    if (!dirty && settingQuery.data) setValues(settingQuery.data.values);
  }, [settingQuery.data, dirty]);

  // No configurable tool in this personality's toolset — render nothing.
  if (configurable.length === 0) return null;

  const storage = settingQuery.data?.storage;

  return (
    <div style={{ marginBottom: 32 }}>
      <Typography.Title level={5} style={{ marginBottom: 4 }}>
        Tool settings
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        {storage === 'personality'
          ? "Saved to this personality's tools.yaml — travels when you export it."
          : 'Built-in personality — saved to your local config (its files are read-only).'}
      </Typography.Paragraph>
      {configurable.map((tool) => (
        <div key={tool.name} style={{ marginBottom: 20 }}>
          <Typography.Text
            strong
            style={{
              fontFamily: 'Geist Mono, monospace',
              fontSize: 13,
              display: 'block',
              marginBottom: 8,
            }}
          >
            {tool.name}
          </Typography.Text>
          <ToolSettingsForm
            schema={tool.settingsSchema}
            value={values[tool.name] ?? {}}
            onChange={(next) => {
              setValues((prev) => ({ ...prev, [tool.name]: next }));
              setDirty(true);
            }}
          />
        </div>
      ))}
      <Button
        type="primary"
        loading={saveMut.isPending}
        onClick={() => saveMut.mutate(values, { onSuccess: () => setDirty(false) })}
      >
        Save tool settings
      </Button>
    </div>
  );
}

export function PersonalityDetail() {
  const { personalityId: id = '' } = useParams<{ personalityId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editInitialTab, setEditInitialTab] = useState<EditModalTabKey>('characterSheet');
  const [duplicateOpen, setDuplicateOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['personalities', 'get', id],
    queryFn: () => rpc.personalities.get({ id }),
    enabled: id.length > 0,
  });

  // Only fetched once Duplicate is actually opened — the collision check is
  // the only reason this page needs the full roster.
  const listQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
    enabled: duplicateOpen,
  });

  const deleteMut = useMutation({
    mutationFn: () => rpc.personalities.delete({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Retired ${data?.personality.name}`, placement: 'topRight' });
      navigate('/personalities');
    },
    onError: (err) =>
      notification.error({ message: 'Retire failed', description: (err as Error).message }),
  });

  if (!id) {
    return <Result status="404" title="Personality not found" />;
  }
  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (error || !data) {
    return <Result status="error" title="Failed to load personality" />;
  }

  const { personality } = data;
  const existingIds = new Set((listQuery.data?.items ?? []).map((p) => p.id));

  function openEdit(tab: EditModalTabKey) {
    setEditInitialTab(tab);
    setEditModalOpen(true);
  }

  return (
    <div style={{ padding: 24, maxWidth: 960 }}>
      <Button
        type="link"
        onClick={() => navigate('/personalities')}
        style={{ paddingLeft: 0, marginBottom: 16 }}
      >
        &larr; Personalities
      </Button>

      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
          <PersonalityMark
            personalityId={personality.id}
            size={48}
            avatarUrl={personality.display?.avatar_url}
          />
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              {personality.name}
            </Typography.Title>
            <Typography.Text
              type="secondary"
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
            >
              {personality.id}
            </Typography.Text>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => openEdit('identity')}>Edit SOUL</Button>
            <Button onClick={() => setDuplicateOpen(true)}>Duplicate</Button>
            <Button onClick={() => openEdit('characterSheet')}>Edit personality</Button>
            {canRetirePersonality(personality) ? (
              <Button
                danger
                loading={deleteMut.isPending}
                onClick={() => {
                  const copy = retireConfirmCopy(personality.name);
                  modal.confirm({
                    title: copy.title,
                    content: copy.content,
                    okText: copy.okText,
                    okButtonProps: { danger: true },
                    onOk: () => deleteMut.mutate(),
                  });
                }}
              >
                Retire
              </Button>
            ) : null}
          </div>
        </div>

        {personality.description ? (
          <Typography.Paragraph type="secondary">{personality.description}</Typography.Paragraph>
        ) : null}

        <CharacterSheetView personality={personality} />
      </div>

      <ToolSettingsSection personalityId={id} toolset={personality.toolset ?? []} />

      {!personality.builtin && <McpSection personalityId={id} mcpPolicy={data.mcpPolicy} />}

      <TriggersSection personalityId={id} />

      <A2aPeersSection personalityId={id} />

      {editModalOpen ? (
        <EditModal
          id={id}
          initialTab={editInitialTab}
          onClose={() => {
            setEditModalOpen(false);
            qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
          }}
        />
      ) : null}

      {duplicateOpen ? (
        <DuplicateModal
          source={personality}
          existingIds={existingIds}
          onClose={() => setDuplicateOpen(false)}
          onDone={(newId) => {
            setDuplicateOpen(false);
            navigate(buildIdentityRedirectPath(newId, ''));
          }}
        />
      ) : null}
    </div>
  );
}
