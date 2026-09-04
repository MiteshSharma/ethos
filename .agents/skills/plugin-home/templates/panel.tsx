import type { PluginPanelProps } from '@ethosagent/types';
import { useCallback, useEffect, useState } from 'react';

export default function HomePanel({
  _pluginId,
  _getCredential,
  credentialPreview,
  requestOAuth,
  executeTool,
  _theme,
}: PluginPanelProps) {
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [data, setData] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    credentialPreview('__OAUTH_REF__')
      .then(setAuthStatus)
      .catch(() => {});
  }, [credentialPreview]);

  const fetchData = useCallback(
    async (toolName: string, args: Record<string, unknown> = {}) => {
      setLoading(true);
      setError(null);
      try {
        const result = await executeTool(toolName, args);
        if (result.ok) {
          setData(result.value ?? null);
        } else {
          setError(result.error ?? 'Unknown error');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to execute tool');
      } finally {
        setLoading(false);
      }
    },
    [executeTool],
  );

  const tabs = ['__TAB_1__', '__TAB_2__', '__TAB_3__'];

  return (
    <div
      style={{
        padding: 16,
        fontFamily: 'var(--font-display, system-ui)',
        color: 'var(--text-primary, #e8e8e6)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>__PLUGIN_NAME__</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 'var(--radius-full, 9999px)',
              background: authStatus ? 'rgba(74, 222, 128, 0.15)' : 'rgba(248, 113, 113, 0.15)',
              color: authStatus ? 'var(--success, #4ade80)' : 'var(--error, #f87171)',
            }}
          >
            {authStatus ? 'Connected' : 'Not connected'}
          </span>
          {!authStatus && (
            <button
              type="button"
              onClick={() => requestOAuth('__OAUTH_REF__')}
              style={{
                height: 24,
                padding: '0 10px',
                borderRadius: 'var(--radius-sm, 4px)',
                background: 'var(--info, #4a9eff)',
                color: '#ffffff',
                border: 'none',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              Connect
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--border-subtle, #2a2a2a)',
          marginBottom: 12,
        }}
      >
        {tabs.map((tab, i) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(i)}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: activeTab === i ? 500 : 400,
              color: activeTab === i ? 'var(--info, #4a9eff)' : 'var(--text-secondary, #9a9a98)',
              background: 'none',
              border: 'none',
              borderBottom:
                activeTab === i ? '2px solid var(--info, #4a9eff)' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ minHeight: 120 }}>
        {loading ? (
          <div style={{ color: 'var(--text-tertiary, #7e7e7d)', fontSize: 13 }}>Loading...</div>
        ) : error ? (
          <div style={{ color: 'var(--error, #f87171)', fontSize: 13 }}>
            {error}
            <button
              type="button"
              onClick={() => fetchData('__TOOL_NAME__')}
              style={{
                marginLeft: 8,
                background: 'none',
                border: 'none',
                color: 'var(--info, #4a9eff)',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Retry
            </button>
          </div>
        ) : data ? (
          <pre
            style={{
              margin: 0,
              fontSize: 12,
              fontFamily: 'var(--font-mono, monospace)',
              whiteSpace: 'pre-wrap',
            }}
          >
            {data}
          </pre>
        ) : (
          <div style={{ color: 'var(--text-tertiary, #7e7e7d)', fontSize: 13 }}>
            Select a tab to load data.
          </div>
        )}
      </div>
    </div>
  );
}
