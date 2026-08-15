// General — basics (default personality, appearance) and onboarding.
// Cards moved verbatim from `Settings.tsx` (§4.2 rows 2, 3, 12).

import { BUILTIN_SKIN_NAMES, BUILTIN_SKINS } from '@ethosagent/design-tokens';
import { Button, Card, Form, Select, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useSettingsPane } from '../pane-context';

export function GeneralPane() {
  const { personalities, personalitiesLoading } = useSettingsPane();
  const navigate = useNavigate();

  return (
    <>
      <Card title="Default personality" size="small" style={{ marginBottom: 16 }}>
        <Form.Item
          label="Personality"
          name="personality"
          rules={[{ required: true, message: 'Required' }]}
          extra="Used when chat doesn't override per-session."
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
      </Card>

      <Card title="Appearance" size="small" style={{ marginBottom: 16 }}>
        <Form.Item
          label="Skin"
          name="skin"
          extra="DESIGN.md baseline plus named overrides. Applies across all surfaces (Web, TUI)."
        >
          <Select
            options={BUILTIN_SKIN_NAMES.map((name) => ({
              value: name,
              label: `${name} — ${BUILTIN_SKINS[name].description}`,
            }))}
          />
        </Form.Item>
      </Card>

      <Card title="Setup wizard" size="small" style={{ maxWidth: 640, marginTop: 8 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 12 }}>
          Re-run the guided setup to change your provider, model, personality, or messaging
          credentials.
        </Typography.Paragraph>
        <Button onClick={() => navigate('/onboarding')}>Run setup wizard</Button>
      </Card>
    </>
  );
}
