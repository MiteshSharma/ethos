// Developer — debug, logs, escape hatches. The Developer card and the Advanced
// (misc) card, moved verbatim from `Settings.tsx` (§4.2 rows 8, 17), off `Card`
// onto `SettingRow` / `SectionHeading` (Phase 4).
//
// `admin.enabled` is deliberately NOT here: enabling a system-operations console
// is a privilege decision, not a debug affordance, so it lives in Security &
// access (O2).

import { Checkbox, Form, Input, InputNumber, Select, Switch } from 'antd';
import { AdvancedBlock } from '../components/advanced';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';

export function DeveloperPane() {
  return (
    <>
      <SectionHeading id="debug">debug</SectionHeading>

      <SettingRow
        label="Enable debug mode"
        formName="debugMode"
        help="Show expanded tool arguments and internal events in chat."
      >
        <Form.Item name="debugMode" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Checkbox />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Show debug panel"
        formName="debugPanelEnabled"
        help="Adds a debug assistant to the right sidebar that can inspect session events, observability spans, and error logs."
      >
        <Form.Item name="debugPanelEnabled" valuePropName="checked" style={{ marginBottom: 0 }}>
          <Checkbox />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Debug panel model"
        formName="debugPanelModel"
        help="Model for the debug assistant. Leave empty to use the default (claude-sonnet-4-5)."
      >
        <Form.Item name="debugPanelModel" style={{ marginBottom: 0 }}>
          <Input placeholder="claude-sonnet-4-5" />
        </Form.Item>
      </SettingRow>

      <SectionHeading id="logs">logs</SectionHeading>

      <AdvancedBlock>
        <SettingRow
          label="Log rotation"
          formName="logsRotation.enabled"
          help="Rotate the ~/.ethos error logs (logs.rotation.enabled, default on)."
        >
          <Form.Item
            name={['logsRotation', 'enabled']}
            valuePropName="checked"
            style={{ marginBottom: 0 }}
          >
            <Switch />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Max log size (bytes)"
          formName="logsRotation.maxBytes"
          help="Rotate when a log exceeds this size (logs.rotation.maxBytes). Blank = built-in default."
        >
          <Form.Item name={['logsRotation', 'maxBytes']} style={{ marginBottom: 0 }}>
            <InputNumber min={1} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Rotated files kept"
          formName="logsRotation.maxFiles"
          help="Rotated log files to keep (logs.rotation.maxFiles). Blank = built-in default."
        >
          <Form.Item name={['logsRotation', 'maxFiles']} style={{ marginBottom: 0 }}>
            <InputNumber min={1} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </SettingRow>
      </AdvancedBlock>

      <SectionHeading id="escape-hatches">escape hatches</SectionHeading>

      {/* `a2a.enabled` is deliberately NOT here: the live A2A row in Security &
          access already toggles the same key through the running gate. */}
      <AdvancedBlock>
        <SettingRow
          label="Auto-install plugins"
          formName="pluginsAutoInstall"
          help="Install plugins from plugins.lock on startup (plugins.auto_install). Default leaves the key unset."
        >
          <Form.Item name="pluginsAutoInstall" style={{ marginBottom: 0 }}>
            <Select
              options={[
                { value: 'default', label: 'Default (unset)' },
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
            />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Web base URL"
          formName="webBaseUrl"
          help="Public URL of this web UI, used as the OAuth redirect base (webBaseUrl). Blank = localhost."
        >
          <Form.Item name="webBaseUrl" style={{ marginBottom: 0 }}>
            <Input placeholder="https://ethos.example.com" />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Azure API version"
          formName="apiVersion"
          help="REST API version for the azure provider (apiVersion). Blank = provider default."
        >
          <Form.Item name="apiVersion" style={{ marginBottom: 0 }}>
            <Input placeholder="2024-06-01" />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Per-turn timing summary"
          formName="verbose"
          help="Print a timing and cost line after every CLI response (verbose, default off)."
        >
          <Form.Item name="verbose" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Switch />
          </Form.Item>
        </SettingRow>
      </AdvancedBlock>
    </>
  );
}
