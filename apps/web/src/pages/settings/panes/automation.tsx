// Automation — quick commands, channel toolsets, scheduled passes. The
// Automation card and the Latest digest section, moved verbatim from
// `Settings.tsx` (§4.2 rows 13, 18).

import { ContentRenderer } from '@ethosagent/ui-components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Select,
  Spin,
  Switch,
  Typography,
} from 'antd';
import type { Dispatch, SetStateAction } from 'react';
import { rpc } from '../../../rpc';
import { ROW_BOX_STYLE, RowLabel } from '../components/primitives';
import { nextRowId } from '../lib/row-id';
import type { ChannelToolsetRow, QuickCommandRow } from '../lib/rows';
import { useSettingsPane } from '../pane-context';

export function AutomationPane() {
  const { quickCommandRows, setQuickCommandRows, channelToolsetRows, setChannelToolsetRows } =
    useSettingsPane();

  return (
    <>
      <AutomationCard
        qcRows={quickCommandRows}
        setQcRows={setQuickCommandRows}
        ctRows={channelToolsetRows}
        setCtRows={setChannelToolsetRows}
      />
      <LatestDigestSection />
    </>
  );
}

function AutomationCard({
  qcRows,
  setQcRows,
  ctRows,
  setCtRows,
}: {
  qcRows: QuickCommandRow[];
  setQcRows: Dispatch<SetStateAction<QuickCommandRow[]>>;
  ctRows: ChannelToolsetRow[];
  setCtRows: Dispatch<SetStateAction<ChannelToolsetRow[]>>;
}) {
  const updateQc = (index: number, patch: Partial<QuickCommandRow>) =>
    setQcRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const removeQc = (index: number) => setQcRows((prev) => prev.filter((_, i) => i !== index));
  const addQc = () =>
    setQcRows((prev) => [
      ...prev,
      {
        _id: nextRowId(),
        name: '',
        type: 'reply',
        command: '',
        reply: '',
        gateway: false,
        channels: [],
      },
    ]);

  const updateCt = (index: number, patch: Partial<ChannelToolsetRow>) =>
    setCtRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const removeCt = (index: number) => setCtRows((prev) => prev.filter((_, i) => i !== index));
  const addCt = () =>
    setCtRows((prev) => [...prev, { _id: nextRowId(), platform: '', toolsets: [] }]);

  return (
    <Card title="Automation" size="small" style={{ marginBottom: 16 }}>
      <Typography.Text strong style={{ fontSize: 13 }}>
        Quick commands
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        Deterministic /name shortcuts (quick_commands.&lt;name&gt;) answered without the LLM — a
        canned reply or an operator-authored shell command. Saving replaces the whole set.
      </Typography.Paragraph>
      {qcRows.map((row, idx) => (
        <div key={row._id} style={ROW_BOX_STYLE}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <Typography.Text style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>
              /{row.name || '<name>'}
            </Typography.Text>
            <Button size="small" danger onClick={() => removeQc(idx)}>
              Remove
            </Button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <RowLabel>Name</RowLabel>
              <Input
                size="small"
                prefix="/"
                placeholder="status"
                value={row.name}
                onChange={(e) => updateQc(idx, { name: e.target.value })}
              />
            </div>
            <div style={{ width: 180 }}>
              <RowLabel>Type</RowLabel>
              <Select
                size="small"
                style={{ width: '100%' }}
                value={row.type}
                onChange={(v: 'exec' | 'reply') => updateQc(idx, { type: v })}
                options={[
                  { value: 'reply', label: 'reply — canned text' },
                  { value: 'exec', label: 'exec — shell command' },
                ]}
              />
            </div>
          </div>
          <div style={{ marginBottom: 8 }}>
            {row.type === 'exec' ? (
              <>
                <RowLabel>
                  Shell command (runs verbatim — channel text is never interpolated)
                </RowLabel>
                <Input
                  size="small"
                  style={{ fontFamily: 'Geist Mono, monospace' }}
                  placeholder="uptime"
                  value={row.command}
                  onChange={(e) => updateQc(idx, { command: e.target.value })}
                />
              </>
            ) : (
              <>
                <RowLabel>Reply text</RowLabel>
                <Input
                  size="small"
                  placeholder="All systems nominal."
                  value={row.reply}
                  onChange={(e) => updateQc(idx, { reply: e.target.value })}
                />
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div>
              <Checkbox
                checked={row.gateway}
                onChange={(e) => updateQc(idx, { gateway: e.target.checked })}
              >
                <span style={{ fontSize: 12 }}>Expose on channels</span>
              </Checkbox>
            </div>
            <div style={{ flex: 1 }}>
              <RowLabel>Limit to platforms (blank = all)</RowLabel>
              <Select
                size="small"
                mode="tags"
                open={false}
                suffixIcon={null}
                tokenSeparators={[',']}
                style={{ width: '100%' }}
                placeholder="telegram, slack"
                value={row.channels}
                onChange={(v: string[]) => updateQc(idx, { channels: v })}
                disabled={!row.gateway}
              />
            </div>
          </div>
        </div>
      ))}
      <Button
        type="dashed"
        size="small"
        onClick={addQc}
        style={{ width: '100%', marginBottom: 16 }}
      >
        Add quick command
      </Button>

      <Typography.Text strong style={{ fontSize: 13 }}>
        Channel toolsets
      </Typography.Text>
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        Per-platform toolset narrowing (channel_toolsets.&lt;platform&gt;). Messages from that
        platform see only the listed toolsets. Saving replaces the whole set.
      </Typography.Paragraph>
      {ctRows.map((row, idx) => (
        <div
          key={row._id}
          style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-end' }}
        >
          <div style={{ width: 160 }}>
            <RowLabel>Platform</RowLabel>
            <Input
              size="small"
              placeholder="telegram"
              value={row.platform}
              onChange={(e) => updateCt(idx, { platform: e.target.value })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <RowLabel>Toolsets</RowLabel>
            <Select
              size="small"
              mode="tags"
              open={false}
              suffixIcon={null}
              tokenSeparators={[',']}
              style={{ width: '100%' }}
              placeholder="memory, web"
              value={row.toolsets}
              onChange={(v: string[]) => updateCt(idx, { toolsets: v })}
            />
          </div>
          <Button size="small" danger onClick={() => removeCt(idx)}>
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="dashed"
        size="small"
        onClick={addCt}
        style={{ width: '100%', marginBottom: 16 }}
      >
        Add platform
      </Button>

      <Form.Item
        label="Nightly learning pass"
        name={['nightlyPass', 'enabled']}
        valuePropName="checked"
        extra="Governed-learning pass that runs overnight (nightlyPass.enabled, default off)."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.nightlyPass?.enabled !== cur.nightlyPass?.enabled}
      >
        {({ getFieldValue }) =>
          getFieldValue(['nightlyPass', 'enabled']) ? (
            <Form.Item
              label="Nightly pass schedule"
              name={['nightlyPass', 'cron']}
              extra="5-field cron (nightlyPass.cron). Blank = 0 3 * * *."
            >
              <Input style={{ fontFamily: 'Geist Mono, monospace' }} placeholder="0 3 * * *" />
            </Form.Item>
          ) : null
        }
      </Form.Item>

      <Form.Item
        label="Weekly digest"
        name={['weeklyDigest', 'enabled']}
        valuePropName="checked"
        extra="Weekly governed-learning digest (weeklyDigest.enabled, default off)."
      >
        <Switch />
      </Form.Item>
      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.weeklyDigest?.enabled !== cur.weeklyDigest?.enabled}
      >
        {({ getFieldValue }) =>
          getFieldValue(['weeklyDigest', 'enabled']) ? (
            <>
              <Form.Item
                label="Digest schedule"
                name={['weeklyDigest', 'cron']}
                extra="5-field cron (weeklyDigest.cron). Blank = 0 9 * * 1."
              >
                <Input style={{ fontFamily: 'Geist Mono, monospace' }} placeholder="0 9 * * 1" />
              </Form.Item>
              <Form.Item
                label="Digest recipients"
                name={['weeklyDigest', 'recipients']}
                extra="Email allowlist for --email delivery (weeklyDigest.recipients). Press Enter after each address."
              >
                <Select
                  mode="tags"
                  open={false}
                  suffixIcon={null}
                  tokenSeparators={[',']}
                  placeholder="you@example.com"
                />
              </Form.Item>
            </>
          ) : null
        }
      </Form.Item>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Latest digest — read-only view of the most recent weekly governed-learning
// report. Generation runs out-of-band (weekly cron / `ethos digest run`); a
// "generate now" action is deferred.
// ---------------------------------------------------------------------------

function formatDigestDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function LatestDigestSection() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const digestQuery = useQuery({
    queryKey: ['digest', 'latest'],
    queryFn: () => rpc.digest.latest(),
  });

  const generateMut = useMutation({
    mutationFn: () => rpc.digest.generate(),
    onSuccess: (data) => {
      if (data === null) {
        notification.info({
          message: 'No user personalities to build a digest for.',
          placement: 'topRight',
        });
        return;
      }
      qc.setQueryData(['digest', 'latest'], data);
      qc.invalidateQueries({ queryKey: ['digest', 'latest'] });
    },
    onError: (err) =>
      notification.error({
        message: 'Failed to generate digest',
        description: (err as Error).message,
      }),
  });

  return (
    <Card
      title="Latest digest"
      size="small"
      style={{ maxWidth: 640, marginTop: 32 }}
      extra={
        <Button size="small" loading={generateMut.isPending} onClick={() => generateMut.mutate()}>
          Generate now
        </Button>
      }
    >
      {digestQuery.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 80 }}>
          <Spin />
        </div>
      ) : !digestQuery.data ? (
        <Typography.Text type="secondary">
          No digest generated yet — runs weekly, or via{' '}
          <Typography.Text code>ethos digest run</Typography.Text>.
        </Typography.Text>
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
            <Typography.Text strong style={{ fontFamily: 'Geist Mono, monospace', fontSize: 13 }}>
              {digestQuery.data.label}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatDigestDate(digestQuery.data.generatedAt)}
            </Typography.Text>
          </div>
          <ContentRenderer content={digestQuery.data.markdown} format="markdown" />
        </div>
      )}
    </Card>
  );
}
