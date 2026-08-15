// Memory — store, approval, consolidation, capture. All four sections come out
// of the one Memory card, moved verbatim from `Settings.tsx` (§4.2 row 4).
//
// `memoryApproval.mode` here is MEMORY approval — whether the agent asks before
// it writes to memory. Tool approval (`approvalMode`) is a rail away, in
// Security & access, and the two never merge.

import { Card, Form, Input, InputNumber, Radio, Select, Switch } from 'antd';
import { AdvancedBlock } from '../components/advanced';
import { useSettingsPane } from '../pane-context';

export function MemoryPane() {
  const { config: configData } = useSettingsPane();

  return (
    <Card title="Memory" size="small" style={{ marginBottom: 16 }}>
      <Form.Item
        label="Memory mode"
        name="memory"
        extra="Markdown is human-editable in ~/.ethos/MEMORY.md. Vector uses local embeddings. Vault targets an external directory (memoryVault.path)."
      >
        <Radio.Group>
          <Radio.Button value="markdown">Markdown</Radio.Button>
          <Radio.Button value="vector">Vector</Radio.Button>
          <Radio.Button value="vault">Vault</Radio.Button>
        </Radio.Group>
      </Form.Item>

      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.memory !== cur.memory}>
        {({ getFieldValue }) =>
          getFieldValue('memory') === 'vault' ? (
            <>
              <Form.Item
                label="Vault path"
                name={['memoryVault', 'path']}
                rules={[{ required: true, message: 'Vault path is required for vault memory' }]}
                extra="Absolute path of the vault directory the agent reads and writes (memoryVault.path)."
              >
                <Input placeholder="/Users/you/Documents/MyVault" />
              </Form.Item>
              <Form.Item
                label="Agent directory"
                name={['memoryVault', 'agentDir']}
                extra="Subtree inside the vault the agent owns (memoryVault.agentDir). Blank = Ethos."
              >
                <Input placeholder="Ethos" />
              </Form.Item>
              <Form.Item
                label="Prefetch notes"
                name={['memoryVault', 'prefetch']}
                extra="Note names loaded into every prompt (memoryVault.prefetch). Press Enter after each name."
              >
                <Select
                  mode="tags"
                  open={false}
                  suffixIcon={null}
                  tokenSeparators={[',']}
                  placeholder="MEMORY, USER"
                />
              </Form.Item>
              <Form.Item
                label="Excluded notes"
                name={['memoryVault', 'exclude']}
                extra="Note names hidden from list and search (memoryVault.exclude)."
              >
                <Select
                  mode="tags"
                  open={false}
                  suffixIcon={null}
                  tokenSeparators={[',']}
                  placeholder="Private, Journal"
                />
              </Form.Item>
            </>
          ) : null
        }
      </Form.Item>

      <Form.Item
        label="Memory approval"
        name={['memoryApproval', 'mode']}
        extra="Approve-before-store gate for new memories (memoryApproval.mode)."
      >
        <Radio.Group>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Radio value="off">
              <span style={{ fontWeight: 500 }}>Off</span>
              <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                Memories are stored immediately.
              </span>
            </Radio>
            <Radio value="automated">
              <span style={{ fontWeight: 500 }}>Automated</span>
              <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                Agent-initiated writes wait for your review; explicit asks store directly.
              </span>
            </Radio>
            <Radio value="all">
              <span style={{ fontWeight: 500 }}>All</span>
              <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--ethos-text-dim)' }}>
                Every memory write waits for your review.
              </span>
            </Radio>
          </div>
        </Radio.Group>
      </Form.Item>

      <AdvancedBlock>
        <Form.Item
          label="Pending queue cap"
          name={['memoryApproval', 'cap']}
          extra="Max pending candidates per scope (memoryApproval.cap, default 200)."
        >
          <InputNumber min={1} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label="Pending TTL (days)"
          name={['memoryApproval', 'ttlDays']}
          extra="Days before an unreviewed candidate expires (memoryApproval.ttlDays, default 30)."
        >
          <InputNumber min={1} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </AdvancedBlock>

      <Form.Item
        label="Consolidate memory between turns"
        name="memoryConsolidationEnabled"
        valuePropName="checked"
        extra="Silently distill durable facts into memory before long sessions compact (default off)."
      >
        <Switch />
      </Form.Item>

      <AdvancedBlock>
        <Form.Item
          label="Flush threshold"
          name={['memoryConsolidation', 'flushThreshold']}
          extra="Context-window fraction that triggers the silent flush (memoryConsolidation.flushThreshold, default 0.7)."
        >
          <InputNumber min={0.01} max={1} step={0.05} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label="Flush timebox (ms)"
          name={['memoryConsolidation', 'timeboxMs']}
          extra="Max time the flush turn may run (memoryConsolidation.timeboxMs, default 30000)."
        >
          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label="Flush token cap"
          name={['memoryConsolidation', 'maxTokens']}
          extra="Token budget for the flush turn (memoryConsolidation.maxTokens, default 1024)."
        >
          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label="Max characters per flush"
          name={['memoryConsolidation', 'maxDeltaChars']}
          extra="Most characters one flush may write (memoryConsolidation.maxDeltaChars, default 4000)."
        >
          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label="Messages between flushes"
          name={['memoryConsolidation', 'minMessagesSinceFlush']}
          extra="Minimum messages before another flush may run (memoryConsolidation.minMessagesSinceFlush, default 8)."
        >
          <InputNumber min={0} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label="Decay half-life (days)"
          name={['memoryConsolidation', 'halfLifeDays']}
          extra="Recency half-life for memory decay (memoryConsolidation.halfLifeDays, default 30)."
        >
          <InputNumber min={0.1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label="Decay archive threshold"
          name={['memoryConsolidation', 'threshold']}
          extra="Entries weighted below this get archived (memoryConsolidation.threshold, default 0.05)."
        >
          <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label="Exempt USER.md from decay"
          name={['memoryConsolidation', 'exemptUser']}
          valuePropName="checked"
          extra="Keep the persistent user profile out of decay (memoryConsolidation.exemptUser, default on)."
        >
          <Switch />
        </Form.Item>
      </AdvancedBlock>

      <Form.Item
        label="Capture facts proactively"
        name="memoryCaptureEnabled"
        valuePropName="checked"
        extra="Notice durable facts mid-conversation and record them without being asked (default off)."
      >
        <Switch />
      </Form.Item>

      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.memoryCaptureEnabled !== cur.memoryCaptureEnabled}
      >
        {({ getFieldValue }) =>
          getFieldValue('memoryCaptureEnabled') ? (
            <>
              <Form.Item
                label="Capture model"
                name="memoryCaptureModel"
                extra="Cheap model that extracts the fact. Leave blank to reuse the cheapest configured model."
              >
                <Input placeholder="claude-haiku-4-5-20251001" />
              </Form.Item>
              <Form.Item
                label="Captures per hour"
                name={['memoryCapture', 'maxPerHour']}
                extra="Hourly capture cap per memory scope (memoryCapture.maxPerHour, default 6)."
              >
                <InputNumber min={1} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Captures per day"
                name={['memoryCapture', 'maxPerDay']}
                extra="Daily capture cap per memory scope (memoryCapture.maxPerDay, default 30)."
              >
                <InputNumber min={1} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <AdvancedBlock>
                <Form.Item
                  label="Capture provider"
                  name={['memoryCapture', 'provider']}
                  extra="Auxiliary provider for capture extraction (memoryCapture.provider). Blank = primary provider."
                >
                  <Input placeholder="openrouter" />
                </Form.Item>
                <Form.Item
                  label="Capture API key"
                  name={['memoryCapture', 'apiKey']}
                  extra={
                    configData?.memoryCapture.apiKeyPreview
                      ? `Current: ${configData.memoryCapture.apiKeyPreview} — sent only when you type a new key (memoryCapture.apiKey).`
                      : 'Sent only when you type a key (memoryCapture.apiKey). Blank = primary key.'
                  }
                >
                  <Input.Password
                    autoComplete="off"
                    placeholder={configData?.memoryCapture.apiKeyPreview ?? 'paste new key'}
                  />
                </Form.Item>
                <Form.Item
                  label="Capture base URL"
                  name={['memoryCapture', 'baseUrl']}
                  extra="Endpoint for the capture model (memoryCapture.baseUrl). Blank = primary base URL."
                >
                  <Input placeholder="https://openrouter.ai/api/v1" />
                </Form.Item>
              </AdvancedBlock>
            </>
          ) : null
        }
      </Form.Item>

      <Form.Item
        label="Show 'remembered' notices"
        name="memoryNotices"
        valuePropName="checked"
        extra="Show the dim '· remembered: …' notice after a capture — in the CLI, and as a quiet toast in the web app."
      >
        <Switch />
      </Form.Item>
    </Card>
  );
}
