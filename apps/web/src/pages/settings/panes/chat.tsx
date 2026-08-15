// Chat & context — display and context. Two cards, moved verbatim from
// `Settings.tsx` (§4.2 rows 6, 7).

import { Card, Checkbox, Form, InputNumber, Select, Switch } from 'antd';
import { AdvancedBlock } from '../components/advanced';

export function ChatPane() {
  return (
    <>
      <Card title="Chat display" size="small" style={{ marginBottom: 16 }}>
        <Form.Item
          label="Response length"
          name="verbosity"
          extra="How long the agent's prose runs (verbosity)."
        >
          <Select
            options={[
              { value: 'concise', label: 'Concise' },
              { value: 'balanced', label: 'Balanced' },
              { value: 'verbose', label: 'Verbose' },
            ]}
          />
        </Form.Item>

        <Form.Item
          label="Stream draft edits"
          name="streamingEdits"
          extra="Whether channel replies (Telegram, Slack) grow in place as they're written. DMs only, everywhere, or off."
        >
          <Select
            options={[
              { value: 'dms', label: 'Direct messages only' },
              { value: 'all', label: 'DMs and group chats' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </Form.Item>

        <Form.Item
          label="Interface detail"
          name="displayVerbosity"
          extra="How much tool and status chrome chat surfaces render (display.verbosity). Does not change what the agent writes."
        >
          <Select
            options={[
              { value: 'quiet', label: 'Quiet' },
              { value: 'default', label: 'Default' },
              { value: 'verbose', label: 'Verbose' },
              { value: 'debug', label: 'Debug' },
            ]}
          />
        </Form.Item>

        <Form.Item
          label="Enter while busy"
          name="displayBusyInputMode"
          extra="What pressing Enter mid-turn does (display.busy_input_mode)."
        >
          <Select
            options={[
              { value: 'interrupt', label: 'Interrupt the turn' },
              { value: 'queue', label: 'Queue for the next turn' },
              { value: 'steer', label: 'Steer the current turn' },
            ]}
          />
        </Form.Item>

        <AdvancedBlock>
          <Form.Item
            label="Tool preview length"
            name="displayToolPreviewLength"
            extra="Truncate tool arguments in the feed to this many characters; 0 = no truncation (display.tool_preview_length)."
          >
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="Resume hint"
            name="displayResumeHint"
            valuePropName="checked"
            extra="Show the resume hint when leaving CLI chat (display.resume_hint, default on)."
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="Resume recap turns"
            name="displayResumeRecapTurns"
            extra="Turn pairs recapped when resuming a session; 0 disables (display.resume_recap_turns, default 3)."
          >
            <InputNumber min={0} max={10} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="Bell on completion"
            name="displayBellOnComplete"
            valuePropName="checked"
            extra="Ring the terminal bell when a background task finishes (display.bell_on_complete, default off)."
          >
            <Switch />
          </Form.Item>
        </AdvancedBlock>
      </Card>

      <Card title="Context" size="small" style={{ marginBottom: 16 }}>
        <Form.Item
          name="contextLayering"
          valuePropName="checked"
          extra="Include previous session summaries for deeper context across conversations."
        >
          <Checkbox>Enable context layering</Checkbox>
        </Form.Item>

        <Form.Item
          label="Auto-compaction"
          name="autoCompact"
          valuePropName="checked"
          extra="Compact long sessions automatically near ~80% of the model's context window (default on)."
        >
          <Switch />
        </Form.Item>

        <AdvancedBlock>
          <Form.Item
            label="Compaction pressure"
            name={['compaction', 'pressure']}
            extra="Context-window fraction that triggers compaction (compaction.pressure, default 0.8). Blank = default."
          >
            <InputNumber
              min={0.01}
              max={1}
              step={0.05}
              style={{ width: '100%' }}
              placeholder="0.8"
            />
          </Form.Item>
          <Form.Item
            label="Compaction target"
            name={['compaction', 'target']}
            extra="Fraction the session is shrunk down to (compaction.target, default 0.7). Blank = default."
          >
            <InputNumber
              min={0.01}
              max={1}
              step={0.05}
              style={{ width: '100%' }}
              placeholder="0.7"
            />
          </Form.Item>
          <Form.Item
            label="Gate delta (tokens)"
            name={['compaction', 'gateDelta']}
            extra="Extra token headroom before the compaction gate fires (compaction.gateDelta). Blank = unset."
          >
            <InputNumber min={0} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="Retry on overflow"
            name={['compaction', 'retryOnOverflow']}
            valuePropName="checked"
            extra="Compact and retry once when a request overflows the window (compaction.retryOnOverflow, default on)."
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="Small-window mode"
            name={['compaction', 'smallWindow']}
            extra="Force small-window handling for local models (compaction.smallWindow, default auto)."
          >
            <Select
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
            />
          </Form.Item>
        </AdvancedBlock>
      </Card>
    </>
  );
}
