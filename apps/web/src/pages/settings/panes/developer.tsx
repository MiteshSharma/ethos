// Developer — debug, logs, escape hatches. The Developer card and the Advanced
// (misc) card, moved verbatim from `Settings.tsx` (§4.2 rows 8, 17).
//
// `admin.enabled` is deliberately NOT here: enabling a system-operations console
// is a privilege decision, not a debug affordance, so it lives in Security &
// access (O2).

import { Card, Checkbox, Form, Input, InputNumber, Select, Switch } from 'antd';
import { useSettingsPane } from '../pane-context';

export function DeveloperPane() {
  const { showAdvanced } = useSettingsPane();

  return (
    <>
      <Card title="Developer" size="small" style={{ marginBottom: 16 }}>
        <Form.Item
          name="debugMode"
          valuePropName="checked"
          extra="Show expanded tool arguments and internal events in chat."
        >
          <Checkbox>Enable debug mode</Checkbox>
        </Form.Item>

        <Form.Item
          name="debugPanelEnabled"
          valuePropName="checked"
          extra="Adds a debug assistant to the right sidebar that can inspect session events, observability spans, and error logs."
        >
          <Checkbox>Show debug panel</Checkbox>
        </Form.Item>

        <Form.Item
          name="debugPanelModel"
          extra="Model for the debug assistant. Leave empty to use the default (claude-sonnet-4-5)."
        >
          <Input placeholder="claude-sonnet-4-5" />
        </Form.Item>
      </Card>

      {showAdvanced && <AdvancedMiscCard />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Advanced misc (advanced) — log rotation, plugin auto-install, base URLs.
// `a2a.enabled` is deliberately NOT here: the live A2A card below the form
// already toggles the same key through the running gate.
// ---------------------------------------------------------------------------

function AdvancedMiscCard() {
  return (
    <Card title="Advanced" size="small" style={{ marginBottom: 16 }}>
      <Form.Item
        label="Log rotation"
        name={['logsRotation', 'enabled']}
        valuePropName="checked"
        extra="Rotate the ~/.ethos error logs (logs.rotation.enabled, default on)."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="Max log size (bytes)"
        name={['logsRotation', 'maxBytes']}
        extra="Rotate when a log exceeds this size (logs.rotation.maxBytes). Blank = built-in default."
      >
        <InputNumber min={1} precision={0} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Rotated files kept"
        name={['logsRotation', 'maxFiles']}
        extra="Rotated log files to keep (logs.rotation.maxFiles). Blank = built-in default."
      >
        <InputNumber min={1} precision={0} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Auto-install plugins"
        name="pluginsAutoInstall"
        extra="Install plugins from plugins.lock on startup (plugins.auto_install). Default leaves the key unset."
      >
        <Select
          options={[
            { value: 'default', label: 'Default (unset)' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Web base URL"
        name="webBaseUrl"
        extra="Public URL of this web UI, used as the OAuth redirect base (webBaseUrl). Blank = localhost."
      >
        <Input placeholder="https://ethos.example.com" />
      </Form.Item>
      <Form.Item
        label="Azure API version"
        name="apiVersion"
        extra="REST API version for the azure provider (apiVersion). Blank = provider default."
      >
        <Input placeholder="2024-06-01" />
      </Form.Item>
      <Form.Item
        label="Per-turn timing summary"
        name="verbose"
        valuePropName="checked"
        extra="Print a timing and cost line after every CLI response (verbose, default off)."
      >
        <Switch />
      </Form.Item>
    </Card>
  );
}
