// Desktop — connection, storage, retention, keychain & auth. Off `Card`, onto
// `SectionHeading` (§4.2 rows D1–D7; plan Phase 4). Rendered inside the Desktop
// category's pane (`settings/panes/desktop.tsx`) only in the desktop build.
//
// The seven cards talk to Electron IPC, not `config.yaml`, so none of these
// controls is a named `Form.Item` (all `stateBacked: true` in `SETTINGS_INDEX`)
// — they stay in their current freeform shape, per the plan's "non-form widgets
// stay in their current shape; Phase 6 converts rosters/tables, not this".

import {
  App as AntApp,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Radio,
  Space,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { bridge } from '../lib/desktop';
import { ROW_BOX_STYLE } from './settings/components/primitives';
import { SectionHeading } from './settings/components/section-heading';
import { SelfSaveMarker } from './settings/components/self-save-marker';

export function DesktopSettings() {
  const { notification } = AntApp.useApp();

  // Connection mode
  const [connMode, setConnMode] = useState<'local' | 'remote'>('local');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteToken, setRemoteToken] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);

  // Launch at login
  const [launchAtLogin, setLaunchAtLogin] = useState(false);

  // Data directory
  const [dataDir, setDataDir] = useState('');
  const [restartNeeded, setRestartNeeded] = useState(false);

  // Keychain
  const [keychainPreview, setKeychainPreview] = useState<string | null>(null);
  const [keychainValue, setKeychainValue] = useState('');

  // Codex auth
  const [codexAuthorized, setCodexAuthorized] = useState(false);
  const [codexUserCode, setCodexUserCode] = useState<string | null>(null);

  // Retention
  const [retentionDays, setRetentionDays] = useState(90);
  const [traceLogDays, setTraceLogDays] = useState(30);
  const [observabilityDays, setObservabilityDays] = useState(7);

  useEffect(() => {
    if (!bridge) return;
    const b = bridge;
    async function load() {
      try {
        const conn = await b.connection.get();
        setConnMode(conn.mode);
        if (conn.url) setRemoteUrl(conn.url);

        const login = await b.loginItem.get();
        setLaunchAtLogin(login);

        const dir = await b.settings.getDataDir();
        setDataDir(dir.path);

        const preview = await b.keychain.preview({ key: 'api-key' });
        setKeychainPreview(preview.preview);

        const codexStatus = await b.codex.authStatus();
        setCodexAuthorized(codexStatus.authorized);

        const cfg = await b.settings.getConfig();
        setRetentionDays(cfg.retentionDays);
        setTraceLogDays(cfg.traceLogDays);
        setObservabilityDays(cfg.observabilityDays);
      } catch (err) {
        notification.error({
          message: 'Failed to load desktop settings',
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }
    load();
  }, [notification]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.codex.onAuthComplete(() => {
      setCodexAuthorized(true);
      setCodexUserCode(null);
    });
  }, []);

  if (!bridge) return null;
  const b = bridge;

  async function handleTestConnection() {
    try {
      setTestResult(null);
      const result = await b.connection.test({
        url: remoteUrl,
        token: remoteToken || undefined,
      });
      if (result.ok) {
        setTestResult(`Connected (${result.latencyMs ?? '?'}ms)`);
      } else {
        setTestResult(`Failed: ${result.error ?? 'unknown error'}`);
      }
    } catch (err) {
      notification.error({
        message: 'Connection test failed',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleSaveConnection() {
    try {
      const result = await b.connection.set({
        mode: connMode,
        url: remoteUrl || undefined,
        token: remoteToken || undefined,
      });
      if (result.ok) {
        notification.success({ message: 'Connection settings saved' });
      }
    } catch (err) {
      notification.error({
        message: 'Failed to save connection settings',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleLaunchAtLoginChange(enabled: boolean) {
    try {
      const result = await b.loginItem.set({ enabled });
      if (result.ok) {
        setLaunchAtLogin(enabled);
      } else {
        notification.error({
          message: 'Failed to update login item',
          description: result.error ?? 'Unknown error',
        });
      }
    } catch (err) {
      notification.error({
        message: 'Failed to update login item',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleChangeDataDir() {
    try {
      const dialog = await b.dialog.showOpenDialog({
        properties: ['openDirectory'],
      });
      if (dialog.canceled || dialog.filePaths.length === 0) return;
      const path = dialog.filePaths[0];
      const result = await b.settings.setDataDir({ path });
      if (result.ok) {
        setDataDir(path);
        setRestartNeeded(result.restartRequired);
      }
    } catch (err) {
      notification.error({
        message: 'Failed to change data directory',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleOpenConfigFolder() {
    try {
      await b.settings.openConfigFolder();
    } catch (err) {
      notification.error({
        message: 'Failed to open config folder',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleUpdateKeychain() {
    try {
      const result = await b.keychain.set({ key: 'api-key', value: keychainValue });
      if (result.ok) {
        notification.success({ message: 'API key updated in keychain' });
        setKeychainValue('');
        const preview = await b.keychain.preview({ key: 'api-key' });
        setKeychainPreview(preview.preview);
      }
    } catch (err) {
      notification.error({
        message: 'Failed to update keychain',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleStartCodexAuth() {
    try {
      const result = await b.codex.startAuth();
      if (result.ok && result.userCode) {
        setCodexUserCode(result.userCode);
      } else {
        notification.error({
          message: 'Codex auth failed',
          description: result.error ?? 'Unknown error',
        });
      }
    } catch (err) {
      notification.error({
        message: 'Codex auth failed',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleSaveRetention() {
    try {
      const result = await b.settings.updateConfig({
        retentionDays,
        traceLogDays,
        observabilityDays,
      });
      if (result.ok) {
        notification.success({ message: 'Retention settings saved' });
      } else {
        notification.error({
          message: 'Failed to save retention settings',
          description: result.error ?? 'Unknown error',
        });
      }
    } catch (err) {
      notification.error({
        message: 'Failed to save retention settings',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <>
      <SectionHeading id="connection">connection</SectionHeading>
      <SelfSaveMarker />

      <div style={ROW_BOX_STYLE}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Connection mode
        </Typography.Text>
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          <Radio.Group value={connMode} onChange={(e) => setConnMode(e.target.value)}>
            <Radio value="local">Local</Radio>
            <Radio value="remote">Remote</Radio>
          </Radio.Group>

          {connMode === 'remote' && (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input
                placeholder="Remote URL"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
              />
              <Input.Password
                placeholder="Token (optional)"
                value={remoteToken}
                onChange={(e) => setRemoteToken(e.target.value)}
              />
              <Button onClick={handleTestConnection}>Test</Button>
              {testResult && <Typography.Text>{testResult}</Typography.Text>}
            </Space>
          )}

          <Button type="primary" onClick={handleSaveConnection}>
            Save
          </Button>
        </Space>
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Launch at login</div>
        </div>
        <div className="settings-row-control">
          <Checkbox
            checked={launchAtLogin}
            onChange={(e) => handleLaunchAtLoginChange(e.target.checked)}
          >
            Start Ethos when you log in
          </Checkbox>
        </div>
      </div>

      <SectionHeading id="storage">storage</SectionHeading>
      <SelfSaveMarker />

      <div style={ROW_BOX_STYLE}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Data directory
        </Typography.Text>
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          <Typography.Text>Current: {dataDir}</Typography.Text>
          <Button onClick={handleChangeDataDir}>Change</Button>
          {restartNeeded && (
            <Typography.Text type="warning">
              Restart required to apply the new data directory.
            </Typography.Text>
          )}
        </Space>
      </div>

      <div style={ROW_BOX_STYLE}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Utilities
        </Typography.Text>
        <div style={{ marginTop: 8 }}>
          <Space>
            <Button onClick={handleOpenConfigFolder}>Open Config Folder</Button>
            <Button disabled>Export Data</Button>
          </Space>
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            Exporting your data is not implemented yet.
          </Typography.Text>
        </div>
      </div>

      <SectionHeading id="retention">retention</SectionHeading>
      <SelfSaveMarker />

      <div style={ROW_BOX_STYLE}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Desktop cache retention
        </Typography.Text>
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          <Space>
            <Typography.Text>Retention days:</Typography.Text>
            <InputNumber
              min={7}
              max={365}
              value={retentionDays}
              onChange={(v) => setRetentionDays(v ?? 90)}
            />
          </Space>
          <Space>
            <Typography.Text>Trace log days:</Typography.Text>
            <InputNumber
              min={1}
              max={90}
              value={traceLogDays}
              onChange={(v) => setTraceLogDays(v ?? 30)}
            />
          </Space>
          <Space>
            <Typography.Text>Observability days:</Typography.Text>
            <InputNumber
              min={1}
              max={30}
              value={observabilityDays}
              onChange={(v) => setObservabilityDays(v ?? 7)}
            />
          </Space>
          <Space>
            <Button type="primary" onClick={handleSaveRetention}>
              Save
            </Button>
            <Button disabled>Prune now</Button>
          </Space>
          <Typography.Text type="secondary">Pruning is not implemented yet.</Typography.Text>
        </Space>
      </div>

      <SectionHeading id="keychain-and-auth">keychain &amp; auth</SectionHeading>
      <SelfSaveMarker />

      <div style={ROW_BOX_STYLE}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Keychain API key
        </Typography.Text>
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          {keychainPreview && <Typography.Text>Current: {keychainPreview}</Typography.Text>}
          <Input.Password
            placeholder="New API key"
            value={keychainValue}
            onChange={(e) => setKeychainValue(e.target.value)}
          />
          <Button onClick={handleUpdateKeychain}>Update</Button>
        </Space>
      </div>

      <div style={ROW_BOX_STYLE}>
        <Typography.Text strong style={{ fontSize: 13 }}>
          Codex Authentication
        </Typography.Text>
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          <Typography.Text>
            Status: {codexAuthorized ? 'Authorized' : 'Not configured'}
          </Typography.Text>
          {codexUserCode && <Typography.Text copyable>Code: {codexUserCode}</Typography.Text>}
          {!codexAuthorized && <Button onClick={handleStartCodexAuth}>Start Auth</Button>}
        </Space>
      </div>
    </>
  );
}
