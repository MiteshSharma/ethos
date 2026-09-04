import type { PluginInfo, PluginScanFinding } from '@ethosagent/web-contracts';
import { Button, Modal, Typography } from 'antd';
import { useState } from 'react';
import { countBySeverity, describeScanRule, findingLocation } from '../lib/pluginScanFindings';

// What a plugin row says about its own load, and only when it has something to
// say: a plugin that loaded cleanly renders nothing at all. Two states earn
// chrome — a plugin that failed (until now invisible in the web UI, the more
// urgent of the two) and a plugin that loaded carrying safety notes.
//
// Yellow findings no longer block a load; they are surfaced here instead, which
// is the whole trade. Colour is always paired with a glyph and a word.

export function PluginStatusNote({ plugin }: { plugin: PluginInfo }) {
  const [open, setOpen] = useState(false);
  const findings = plugin.scanFindings ?? [];
  const failed = plugin.status === 'failed';
  if (!failed && findings.length === 0) return null;

  const noun = findings.length === 1 ? 'safety note' : 'safety notes';

  return (
    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {failed ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          ✗ Not loaded — {plugin.error ?? 'the loader gave no reason.'}
        </Typography.Text>
      ) : null}
      {findings.length > 0 ? (
        <Button
          type="link"
          size="small"
          style={{
            padding: 0,
            height: 'auto',
            fontSize: 12,
            alignSelf: 'flex-start',
            color: 'var(--warning)',
          }}
          onClick={() => setOpen(true)}
          aria-label={`Show ${findings.length} ${noun} for ${plugin.name}`}
        >
          ⚠ {failed ? '' : 'Loaded — '}
          {findings.length} {noun}
        </Button>
      ) : null}
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={640}
        title={`Safety scan — ${plugin.name}`}
      >
        <ScanFindingList findings={findings} />
      </Modal>
    </div>
  );
}

function ScanFindingList({ findings }: { findings: PluginScanFinding[] }) {
  const { red, yellow } = countBySeverity(findings);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        Ethos reads a plugin's source before it loads. {yellow > 0 ? `${yellow} yellow ` : ''}
        {yellow > 0 && red > 0 ? 'and ' : ''}
        {red > 0 ? `${red} red ` : ''}
        {red + yellow === 1 ? 'finding is' : 'findings are'} listed below. Yellow findings do not
        stop a plugin from loading — a plugin that fetches market data or news will always report an
        outbound network call. Red findings block the load.
      </Typography.Paragraph>
      {findings.map((f) => (
        <div
          key={`${f.severity}:${f.rule}:${f.file ?? ''}:${f.line ?? ''}:${f.excerpt ?? ''}`}
          style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span
              style={{
                fontSize: 11,
                fontFamily: 'Geist Mono, monospace',
                color: f.severity === 'red' ? 'var(--error)' : 'var(--warning)',
              }}
            >
              {f.severity === 'red' ? '✗ blocks loading' : '⚠ non-blocking'}
            </span>
            <span style={{ fontWeight: 500 }}>{describeScanRule(f.rule)}</span>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {f.message}
          </Typography.Text>
          {findingLocation(f) ? (
            <Typography.Text
              type="secondary"
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
            >
              {findingLocation(f)}
            </Typography.Text>
          ) : null}
          {f.excerpt ? (
            <pre
              style={{
                fontFamily: 'Geist Mono, monospace',
                fontSize: 11,
                margin: 0,
                padding: '6px 8px',
                overflowX: 'auto',
                background: 'var(--bg-elevated)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {f.excerpt}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}
