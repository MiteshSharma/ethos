// Models & providers — provider chain, catalog & backends, auxiliary models,
// per-personality routing. Off `Card`, onto `SettingRow` (§4.2 rows 1, 10, 16;
// plan Phase 3).
//
// `per-personality-routing` is a read-only view with no controls — one of the
// two sections Phase 2 records as legitimately empty (`EXPECTED_EMPTY_SECTIONS`).
// It renders a `SectionHeading` and the explanatory view, nothing forced in.

import {
  Button,
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
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';
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
      <SectionHeading id="provider-chain">provider chain</SectionHeading>
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

      <AdvancedBlock>
        <SectionHeading id="catalog-and-backends">catalog & backends</SectionHeading>
        <CatalogAndBackendsFields />
      </AdvancedBlock>

      <AdvancedBlock>
        <SectionHeading id="auxiliary-models">auxiliary models</SectionHeading>
        <AuxiliaryModelsFields
          auxPreviews={{
            compression: configData?.auxCompression.apiKeyPreview ?? null,
            vision: configData?.auxVision.apiKeyPreview ?? null,
            web: configData?.auxWeb.apiKeyPreview ?? null,
          }}
        />
      </AdvancedBlock>

      <AdvancedBlock>
        <SectionHeading id="per-personality-routing">per-personality routing</SectionHeading>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Per-personality model overrides. Edit ~/.ethos/config.yaml directly to add entries — this
          surface lists the current overrides; full editing lands later.
        </Typography.Paragraph>
        <ModelRoutingView routing={configData?.modelRouting ?? {}} />
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
// Catalog & backends (advanced) — model catalog + web tool backend selection.
// ---------------------------------------------------------------------------

function CatalogAndBackendsFields() {
  return (
    <>
      <SettingRow
        label="Remote model catalog"
        formName="modelCatalog.enabled"
        help="Fetch the remote model catalog for model pickers (default on)."
      >
        <Form.Item
          name={['modelCatalog', 'enabled']}
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Switch />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Catalog URL"
        formName="modelCatalog.url"
        help="Override the catalog endpoint. Blank = built-in endpoint."
      >
        <Form.Item name={['modelCatalog', 'url']} style={{ marginBottom: 0 }}>
          <Input placeholder="https://…" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Catalog TTL (hours)"
        formName="modelCatalog.ttlHours"
        help="Cache lifetime for the fetched catalog (default 24)."
      >
        <Form.Item name={['modelCatalog', 'ttlHours']} style={{ marginBottom: 0 }}>
          <InputNumber min={0.1} style={{ width: '100%' }} />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Web search backend"
        formName="webSearchBackend"
        help="Auto picks from available keys. Saved with this page; the key each backend uses is bound in the Web-search defaults section, under Security & access, which saves on its own button."
      >
        <Form.Item name="webSearchBackend" style={{ marginBottom: 0 }}>
          <Select
            options={[
              { value: '', label: 'Auto' },
              { value: 'exa', label: 'Exa' },
              { value: 'tavily', label: 'Tavily' },
              { value: 'brave', label: 'Brave' },
            ]}
          />
        </Form.Item>
      </SettingRow>
      <SettingRow label="Web extract backend" formName="webExtractBackend">
        <Form.Item name="webExtractBackend" style={{ marginBottom: 0 }}>
          <Select
            options={[
              { value: '', label: 'Auto' },
              { value: 'htmltext', label: 'htmltext' },
            ]}
          />
        </Form.Item>
      </SettingRow>
    </>
  );
}

// ---------------------------------------------------------------------------
// Auxiliary models (advanced) — the three auxiliary model slots. API keys are
// write-only (preview shown).
// ---------------------------------------------------------------------------

function AuxModelFieldGroup({
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
      <SettingRow label="Model" formName={`${slot}.model`}>
        <Form.Item name={[slot, 'model']} style={{ marginBottom: 0 }}>
          <Input size="small" placeholder="claude-haiku-4-5-20251001" />
        </Form.Item>
      </SettingRow>
      <SettingRow label="Provider" formName={`${slot}.provider`}>
        <Form.Item name={[slot, 'provider']} style={{ marginBottom: 0 }}>
          <Input size="small" placeholder="anthropic | openrouter | ollama" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="API key"
        formName={`${slot}.apiKey`}
        help={preview ? `Current: ${preview} — sent only when you type a new key.` : undefined}
      >
        <Form.Item name={[slot, 'apiKey']} style={{ marginBottom: 0 }}>
          <Input.Password
            size="small"
            autoComplete="off"
            placeholder={preview ?? 'paste new key'}
          />
        </Form.Item>
      </SettingRow>
      <SettingRow label="Base URL" formName={`${slot}.baseUrl`}>
        <Form.Item name={[slot, 'baseUrl']} style={{ marginBottom: 0 }}>
          <Input size="small" placeholder="https://openrouter.ai/api/v1" />
        </Form.Item>
      </SettingRow>
    </div>
  );
}

function AuxiliaryModelsFields({
  auxPreviews,
}: {
  auxPreviews: { compression: string | null; vision: string | null; web: string | null };
}) {
  return (
    <>
      <AuxModelFieldGroup
        slot="auxCompression"
        label="Compression model"
        help="Summarizer used for context compaction (auxiliary.compression.*)."
        preview={auxPreviews.compression}
      />
      <AuxModelFieldGroup
        slot="auxVision"
        label="Vision model"
        help="Fallback for image inputs when the primary model lacks vision (auxiliary.vision.*)."
        preview={auxPreviews.vision}
      />
      <AuxModelFieldGroup
        slot="auxWeb"
        label="Web summarizer"
        help="Summarizer for web_extract output (auxiliary.web.*)."
        preview={auxPreviews.web}
      />
    </>
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
