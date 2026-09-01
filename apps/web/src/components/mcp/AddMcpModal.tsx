import type {
  McpAddServerInput,
  McpLocalPresetInfo,
  McpRemotePresetInfo,
} from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useMcpCatalog } from '../../features/mcp/api/queries';
import { rpc } from '../../rpc';

type Step = 'preset' | 'connecting' | 'done' | 'error';

// The catalog is SERVED (`rpc.mcp.catalog`), never imported: the preset data
// lives in `@ethosagent/tools-mcp`, a Node-only package whose stdio transport
// spawns child processes. `apps/web` importing it would pull that into the
// browser bundle — plan gap G5, guarded by
// `extensions/tools-mcp/src/__tests__/browser-boundary.test.ts`.

/** Auth badge copy for a remote catalog entry. */
export function authBadgeLabel(authType: McpRemotePresetInfo['authType']): string {
  if (authType === 'oauth') return 'OAuth';
  if (authType === 'none') return 'No auth';
  return 'API key';
}

/** Bucket catalog entries by `category`, preserving the order the server sent. */
export function groupByCategory<T extends { category: string }>(
  items: readonly T[],
): { category: string; items: T[] }[] {
  const groups: { category: string; items: T[] }[] = [];
  for (const item of items) {
    const existing = groups.find((g) => g.category === item.category);
    if (existing) existing.items.push(item);
    else groups.push({ category: item.category, items: [item] });
  }
  return groups;
}

/**
 * POSIX single-quote: wrap in single quotes, and end/re-open the quote around
 * any embedded one.
 *
 * POSIX-only — this quoting (and the bare `<NAME>` placeholder below) is wrong
 * in PowerShell and cmd.exe, so the UI labels the composed line as a bash/zsh
 * command rather than generating one per platform.
 *
 * The composed line is meant to be pasted into a shell, so every value that
 * came from the user has to survive word splitting and expansion intact. An
 * ordinary path like `/home/me/My Code` would otherwise split into two shell
 * words and register the wrong thing, and a value holding `;`, a backtick or
 * `$(…)` would change what the pasted line executes.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The CLI line that actually registers a local (stdio) preset.
 *
 * `McpService.addServer()` refuses `transport: 'stdio'` on purpose —
 * registering a local command from a browser is arbitrary local execution — so
 * the Local Command tab hands the user the command rather than submitting it.
 * Syntax mirrors `ADD_USAGE` in `apps/ethos/src/commands/mcp.ts`.
 *
 * Fixed parts (`ethos mcp add`, the flags) and the preset name are left
 * unquoted: the preset name comes from the server-side catalog, not the user.
 */
export function composeLocalPresetCommand(input: {
  name: string;
  preset: string;
  /** One entry per declared `argVar`, in declaration order. */
  args: { name: string; value: string }[];
  env: Record<string, string>;
}): string {
  const parts = ['ethos', 'mcp', 'add', shellQuote(input.name), '--preset', input.preset];
  // `--arg` first: those values are required, `--env` values are not.
  for (const { name, value } of input.args) {
    const trimmed = value.trim();
    if (!trimmed) {
      // An unfilled required value renders as `<NAME>` rather than being
      // dropped. Dropping it would hand over a command that registers a server
      // which starts and then fails every call; the placeholder is both visible
      // and, as shell redirection syntax, refuses to run until it is replaced.
      //
      // Left UNQUOTED deliberately, and it is the one value here that is: bare
      // `<` is redirection syntax, so a half-filled command pasted into a
      // terminal fails loudly. Quoting it would make that command run and
      // register a server whose allowed path is the literal `<NAME>` — a
      // silent breakage discovered one tool call later instead of now. The
      // warning line under the command already says to replace it.
      parts.push('--arg', `${name}=<${name}>`);
      continue;
    }
    // `KEY=value` is quoted as ONE token so the shell strips the quotes and
    // `ethos` receives the whole pair as a single argv entry.
    parts.push('--arg', shellQuote(`${name}=${trimmed}`));
  }
  for (const [key, value] of Object.entries(input.env)) {
    const trimmed = value.trim();
    if (trimmed) parts.push('--env', shellQuote(`${key}=${trimmed}`));
  }
  return parts.join(' ');
}

/** What a remote catalog entry submits, decided by its `authType`. */
export function buildRemoteSubmission(
  preset: McpRemotePresetInfo,
  token: string,
):
  | { kind: 'oauth'; input: { url: string } }
  | { kind: 'addServer'; input: Extract<McpAddServerInput, { transport: 'streamable-http' }> } {
  if (preset.authType === 'oauth') {
    return { kind: 'oauth', input: { url: preset.url } };
  }
  if (preset.authType === 'none') {
    return {
      kind: 'addServer',
      input: {
        name: preset.name,
        url: preset.url,
        transport: 'streamable-http',
        authType: 'none',
      },
    };
  }
  const trimmed = token.trim();
  return {
    kind: 'addServer',
    input: {
      name: preset.name,
      url: preset.url,
      transport: 'streamable-http',
      authType: 'bearer',
      ...(trimmed ? { token: trimmed } : {}),
    },
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AddMcpModal({ open, onClose }: Props) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('preset');
  const [preset, setPreset] = useState<string | undefined>();
  const [serverName, setServerName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [mode, setMode] = useState<'preset' | 'custom' | 'stdio'>('preset');
  const [customUrl, setCustomUrl] = useState('');
  const [customName, setCustomName] = useState('');
  const [serverType, setServerType] = useState<'oauth' | 'direct'>('oauth');
  const [bearerToken, setBearerToken] = useState('');
  const [stdioCommand, setStdioCommand] = useState('');
  const [stdioArgs, setStdioArgs] = useState('');
  const [stdioName, setStdioName] = useState('');
  const [localPreset, setLocalPreset] = useState<string | undefined>();
  const [localPresetEnv, setLocalPresetEnv] = useState<Record<string, string>>({});
  const [localPresetArgs, setLocalPresetArgs] = useState<Record<string, string>>({});
  const [resultLimit, setResultLimit] = useState<number | null>(null);

  const catalog = useMcpCatalog(open);
  const remotePresets: McpRemotePresetInfo[] = catalog.data?.remote ?? [];
  const localPresets: McpLocalPresetInfo[] = catalog.data?.local ?? [];
  const selectedRemote = remotePresets.find((p) => p.name === preset);
  const selectedLocal = localPresets.find((p) => p.name === localPreset);

  // Start mutation — calls mcp.start to trigger discovery + definition write.
  // The placeholder written by mcp.start() persists in mcp.json as a valid
  // registration; auth happens later via the ConnectMcpModal OAuth flow.
  const startMutation = useMutation({
    mutationFn: (input: { url: string; name?: string }) => rpc.mcp.start(input),
    onSuccess: (result) => {
      if (!result.ok) {
        setStep('error');
        setErrorMsg(('detail' in result ? result.detail : result.code) ?? 'Discovery failed');
        return;
      }
      setServerName(result.serverName);
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
      queryClient.invalidateQueries({ queryKey: ['mcp', 'list'] });
      setStep('done');
    },
    onError: (err) => {
      setStep('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    },
  });

  const addServerMutation = useMutation({
    mutationFn: (input: McpAddServerInput) => rpc.mcp.addServer(input),
    onSuccess: (result) => {
      if (!result.ok) {
        setStep('error');
        setErrorMsg(('detail' in result ? result.detail : result.code) ?? 'Failed to add server');
        return;
      }
      setServerName(result.serverName);
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
      queryClient.invalidateQueries({ queryKey: ['mcp', 'list'] });
      setStep('done');
    },
    onError: (err) => {
      setStep('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    },
  });

  // Reset state when modal opens
  const handleOpen = () => {
    setStep('preset');
    setPreset(undefined);
    setServerName('');
    setErrorMsg('');
    setMode('preset');
    setCustomUrl('');
    setCustomName('');
    setServerType('oauth');
    setBearerToken('');
    setStdioCommand('');
    setStdioArgs('');
    setStdioName('');
    setLocalPreset(undefined);
    setLocalPresetEnv({});
    setLocalPresetArgs({});
    setResultLimit(null);
  };

  const handleClose = () => {
    onClose();
  };

  // Picking a local preset fills Command and Args with its command shape for
  // display and opens one input per declared arg/env var. Those two fields are
  // DISABLED while a preset is selected: the CLI line below is composed from
  // the preset name plus the server-name, arg and env fields, so edits to
  // Command or Args would change nothing. Clearing the preset re-enables them,
  // leaving the preset's values behind as a starting point for manual entry.
  const handleLocalPresetChange = (name: string | undefined) => {
    setLocalPreset(name);
    const chosen = localPresets.find((p) => p.name === name);
    if (!chosen) {
      setLocalPresetEnv({});
      setLocalPresetArgs({});
      return;
    }
    setStdioCommand(chosen.command);
    setStdioArgs(chosen.args.join(', '));
    setStdioName(chosen.name);
    setLocalPresetEnv(Object.fromEntries(chosen.envVars.map((v) => [v, ''])));
    setLocalPresetArgs(Object.fromEntries(chosen.argVars.map((v) => [v, ''])));
  };

  const localPresetCommand = selectedLocal
    ? composeLocalPresetCommand({
        name: stdioName.trim() || selectedLocal.name,
        preset: selectedLocal.name,
        args: selectedLocal.argVars.map((v) => ({ name: v, value: localPresetArgs[v] ?? '' })),
        env: localPresetEnv,
      })
    : '';

  // Named so the copy under the command can say which ones still need a value.
  const unfilledArgVars = (selectedLocal?.argVars ?? []).filter(
    (v) => !(localPresetArgs[v] ?? '').trim(),
  );

  const handleConnect = async () => {
    setErrorMsg('');

    // Issue 10: client-side validation before submit
    if (mode === 'custom' || mode === 'stdio') {
      try {
        const validation = await rpc.mcp.validateConfig({
          transport: mode === 'stdio' ? 'stdio' : 'streamable-http',
          ...(mode === 'custom' ? { url: customUrl.trim() } : {}),
          ...(mode === 'stdio' ? { command: stdioCommand.trim() } : {}),
          name: mode === 'stdio' ? stdioName.trim() : customName.trim(),
        });
        if (!validation.valid) {
          setErrorMsg(validation.errors.map((e) => `${e.field}: ${e.message}`).join(', '));
          return;
        }
      } catch {
        // Validation endpoint unavailable — proceed anyway
      }
    }

    if (mode === 'preset') {
      if (!selectedRemote) {
        setErrorMsg('Select a catalog entry first.');
        return;
      }
      setStep('connecting');
      const submission = buildRemoteSubmission(selectedRemote, bearerToken);
      if (submission.kind === 'oauth') startMutation.mutate(submission.input);
      else addServerMutation.mutate(submission.input);
      return;
    }

    setStep('connecting');
    if (mode === 'stdio') {
      addServerMutation.mutate({
        name: stdioName.trim(),
        transport: 'stdio',
        command: stdioCommand.trim(),
        ...(stdioArgs.trim()
          ? {
              args: stdioArgs
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean),
            }
          : {}),
        ...(resultLimit ? { mcpResultLimitChars: resultLimit } : {}),
      });
    } else if (serverType === 'oauth') {
      startMutation.mutate({
        url: customUrl.trim(),
        ...(customName.trim() ? { name: customName.trim() } : {}),
      });
    } else {
      addServerMutation.mutate({
        url: customUrl.trim(),
        name: customName.trim(),
        transport: 'streamable-http',
        authType: 'bearer',
        ...(bearerToken.trim() ? { token: bearerToken.trim() } : {}),
        ...(resultLimit ? { mcpResultLimitChars: resultLimit } : {}),
      });
    }
  };

  const isConnectDisabled =
    mode === 'preset'
      ? !preset
      : mode === 'stdio'
        ? // A catalog preset registers from the CLI, not here — the API refuses
          // stdio adds. Manual entry keeps its Register button.
          Boolean(localPreset) || !stdioCommand.trim() || !stdioName.trim()
        : serverType === 'direct'
          ? !customUrl.trim() || !customName.trim()
          : !customUrl.trim();

  const currentStepIndex =
    step === 'preset' ? 0 : step === 'connecting' ? 1 : step === 'done' ? 2 : 1;

  const connectingMessage =
    mode === 'stdio'
      ? 'Adding local server…'
      : mode === 'preset'
        ? selectedRemote?.authType === 'oauth'
          ? 'Discovering OAuth metadata…'
          : 'Adding server…'
        : serverType === 'direct'
          ? 'Adding server…'
          : 'Discovering OAuth metadata…';

  return (
    <Modal
      open={open}
      title="Add MCP Server"
      onCancel={handleClose}
      footer={null}
      width={480}
      destroyOnClose
      afterOpenChange={(visible) => {
        if (visible) handleOpen();
      }}
    >
      <Steps
        current={currentStepIndex}
        size="small"
        style={{ marginBottom: 24 }}
        items={[{ title: 'Select' }, { title: 'Register' }, { title: 'Done' }]}
      />

      {step === 'preset' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Typography.Text>How would you like to add a server?</Typography.Text>
          <Radio.Group
            value={mode}
            onChange={(e) => setMode(e.target.value as 'preset' | 'custom' | 'stdio')}
            optionType="button"
            buttonStyle="solid"
            style={{ width: '100%', display: 'flex' }}
          >
            <Radio.Button value="preset" style={{ flex: 1, textAlign: 'center' }}>
              Preset
            </Radio.Button>
            <Radio.Button value="custom" style={{ flex: 1, textAlign: 'center' }}>
              Remote URL
            </Radio.Button>
            <Radio.Button value="stdio" style={{ flex: 1, textAlign: 'center' }}>
              Local Command
            </Radio.Button>
          </Radio.Group>

          {errorMsg && step === 'preset' ? (
            <Alert
              type="error"
              message={errorMsg}
              closable
              onClose={() => setErrorMsg('')}
              style={{ marginBottom: 0 }}
            />
          ) : null}

          {mode === 'preset' ? (
            <Space direction="vertical" style={{ width: '100%' }}>
              {catalog.isError ? (
                <Alert
                  type="error"
                  message="Catalog unavailable — add the server by URL instead."
                />
              ) : (
                <Select
                  placeholder="Select a preset"
                  value={preset}
                  onChange={setPreset}
                  loading={catalog.isLoading}
                  notFoundContent={catalog.isLoading ? 'Loading catalog…' : 'No catalog entries'}
                  listHeight={320}
                  listItemHeight={48}
                  options={groupByCategory(remotePresets).map((group) => ({
                    label: group.category,
                    options: group.items.map((p) => ({ value: p.name, label: p.label })),
                  }))}
                  optionRender={(option) => {
                    const entry = remotePresets.find((p) => p.name === option.value);
                    if (!entry) return option.label;
                    return (
                      <div>
                        <Space size={8}>
                          <Typography.Text>{entry.label}</Typography.Text>
                          <Tag style={{ marginInlineEnd: 0 }}>{authBadgeLabel(entry.authType)}</Tag>
                        </Space>
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12, display: 'block' }}
                        >
                          {entry.description}
                        </Typography.Text>
                      </div>
                    );
                  }}
                  style={{ width: '100%' }}
                />
              )}
              {selectedRemote ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {selectedRemote.url}
                </Typography.Text>
              ) : null}
              {selectedRemote?.authType === 'bearer' ? (
                <Input.Password
                  placeholder="API key (optional)"
                  value={bearerToken}
                  onChange={(e) => setBearerToken(e.target.value)}
                  allowClear
                />
              ) : null}
              {selectedRemote?.authType === 'none' ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  No credentials needed. Register adds the server straight away.
                </Typography.Text>
              ) : null}
              {selectedRemote?.authType === 'bearer' ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Paste the key now or set it later on the personality page.
                </Typography.Text>
              ) : null}
            </Space>
          ) : mode === 'stdio' ? (
            <Space direction="vertical" style={{ width: '100%' }}>
              {catalog.isError ? (
                <Alert type="error" message="Catalog unavailable — fill the command in by hand." />
              ) : (
                <Select
                  placeholder="Select a local preset (optional)"
                  value={localPreset}
                  onChange={handleLocalPresetChange}
                  loading={catalog.isLoading}
                  allowClear
                  notFoundContent={catalog.isLoading ? 'Loading catalog…' : 'No catalog entries'}
                  listHeight={320}
                  listItemHeight={48}
                  options={groupByCategory(localPresets).map((group) => ({
                    label: group.category,
                    options: group.items.map((p) => ({ value: p.name, label: p.name })),
                  }))}
                  optionRender={(option) => {
                    const entry = localPresets.find((p) => p.name === option.value);
                    if (!entry) return option.label;
                    return (
                      <div>
                        <Typography.Text>{entry.name}</Typography.Text>
                        <Typography.Text
                          type="secondary"
                          style={{ fontSize: 12, display: 'block' }}
                        >
                          {entry.description}
                        </Typography.Text>
                      </div>
                    );
                  }}
                  style={{ width: '100%' }}
                />
              )}
              <Input
                placeholder="Command (e.g. npx, python)"
                value={stdioCommand}
                onChange={(e) => setStdioCommand(e.target.value)}
                disabled={Boolean(localPreset)}
                allowClear
              />
              <Input
                placeholder="Args (comma-separated, optional)"
                value={stdioArgs}
                onChange={(e) => setStdioArgs(e.target.value)}
                disabled={Boolean(localPreset)}
                allowClear
              />
              <Input
                placeholder="Server name (required)"
                value={stdioName}
                onChange={(e) => setStdioName(e.target.value)}
                allowClear
              />
              {selectedLocal?.argVars.map((argVar) => (
                <Input
                  key={argVar}
                  value={localPresetArgs[argVar] ?? ''}
                  placeholder="required"
                  onChange={(e) =>
                    setLocalPresetArgs((prev) => ({ ...prev, [argVar]: e.target.value }))
                  }
                  allowClear
                  addonBefore={
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {argVar}
                    </Typography.Text>
                  }
                />
              ))}
              {selectedLocal?.envVars.map((envVar) => (
                <Input
                  key={envVar}
                  value={localPresetEnv[envVar] ?? ''}
                  placeholder="optional"
                  onChange={(e) =>
                    setLocalPresetEnv((prev) => ({ ...prev, [envVar]: e.target.value }))
                  }
                  allowClear
                  addonBefore={
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {envVar}
                    </Typography.Text>
                  }
                />
              ))}
              {selectedLocal ? (
                <div>
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 12, display: 'block', marginBottom: 6 }}
                  >
                    Local servers run commands on this machine, so they are registered from the CLI,
                    not the browser. Run this in a POSIX shell (bash/zsh):
                  </Typography.Text>
                  <Typography.Text code copyable>
                    {localPresetCommand}
                  </Typography.Text>
                  {unfilledArgVars.length > 0 ? (
                    <Typography.Text type="warning" style={{ fontSize: 12, display: 'block' }}>
                      Replace {unfilledArgVars.join(', ')} above — the server reads it from its
                      command line and refuses every call without it.
                    </Typography.Text>
                  ) : null}
                </div>
              ) : null}
              <InputNumber
                placeholder="50000"
                value={resultLimit}
                onChange={(v) => setResultLimit(v)}
                min={1}
                style={{ width: '100%' }}
                addonBefore={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Result size limit (chars)
                  </Typography.Text>
                }
              />
            </Space>
          ) : (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input
                placeholder="https://mcp.example.com/mcp"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                allowClear
              />
              <Input
                placeholder="Server name (e.g. my-server)"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                allowClear
              />
              <div>
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 12, display: 'block', marginBottom: 6 }}
                >
                  Authentication
                </Typography.Text>
                <Radio.Group
                  value={serverType}
                  onChange={(e) => setServerType(e.target.value as 'oauth' | 'direct')}
                  style={{ width: '100%' }}
                >
                  <Space direction="vertical" style={{ width: '100%' }}>
                    <Radio value="oauth">OAuth 2.0 (server handles login flow)</Radio>
                    <Radio value="direct">Plain HTTP / Bearer token</Radio>
                  </Space>
                </Radio.Group>
              </div>
              {serverType === 'direct' && (
                <Input.Password
                  placeholder="Bearer token (optional)"
                  value={bearerToken}
                  onChange={(e) => setBearerToken(e.target.value)}
                  allowClear
                />
              )}
              <InputNumber
                placeholder="50000"
                value={resultLimit}
                onChange={(v) => setResultLimit(v)}
                min={1}
                style={{ width: '100%' }}
                addonBefore={
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Result size limit (chars)
                  </Typography.Text>
                }
              />
              {serverType === 'oauth' && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  The server must support OAuth 2.0 discovery. You'll be redirected to authorize.
                </Typography.Text>
              )}
              {serverType === 'direct' && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Connects directly without OAuth. Paste the token now or set it later on the
                  personality page.
                </Typography.Text>
              )}
            </Space>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={handleClose}>Cancel</Button>
            <Button type="primary" disabled={isConnectDisabled} onClick={handleConnect}>
              Register
            </Button>
          </div>
        </Space>
      )}

      {step === 'connecting' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin size="large" />
          <Typography.Paragraph style={{ marginTop: 16 }}>{connectingMessage}</Typography.Paragraph>
        </div>
      )}

      {step === 'done' && (
        <Space direction="vertical" style={{ width: '100%', textAlign: 'center' }} size="middle">
          <Alert
            type="success"
            message={`${serverName} registered`}
            description="Server definition saved. Attach it to a personality and run login to authenticate."
          />
          <Button type="primary" onClick={handleClose}>
            Close
          </Button>
        </Space>
      )}

      {step === 'error' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Alert type="error" message="Registration Failed" description={errorMsg} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={handleClose}>Close</Button>
            <Button onClick={() => setStep('preset')}>Retry</Button>
          </div>
        </Space>
      )}
    </Modal>
  );
}
