import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Radio,
  Space,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { bridge } from '../lib/desktop';

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

  // Utilities
  const [exportPath, setExportPath] = useState<string | null>(null);

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
  const [pruneResult, setPruneResult] = useState<string | null>(null);

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

  async function handleExportData() {
    try {
      const result = await b.settings.exportData();
      if (result.ok && result.path) {
        setExportPath(result.path);
      } else {
        notification.error({
          message: 'Export failed',
          description: result.error ?? 'Unknown error',
        });
      }
    } catch (err) {
      notification.error({
        message: 'Export failed',
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

  async function handlePruneRetention() {
    try {
      setPruneResult(null);
      const result = await b.settings.pruneRetention({
        retentionDays,
        traceLogDays,
        observabilityDays,
      });
      if (result.ok) {
        const freed = result.freedBytes ?? 0;
        setPruneResult(`Freed ${(freed / 1024).toFixed(1)} KB`);
      } else {
        notification.error({
          message: 'Prune failed',
          description: result.error ?? 'Unknown error',
        });
      }
    } catch (err) {
      notification.error({
        message: 'Prune failed',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <>
      <Card title="Connection mode" size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
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
      </Card>

      <Card title="Launch at login" size="small" style={{ marginBottom: 16 }}>
        <Checkbox
          checked={launchAtLogin}
          onChange={(e) => handleLaunchAtLoginChange(e.target.checked)}
        >
          Start Ethos when you log in
        </Checkbox>
      </Card>

      <Card title="Data directory" size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>Current: {dataDir}</Typography.Text>
          <Button onClick={handleChangeDataDir}>Change</Button>
          {restartNeeded && (
            <Typography.Text type="warning">
              Restart required to apply the new data directory.
            </Typography.Text>
          )}
        </Space>
      </Card>

      <Card title="Utilities" size="small" style={{ marginBottom: 16 }}>
        <Space>
          <Button onClick={handleOpenConfigFolder}>Open Config Folder</Button>
          <Button onClick={handleExportData}>Export Data</Button>
        </Space>
        {exportPath && (
          <Typography.Text style={{ display: 'block', marginTop: 8 }}>
            Exported to: {exportPath}
          </Typography.Text>
        )}
      </Card>

      <Card title="Keychain API key" size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          {keychainPreview && <Typography.Text>Current: {keychainPreview}</Typography.Text>}
          <Input.Password
            placeholder="New API key"
            value={keychainValue}
            onChange={(e) => setKeychainValue(e.target.value)}
          />
          <Button onClick={handleUpdateKeychain}>Update</Button>
        </Space>
      </Card>

      <Card title="Codex Authentication" size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>
            Status: {codexAuthorized ? 'Authorized' : 'Not configured'}
          </Typography.Text>
          {codexUserCode && <Typography.Text copyable>Code: {codexUserCode}</Typography.Text>}
          {!codexAuthorized && <Button onClick={handleStartCodexAuth}>Start Auth</Button>}
        </Space>
      </Card>

      <Card title="Retention" size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
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
            <Button onClick={handlePruneRetention}>Prune now</Button>
          </Space>
          {pruneResult && <Typography.Text>{pruneResult}</Typography.Text>}
        </Space>
      </Card>
    </>
  );
}
