import { QuestionCircleOutlined } from '@ant-design/icons';
import { Popover, Select, Typography } from 'antd';
import type { CSSProperties } from 'react';
import {
  describeToolSettingsFields,
  type ToolSettingsSchemaWire,
} from '../../lib/tool-settings-form';
import { SecretPicker } from './SecretPicker';

// Schema-driven tool-settings form. Renders FROM a tool's `settingsSchema` with
// no tool-specific knowledge: `enum` → Select, `secret-binding` → SecretPicker.
// Reused for the global default (Settings) and the per-personality panel.
//
// The one documented coupling: a `secret-binding` field is filtered by the
// value of a sibling `provider` enum when present, so the picker only offers
// keys for the chosen provider. This mirrors how the tool resolves the binding
// (`providers/<provider>/<name>`).

const SECTION_LABEL_STYLE: CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginBottom: 4,
};

export interface ToolSettingsFormProps {
  schema: ToolSettingsSchemaWire;
  /** fieldKey → value. Absent keys are unset. */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  disabled?: boolean;
}

export function ToolSettingsForm({ schema, value, onChange, disabled }: ToolSettingsFormProps) {
  const controls = describeToolSettingsFields(schema);

  const setField = (key: string, next: string | undefined) => {
    const merged = { ...value };
    if (next === undefined || next === '') delete merged[key];
    else merged[key] = next;
    onChange(merged);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {controls.map((control) => (
        <div key={control.key}>
          <Typography.Text type="secondary" style={SECTION_LABEL_STYLE}>
            {control.label}
            {control.kind === 'secret' && control.helpText ? (
              <Popover content={control.helpText} trigger="click">
                <QuestionCircleOutlined style={{ marginLeft: 4, cursor: 'pointer' }} />
              </Popover>
            ) : null}
          </Typography.Text>
          {control.kind === 'enum' ? (
            <Select
              style={{ minWidth: 220, width: '100%' }}
              value={value[control.key] ?? control.default ?? undefined}
              onChange={(v) => setField(control.key, v)}
              options={control.options}
              placeholder={`Select ${control.label.toLowerCase()}`}
              disabled={disabled}
              allowClear
            />
          ) : (
            <SecretPicker
              value={value[control.key]}
              onChange={(name) => setField(control.key, name)}
              secretKind={control.secretKind}
              providerFilter={value.provider}
              disabled={disabled}
            />
          )}
        </div>
      ))}
    </div>
  );
}
