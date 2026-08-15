// General — basics (default personality, appearance) and onboarding.
// Off `Card`, onto `SettingRow` (§4.2 rows 2, 3, 12; plan Phase 3).
//
// `Appearance` (`skin`) stays here, not in Chat & context — O1: it is a global
// display token every surface reads, not a chat-pane preference.

import { BUILTIN_SKIN_NAMES, BUILTIN_SKINS } from '@ethosagent/design-tokens';
import { Button, Form, Select } from 'antd';
import { useNavigate } from 'react-router-dom';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';
import { useSettingsPane } from '../pane-context';

export function GeneralPane() {
  const { personalities, personalitiesLoading } = useSettingsPane();
  const navigate = useNavigate();

  return (
    <>
      <SectionHeading id="basics">basics</SectionHeading>

      <SettingRow
        label="Personality"
        formName="personality"
        help="Used when chat doesn't override per-session."
      >
        <Form.Item
          name="personality"
          rules={[{ required: true, message: 'Required' }]}
          style={{ marginBottom: 0 }}
        >
          <Select
            loading={personalitiesLoading}
            options={personalities.map((p) => ({
              label: `${p.name}${p.builtin ? ' (built-in)' : ''}`,
              value: p.id,
            }))}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Skin"
        formName="skin"
        help="DESIGN.md baseline plus named overrides. Applies across all surfaces (Web, TUI)."
      >
        <Form.Item name="skin" style={{ marginBottom: 0 }}>
          <Select
            options={BUILTIN_SKIN_NAMES.map((name) => ({
              value: name,
              label: `${name} — ${BUILTIN_SKINS[name].description}`,
            }))}
          />
        </Form.Item>
      </SettingRow>

      <SectionHeading id="onboarding">onboarding</SectionHeading>

      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">Setup wizard</div>
          <div className="settings-row-help">
            Re-run the guided setup to change your provider, model, personality, or messaging
            credentials.
          </div>
        </div>
        <div className="settings-row-control">
          <Button onClick={() => navigate('/onboarding')}>Run setup wizard</Button>
        </div>
      </div>
    </>
  );
}
