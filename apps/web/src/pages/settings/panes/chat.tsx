// Chat & context — display and context. Off `Card`, onto `SettingRow`
// (§4.2 rows 6, 7; plan Phase 3).

import { Checkbox, Form, InputNumber, Select, Switch } from 'antd';
import { AdvancedBlock } from '../components/advanced';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';

export function ChatPane() {
  return (
    <>
      <SectionHeading id="display">display</SectionHeading>

      <SettingRow
        label="Response length"
        formName="verbosity"
        help="How long the agent's prose runs."
      >
        <Form.Item name="verbosity" style={{ marginBottom: 0 }}>
          <Select
            options={[
              { value: 'concise', label: 'Concise' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'verbose', label: 'Verbose' },
            ]}
          />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Stream draft edits"
        formName="streamingEdits"
        help="Whether channel replies (Telegram, Slack) grow in place as they're written. DMs only, everywhere, or off."
      >
        <Form.Item name="streamingEdits" style={{ marginBottom: 0 }}>
          <Select
            options={[
              { value: 'dms', label: 'Direct messages only' },
              { value: 'all', label: 'DMs and group chats' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Interface detail"
        formName="displayVerbosity"
        help="How much tool and status chrome chat surfaces render. Does not change what the agent writes."
      >
        <Form.Item name="displayVerbosity" style={{ marginBottom: 0 }}>
          <Select
            options={[
              { value: 'quiet', label: 'Quiet' },
              { value: 'default', label: 'Default' },
              { value: 'verbose', label: 'Verbose' },
              { value: 'debug', label: 'Debug' },
            ]}
          />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Enter while busy"
        formName="displayBusyInputMode"
        help="What pressing Enter mid-turn does."
      >
        <Form.Item name="displayBusyInputMode" style={{ marginBottom: 0 }}>
          <Select
            options={[
              { value: 'interrupt', label: 'Interrupt the turn' },
              { value: 'queue', label: 'Queue for the next turn' },
              { value: 'steer', label: 'Steer the current turn' },
            ]}
          />
        </Form.Item>
      </SettingRow>

      <AdvancedBlock>
        <SettingRow
          label="Tool preview length"
          formName="displayToolPreviewLength"
          help="Truncate tool arguments in the feed to this many characters; 0 = no truncation."
        >
          <Form.Item name="displayToolPreviewLength" style={{ marginBottom: 0 }}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Resume hint"
          formName="displayResumeHint"
          help="Show the resume hint when leaving CLI chat (default on)."
        >
          <Form.Item name="displayResumeHint" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Switch />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Resume recap turns"
          formName="displayResumeRecapTurns"
          help="Turn pairs recapped when resuming a session; 0 disables (default 3)."
        >
          <Form.Item name="displayResumeRecapTurns" style={{ marginBottom: 0 }}>
            <InputNumber min={0} max={10} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Bell on completion"
          formName="displayBellOnComplete"
          help="Ring the terminal bell when a background task finishes (default off)."
        >
          <Form.Item
            name="displayBellOnComplete"
            valuePropName="checked"
            style={{ marginBottom: 0 }}
          >
            <Switch />
          </Form.Item>
        </SettingRow>
      </AdvancedBlock>

      <SectionHeading id="context">context</SectionHeading>

      <SettingRow
        label="Enable context layering"
        formName="contextLayering"
        help="Include previous session summaries for deeper context across conversations."
      >
        <Form.Item name="contextLayering" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Checkbox />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Auto-compaction"
        formName="autoCompact"
        help="Compact long sessions automatically near ~80% of the model's context window (default on)."
      >
        <Form.Item name="autoCompact" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Switch />
        </Form.Item>
      </SettingRow>

      <AdvancedBlock>
        <SettingRow
          label="Compaction pressure"
          formName="compaction.pressure"
          help="Context-window fraction that triggers compaction (default 0.8). Blank = default."
        >
          <Form.Item name={['compaction', 'pressure']} style={{ marginBottom: 0 }}>
            <InputNumber
              min={0.01}
              max={1}
              step={0.05}
              style={{ width: '100%' }}
              placeholder="0.8"
            />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Compaction target"
          formName="compaction.target"
          help="Fraction the session is shrunk down to (default 0.7). Blank = default."
        >
          <Form.Item name={['compaction', 'target']} style={{ marginBottom: 0 }}>
            <InputNumber
              min={0.01}
              max={1}
              step={0.05}
              style={{ width: '100%' }}
              placeholder="0.7"
            />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Gate delta (tokens)"
          formName="compaction.gateDelta"
          help="Extra token headroom before the compaction gate fires. Blank = unset."
        >
          <Form.Item name={['compaction', 'gateDelta']} style={{ marginBottom: 0 }}>
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Retry on overflow"
          formName="compaction.retryOnOverflow"
          help="Compact and retry once when a request overflows the window (default on)."
        >
          <Form.Item
            name={['compaction', 'retryOnOverflow']}
            valuePropName="checked"
            style={{ marginBottom: 0 }}
          >
            <Switch />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Abort on summary failure"
          formName="compaction.abortOnSummaryFailure"
          help="Surface a failed emergency summary as its own error instead of the generic overflow rejection (default off)."
        >
          <Form.Item
            name={['compaction', 'abortOnSummaryFailure']}
            valuePropName="checked"
            style={{ marginBottom: 0 }}
          >
            <Switch />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Small-window mode"
          formName="compaction.smallWindow"
          help="Force small-window handling for local models (default auto)."
        >
          <Form.Item name={['compaction', 'smallWindow']} style={{ marginBottom: 0 }}>
            <Select
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
            />
          </Form.Item>
        </SettingRow>
      </AdvancedBlock>

      <SectionHeading id="discord">Discord</SectionHeading>

      <SettingRow
        label="Backfill missed messages"
        formName="discordMissedMessageBackfill.enabled"
        help="Read a channel's recent history the first time the Discord adapter sees a lane (default on)."
      >
        <Form.Item
          name={['discordMissedMessageBackfill', 'enabled']}
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Switch />
        </Form.Item>
      </SettingRow>

      <AdvancedBlock>
        <SettingRow
          label="Backfill window (seconds)"
          formName="discordMissedMessageBackfill.windowSeconds"
          help="Skip messages older than this. Blank = no age bound."
        >
          <Form.Item
            name={['discordMissedMessageBackfill', 'windowSeconds']}
            style={{ marginBottom: 0 }}
          >
            <InputNumber min={1} max={604800} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Backfill message limit"
          formName="discordMissedMessageBackfill.limit"
          help="Messages read per lane (default 50). 100 is Discord's own ceiling."
        >
          <Form.Item name={['discordMissedMessageBackfill', 'limit']} style={{ marginBottom: 0 }}>
            <InputNumber min={1} max={100} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
      </AdvancedBlock>
    </>
  );
}
