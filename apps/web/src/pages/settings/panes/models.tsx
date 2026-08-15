// Models & providers — provider chain, catalog & backends, auxiliary models,
// per-personality routing. Cards moved verbatim from `Settings.tsx`
// (§4.2 rows 1, 10, 16).

import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { rpc } from '../../../rpc';
import { AdvancedBlock } from '../components/advanced';
import { ROW_BOX_STYLE } from '../components/primitives';
import type { ProviderRow } from '../lib/rows';
import { useSettingsPane } from '../pane-context';

export function ModelsPane() {
  const {
    config: configData,
    providerRows,
    addProviderRow,
    updateProviderRow,
    moveProviderRow,
    removeProviderRow,
  } = useSettingsPane();
  const addRow = addProviderRow;
  const updateRow = updateProviderRow;
  const moveRow = moveProviderRow;
  const removeRow = removeProviderRow;

  return (
    <>
      <Card title="Provider chain" size="small" style={{ marginBottom: 16 }}>
        {providerRows.map((row, idx) => {
          const label = idx === 0 ? 'Primary' : `Fallback ${idx}`;
          return (
            <div
              key={row._id}
              style={{
                border: '1px solid var(--ethos-border, #d9d9d9)',
                borderRadius: 6,
                padding: 12,
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                <Typography.Text strong style={{ fontSize: 13 }}>
                  {label}
                </Typography.Text>
                <Space size={4}>
                  {idx > 0 && (
                    <Tooltip title="Move up">
                      <Button size="small" onClick={() => moveRow(idx, -1)}>
                        Up
                      </Button>
                    </Tooltip>
                  )}
                  {idx < providerRows.length - 1 && (
                    <Tooltip title="Move down">
                      <Button size="small" onClick={() => moveRow(idx, 1)}>
                        Down
                      </Button>
                    </Tooltip>
                  )}
                  {idx > 0 && (
                    <Tooltip title="Remove this fallback">
                      <Button size="small" danger onClick={() => removeRow(idx)}>
                        Remove
                      </Button>
                    </Tooltip>
                  )}
                </Space>
              </div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Provider
                  </Typography.Text>
                  <Input
                    size="small"
                    placeholder="anthropic | openrouter | openai-compat | ollama"
                    value={row.provider}
                    onChange={(e) => updateRow(idx, { provider: e.target.value })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Model
                  </Typography.Text>
                  <Input
                    size="small"
                    placeholder="e.g. claude-opus-4-7"
                    value={row.model}
                    onChange={(e) => updateRow(idx, { model: e.target.value })}
                  />
                </div>
              </div>

              <div style={{ marginBottom: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  API key
                </Typography.Text>
                <Input.Password
                  size="small"
                  autoComplete="off"
                  placeholder={row.apiKeyPreview || 'paste new key'}
                  value={row.apiKey}
                  onChange={(e) => updateRow(idx, { apiKey: e.target.value, testStatus: 'idle' })}
                />
                {row.apiKeyPreview && !row.apiKey && (
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    Active: {row.apiKeyPreview}
                  </Typography.Text>
                )}
              </div>

              <AdvancedBlock>
                <div style={{ marginBottom: 8 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Base URL
                  </Typography.Text>
                  <Input
                    size="small"
                    placeholder="https://openrouter.ai/api/v1"
                    value={row.baseUrl}
                    onChange={(e) => updateRow(idx, { baseUrl: e.target.value })}
                  />
                </div>
              </AdvancedBlock>

              <RowTestButton
                row={row}
                onStatusChange={(status, error) =>
                  updateRow(idx, { testStatus: status, testError: error })
                }
              />
            </div>
          );
        })}
        <Button type="dashed" size="small" onClick={addRow} style={{ width: '100%' }}>
          Add fallback
        </Button>
      </Card>

      <AdvancedBlock>
        <ModelsBackendsCard
          auxPreviews={{
            compression: configData?.auxCompression.apiKeyPreview ?? null,
            vision: configData?.auxVision.apiKeyPreview ?? null,
            web: configData?.auxWeb.apiKeyPreview ?? null,
          }}
        />
      </AdvancedBlock>

      <AdvancedBlock>
        <Card title="Model routing" size="small" style={{ marginBottom: 16 }}>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            Per-personality model overrides. Edit ~/.ethos/config.yaml directly to add entries —
            this surface lists the current overrides; full editing lands later.
          </Typography.Paragraph>
          <ModelRoutingView routing={configData?.modelRouting ?? {}} />
        </Card>
      </AdvancedBlock>
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline test button for a single provider row
// ---------------------------------------------------------------------------

function RowTestButton({
  row,
  onStatusChange,
}: {
  row: ProviderRow;
  onStatusChange: (status: ProviderRow['testStatus'], error?: string) => void;
}) {
  const handleTest = async () => {
    if (!row.provider || !row.apiKey) return;
    onStatusChange('testing');
    try {
      const result = await rpc.onboarding.validateProvider({
        provider: row.provider as
          | 'anthropic'
          | 'openai'
          | 'openrouter'
          | 'openai-compat'
          | 'ollama'
          | 'azure',
        apiKey: row.apiKey,
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      });
      if (result.ok) {
        onStatusChange('success');
      } else {
        onStatusChange('error', result.error ?? 'Validation failed');
      }
    } catch (err) {
      onStatusChange('error', (err as Error).message);
    }
  };

  const hasKey = row.apiKey.length > 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Tooltip
        title={hasKey ? 'Test connection with the new API key' : 'Enter a new API key to test'}
      >
        <Button
          size="small"
          onClick={handleTest}
          loading={row.testStatus === 'testing'}
          disabled={!hasKey}
        >
          Test
        </Button>
      </Tooltip>
      {row.testStatus === 'success' && <Tag color="success">Connected</Tag>}
      {row.testStatus === 'error' && <Tag color="error">{row.testError ?? 'Failed'}</Tag>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models & backends (advanced) — model catalog, web tool backends, and the
// three auxiliary model slots. Aux API keys are write-only (preview shown).
// ---------------------------------------------------------------------------

function AuxModelFields({
  slot,
  label,
  help,
  preview,
}: {
  slot: 'auxCompression' | 'auxVision' | 'auxWeb';
  label: string;
  help: string;
  preview: string | null;
}) {
  return (
    <div style={ROW_BOX_STYLE}>
      <Typography.Text strong style={{ fontSize: 13 }}>
        {label}
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
        {help} Blank fields fall back to the primary provider.
      </Typography.Paragraph>
      <Form.Item label="Model" name={[slot, 'model']} style={{ marginBottom: 8 }}>
        <Input size="small" placeholder="claude-haiku-4-5-20251001" />
      </Form.Item>
      <Form.Item label="Provider" name={[slot, 'provider']} style={{ marginBottom: 8 }}>
        <Input size="small" placeholder="anthropic | openrouter | ollama" />
      </Form.Item>
      <Form.Item
        label="API key"
        name={[slot, 'apiKey']}
        style={{ marginBottom: 8 }}
        extra={preview ? `Current: ${preview} — sent only when you type a new key.` : undefined}
      >
        <Input.Password size="small" autoComplete="off" placeholder={preview ?? 'paste new key'} />
      </Form.Item>
      <Form.Item label="Base URL" name={[slot, 'baseUrl']} style={{ marginBottom: 0 }}>
        <Input size="small" placeholder="https://openrouter.ai/api/v1" />
      </Form.Item>
    </div>
  );
}

function ModelsBackendsCard({
  auxPreviews,
}: {
  auxPreviews: { compression: string | null; vision: string | null; web: string | null };
}) {
  return (
    <Card title="Models & backends" size="small" style={{ marginBottom: 16 }}>
      <Form.Item
        label="Remote model catalog"
        name={['modelCatalog', 'enabled']}
        valuePropName="checked"
        extra="Fetch the remote model catalog for model pickers (modelCatalog.enabled, default on)."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Catalog URL"
        name={['modelCatalog', 'url']}
        extra="Override the catalog endpoint (modelCatalog.url). Blank = built-in endpoint."
      >
        <Input placeholder="https://…" />
      </Form.Item>
      <Form.Item
        label="Catalog TTL (hours)"
        name={['modelCatalog', 'ttlHours']}
        extra="Cache lifetime for the fetched catalog (modelCatalog.ttlHours, default 24)."
      >
        <InputNumber min={0.1} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Web search backend"
        name="webSearchBackend"
        extra="Force the web_search tool's backend (web.search_backend). Auto picks from available keys. Saved with this page; the key each backend uses is bound in the Web-search defaults card, which saves on its own button."
      >
        <Select
          options={[
            { value: '', label: 'Auto' },
            { value: 'exa', label: 'Exa' },
            { value: 'tavily', label: 'Tavily' },
            { value: 'brave', label: 'Brave' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Web extract backend"
        name="webExtractBackend"
        extra="Force the web_extract tool's backend (web.extract_backend)."
      >
        <Select
          options={[
            { value: '', label: 'Auto' },
            { value: 'htmltext', label: 'htmltext' },
          ]}
        />
      </Form.Item>
      <AuxModelFields
        slot="auxCompression"
        label="Compression model"
        help="Summarizer used for context compaction (auxiliary.compression.*)."
        preview={auxPreviews.compression}
      />
      <AuxModelFields
        slot="auxVision"
        label="Vision model"
        help="Fallback for image inputs when the primary model lacks vision (auxiliary.vision.*)."
        preview={auxPreviews.vision}
      />
      <AuxModelFields
        slot="auxWeb"
        label="Web summarizer"
        help="Summarizer for web_extract output (auxiliary.web.*)."
        preview={auxPreviews.web}
      />
    </Card>
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
