// Memory — store, approval, consolidation, capture. Off `Card`, onto
// `SettingRow` (§4.2 row 4; plan Phase 3). All four sections come out of what
// was one Memory card.
//
// `memoryApproval.mode` here is MEMORY approval — whether the agent asks before
// it writes to memory. Tool approval (`approvalMode`) is a rail away, in
// Security & access, and the two never merge.

import { Form, Input, InputNumber, Radio, Select, Switch } from 'antd';
import { AdvancedBlock } from '../components/advanced';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';
import { useSettingsPane } from '../pane-context';

export function MemoryPane() {
  const { config: configData } = useSettingsPane();

  return (
    <>
      <SectionHeading id="store">store</SectionHeading>

      <SettingRow
        label="Memory mode"
        formName="memory"
        help="Markdown is human-editable in ~/.ethos/MEMORY.md. Vector uses local embeddings. Vault targets an external directory (memoryVault.path)."
      >
        <Form.Item name="memory" style={{ marginBottom: 0 }}>
          <Radio.Group>
            <Radio.Button value="markdown">Markdown</Radio.Button>
            <Radio.Button value="vector">Vector</Radio.Button>
            <Radio.Button value="vault">Vault</Radio.Button>
          </Radio.Group>
        </Form.Item>
      </SettingRow>

      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.memory !== cur.memory}>
        {({ getFieldValue }) =>
          getFieldValue('memory') === 'vault' ? (
            <>
              <SettingRow
                label="Vault path"
                formName="memoryVault.path"
                help="Absolute path of the vault directory the agent reads and writes."
              >
                <Form.Item
                  name={['memoryVault', 'path']}
                  rules={[{ required: true, message: 'Vault path is required for vault memory' }]}
                  style={{ marginBottom: 0 }}
                >
                  <Input placeholder="/Users/you/Documents/MyVault" />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="Agent directory"
                formName="memoryVault.agentDir"
                help="Subtree inside the vault the agent owns. Blank = Ethos."
              >
                <Form.Item name={['memoryVault', 'agentDir']} style={{ marginBottom: 0 }}>
                  <Input placeholder="Ethos" />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="Prefetch notes"
                formName="memoryVault.prefetch"
                help="Note names loaded into every prompt. Press Enter after each name."
              >
                <Form.Item name={['memoryVault', 'prefetch']} style={{ marginBottom: 0 }}>
                  <Select
                    mode="tags"
                    open={false}
                    suffixIcon={null}
                    tokenSeparators={[',']}
                    placeholder="MEMORY, USER"
                  />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="Excluded notes"
                formName="memoryVault.exclude"
                help="Note names hidden from list and search."
              >
                <Form.Item name={['memoryVault', 'exclude']} style={{ marginBottom: 0 }}>
                  <Select
                    mode="tags"
                    open={false}
                    suffixIcon={null}
                    tokenSeparators={[',']}
                    placeholder="Private, Journal"
                  />
                </Form.Item>
              </SettingRow>
            </>
          ) : null
        }
      </Form.Item>

      <AdvancedBlock>
        <SettingRow
          label="MEMORY.md character limit"
          formName="memoryCharLimits.memory"
          help="Ceiling on MEMORY.md for the markdown backend (memory.charLimits.memory, default 524288). Past it the oldest lines move to memory-archive.md."
        >
          <Form.Item name={['memoryCharLimits', 'memory']} style={{ marginBottom: 0 }}>
            <InputNumber min={1} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="USER.md character limit"
          formName="memoryCharLimits.user"
          help="Ceiling on USER.md for the markdown backend (memory.charLimits.user, default 524288). Past it the oldest lines move to memory-archive.md."
        >
          <Form.Item name={['memoryCharLimits', 'user']} style={{ marginBottom: 0 }}>
            <InputNumber min={1} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
      </AdvancedBlock>

      <SectionHeading id="approval">approval</SectionHeading>

      <SettingRow label="Memory approval" formName="memoryApproval.mode">
        <Form.Item name={['memoryApproval', 'mode']} style={{ marginBottom: 0 }}>
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
      </SettingRow>

      <AdvancedBlock>
        <SettingRow
          label="Pending queue cap"
          formName="memoryApproval.cap"
          help="Max pending candidates per scope (default 200)."
        >
          <Form.Item name={['memoryApproval', 'cap']} style={{ marginBottom: 0 }}>
            <InputNumber min={1} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Pending TTL (days)"
          formName="memoryApproval.ttlDays"
          help="Days before an unreviewed candidate expires (default 30)."
        >
          <Form.Item name={['memoryApproval', 'ttlDays']} style={{ marginBottom: 0 }}>
            <InputNumber min={1} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
      </AdvancedBlock>

      <SectionHeading id="consolidation">consolidation</SectionHeading>

      <SettingRow
        label="Consolidate memory between turns"
        formName="memoryConsolidationEnabled"
        help="Silently distill durable facts into memory before long sessions compact (default off)."
      >
        <Form.Item
          name="memoryConsolidationEnabled"
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Switch />
        </Form.Item>
      </SettingRow>

      <AdvancedBlock>
        <SettingRow
          label="Flush threshold"
          formName="memoryConsolidation.flushThreshold"
          help="Context-window fraction that triggers the silent flush (default 0.7)."
        >
          <Form.Item name={['memoryConsolidation', 'flushThreshold']} style={{ marginBottom: 0 }}>
            <InputNumber min={0.01} max={1} step={0.05} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Flush timebox (ms)"
          formName="memoryConsolidation.timeboxMs"
          help="Max time the flush turn may run (default 30000)."
        >
          <Form.Item name={['memoryConsolidation', 'timeboxMs']} style={{ marginBottom: 0 }}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Flush token cap"
          formName="memoryConsolidation.maxTokens"
          help="Token budget for the flush turn (default 1024)."
        >
          <Form.Item name={['memoryConsolidation', 'maxTokens']} style={{ marginBottom: 0 }}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Max characters per flush"
          formName="memoryConsolidation.maxDeltaChars"
          help="Most characters one flush may write (default 4000)."
        >
          <Form.Item name={['memoryConsolidation', 'maxDeltaChars']} style={{ marginBottom: 0 }}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Messages between flushes"
          formName="memoryConsolidation.minMessagesSinceFlush"
          help="Minimum messages before another flush may run (default 8)."
        >
          <Form.Item
            name={['memoryConsolidation', 'minMessagesSinceFlush']}
            style={{ marginBottom: 0 }}
          >
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Decay half-life (days)"
          formName="memoryConsolidation.halfLifeDays"
          help="Recency half-life for memory decay (default 30)."
        >
          <Form.Item name={['memoryConsolidation', 'halfLifeDays']} style={{ marginBottom: 0 }}>
            <InputNumber min={0.1} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Decay archive threshold"
          formName="memoryConsolidation.threshold"
          help="Entries weighted below this get archived (default 0.05)."
        >
          <Form.Item name={['memoryConsolidation', 'threshold']} style={{ marginBottom: 0 }}>
            <InputNumber min={0} max={1} step={0.01} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Exempt USER.md from decay"
          formName="memoryConsolidation.exemptUser"
          help="Keep the persistent user profile out of decay (default on)."
        >
          <Form.Item
            name={['memoryConsolidation', 'exemptUser']}
            valuePropName="checked"
            style={{ marginBottom: 0 }}
          >
            <Switch />
          </Form.Item>
        </SettingRow>
      </AdvancedBlock>

      <SectionHeading id="capture">capture</SectionHeading>

      <SettingRow
        label="Capture facts proactively"
        formName="memoryCaptureEnabled"
        help="Notice durable facts mid-conversation and record them without being asked (default off)."
      >
        <Form.Item name="memoryCaptureEnabled" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Switch />
        </Form.Item>
      </SettingRow>

      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.memoryCaptureEnabled !== cur.memoryCaptureEnabled}
      >
        {({ getFieldValue }) =>
          getFieldValue('memoryCaptureEnabled') ? (
            <>
              <SettingRow
                label="Capture model"
                formName="memoryCaptureModel"
                help="Cheap model that extracts the fact. Leave blank to reuse the cheapest configured model."
              >
                <Form.Item name="memoryCaptureModel" style={{ marginBottom: 0 }}>
                  <Input placeholder="claude-haiku-4-5-20251001" />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="Captures per hour"
                formName="memoryCapture.maxPerHour"
                help="Hourly capture cap per memory scope (default 6)."
              >
                <Form.Item name={['memoryCapture', 'maxPerHour']} style={{ marginBottom: 0 }}>
                  <InputNumber min={1} precision={0} style={{ width: '100%' }} />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="Captures per day"
                formName="memoryCapture.maxPerDay"
                help="Daily capture cap per memory scope (default 30)."
              >
                <Form.Item name={['memoryCapture', 'maxPerDay']} style={{ marginBottom: 0 }}>
                  <InputNumber min={1} precision={0} style={{ width: '100%' }} />
                </Form.Item>
              </SettingRow>
              <AdvancedBlock>
                <SettingRow
                  label="Capture provider"
                  formName="memoryCapture.provider"
                  help="Auxiliary provider for capture extraction. Blank = primary provider."
                >
                  <Form.Item name={['memoryCapture', 'provider']} style={{ marginBottom: 0 }}>
                    <Input placeholder="openrouter" />
                  </Form.Item>
                </SettingRow>
                <SettingRow
                  label="Capture API key"
                  formName="memoryCapture.apiKey"
                  help={
                    configData?.memoryCapture.apiKeyPreview
                      ? `Current: ${configData.memoryCapture.apiKeyPreview} — sent only when you type a new key.`
                      : 'Sent only when you type a key. Blank = primary key.'
                  }
                >
                  <Form.Item name={['memoryCapture', 'apiKey']} style={{ marginBottom: 0 }}>
                    <Input.Password
                      autoComplete="off"
                      placeholder={configData?.memoryCapture.apiKeyPreview ?? 'paste new key'}
                    />
                  </Form.Item>
                </SettingRow>
                <SettingRow
                  label="Capture base URL"
                  formName="memoryCapture.baseUrl"
                  help="Endpoint for the capture model. Blank = primary base URL."
                >
                  <Form.Item name={['memoryCapture', 'baseUrl']} style={{ marginBottom: 0 }}>
                    <Input placeholder="https://openrouter.ai/api/v1" />
                  </Form.Item>
                </SettingRow>
              </AdvancedBlock>
            </>
          ) : null
        }
      </Form.Item>

      <SettingRow
        label="Show 'remembered' notices"
        formName="memoryNotices"
        help="Show the dim '· remembered: …' notice after a capture — in the CLI, and as a quiet toast in the web app."
      >
        <Form.Item name="memoryNotices" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Switch />
        </Form.Item>
      </SettingRow>
    </>
  );
}
