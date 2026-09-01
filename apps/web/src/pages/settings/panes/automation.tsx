// Automation — quick commands, channel toolsets, scheduled passes. The
// Automation card and the Latest digest section, moved verbatim from
// `Settings.tsx` (§4.2 rows 13, 18), off `Card` onto `SectionHeading` (Phase 8).
//
// Quick commands and channel toolsets keep their existing per-row boxed
// layout (`ROW_BOX_STYLE`) rather than moving to `SettingTable` — Phase 6's
// table conversion already covered the rosters that needed it; this pass is
// Card removal, not a second table pass. Latest digest is a read-only view
// with its own "Generate now" action, not a form, so it renders in a raw
// `<div>` instead of being forced into `SettingRow`'s shape (the same call
// Phase 5a/5b made for non-form widgets). It stays under the
// `scheduled-passes` heading, not a heading of its own — §4.2 row 18 places
// it there, alongside the nightly/weekly schedule fields it is a readout of.

import { ContentRenderer } from '@ethosagent/ui-components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Select,
  Spin,
  Switch,
  Typography,
} from 'antd';
import type { Dispatch, SetStateAction } from 'react';
import { rpc } from '../../../rpc';
import { ROW_BOX_STYLE, RowLabel } from '../components/primitives';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';
import { nextRowId } from '../lib/row-id';
import type { ChannelToolsetRow, QuickCommandRow } from '../lib/rows';
import { useSettingsPane } from '../pane-context';

export function AutomationPane() {
  const { quickCommandRows, setQuickCommandRows, channelToolsetRows, setChannelToolsetRows } =
    useSettingsPane();

  return (
    <>
      <SectionHeading id="quick-commands">quick commands</SectionHeading>
      <QuickCommandsEditor rows={quickCommandRows} setRows={setQuickCommandRows} />

      <SectionHeading id="channel-toolsets">channel toolsets</SectionHeading>
      <ChannelToolsetsEditor rows={channelToolsetRows} setRows={setChannelToolsetRows} />

      <SectionHeading id="scheduled-passes">scheduled passes</SectionHeading>
      <ScheduledPassesFields />
      <LatestDigestSection />

      <SectionHeading id="team-supervisor">team supervisor</SectionHeading>
      <TeamSupervisorFields />
    </>
  );
}

function QuickCommandsEditor({
  rows,
  setRows,
}: {
  rows: QuickCommandRow[];
  setRows: Dispatch<SetStateAction<QuickCommandRow[]>>;
}) {
  const update = (index: number, patch: Partial<QuickCommandRow>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const remove = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));
  const add = () =>
    setRows((prev) => [
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

  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Deterministic /name shortcuts (quick_commands.&lt;name&gt;) answered without the LLM — a
        canned reply or an operator-authored shell command. Saving replaces the whole set.
      </Typography.Paragraph>
      {rows.map((row, idx) => (
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
            <Button size="small" danger onClick={() => remove(idx)}>
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
                onChange={(e) => update(idx, { name: e.target.value })}
              />
            </div>
            <div style={{ width: 180 }}>
              <RowLabel>Type</RowLabel>
              <Select
                size="small"
                style={{ width: '100%' }}
                value={row.type}
                onChange={(v: 'exec' | 'reply') => update(idx, { type: v })}
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
                  onChange={(e) => update(idx, { command: e.target.value })}
                />
              </>
            ) : (
              <>
                <RowLabel>Reply text</RowLabel>
                <Input
                  size="small"
                  placeholder="All systems nominal."
                  value={row.reply}
                  onChange={(e) => update(idx, { reply: e.target.value })}
                />
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div>
              <Checkbox
                checked={row.gateway}
                onChange={(e) => update(idx, { gateway: e.target.checked })}
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
                onChange={(v: string[]) => update(idx, { channels: v })}
                disabled={!row.gateway}
              />
            </div>
          </div>
        </div>
      ))}
      <Button type="dashed" size="small" onClick={add} style={{ width: '100%', marginBottom: 16 }}>
        Add quick command
      </Button>
    </>
  );
}

function ChannelToolsetsEditor({
  rows,
  setRows,
}: {
  rows: ChannelToolsetRow[];
  setRows: Dispatch<SetStateAction<ChannelToolsetRow[]>>;
}) {
  const update = (index: number, patch: Partial<ChannelToolsetRow>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const remove = (index: number) => setRows((prev) => prev.filter((_, i) => i !== index));
  const add = () => setRows((prev) => [...prev, { _id: nextRowId(), platform: '', toolsets: [] }]);

  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Per-platform toolset narrowing (channel_toolsets.&lt;platform&gt;). Messages from that
        platform see only the listed toolsets. Saving replaces the whole set.
      </Typography.Paragraph>
      {rows.map((row, idx) => (
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
              onChange={(e) => update(idx, { platform: e.target.value })}
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
              onChange={(v: string[]) => update(idx, { toolsets: v })}
            />
          </div>
          <Button size="small" danger onClick={() => remove(idx)}>
            Remove
          </Button>
        </div>
      ))}
      <Button type="dashed" size="small" onClick={add} style={{ width: '100%', marginBottom: 16 }}>
        Add platform
      </Button>
    </>
  );
}

function ScheduledPassesFields() {
  return (
    <>
      <SettingRow
        label="Nightly learning pass"
        formName="nightlyPass.enabled"
        help="Governed-learning pass that runs overnight (nightlyPass.enabled, default off)."
      >
        <Form.Item
          name={['nightlyPass', 'enabled']}
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Switch />
        </Form.Item>
      </SettingRow>
      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.nightlyPass?.enabled !== cur.nightlyPass?.enabled}
      >
        {({ getFieldValue }) =>
          getFieldValue(['nightlyPass', 'enabled']) ? (
            <SettingRow
              label="Nightly pass schedule"
              formName="nightlyPass.cron"
              help="5-field cron (nightlyPass.cron). Blank = 0 3 * * *."
            >
              <Form.Item name={['nightlyPass', 'cron']} style={{ marginBottom: 0 }}>
                <Input style={{ fontFamily: 'Geist Mono, monospace' }} placeholder="0 3 * * *" />
              </Form.Item>
            </SettingRow>
          ) : null
        }
      </Form.Item>

      <SettingRow
        label="Weekly digest"
        formName="weeklyDigest.enabled"
        help="Weekly governed-learning digest (weeklyDigest.enabled, default off)."
      >
        <Form.Item
          name={['weeklyDigest', 'enabled']}
          valuePropName="checked"
          style={{ marginBottom: 0 }}
        >
          <Switch />
        </Form.Item>
      </SettingRow>
      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.weeklyDigest?.enabled !== cur.weeklyDigest?.enabled}
      >
        {({ getFieldValue }) =>
          getFieldValue(['weeklyDigest', 'enabled']) ? (
            <>
              <SettingRow
                label="Digest schedule"
                formName="weeklyDigest.cron"
                help="5-field cron (weeklyDigest.cron). Blank = 0 9 * * 1."
              >
                <Form.Item name={['weeklyDigest', 'cron']} style={{ marginBottom: 0 }}>
                  <Input style={{ fontFamily: 'Geist Mono, monospace' }} placeholder="0 9 * * 1" />
                </Form.Item>
              </SettingRow>
              <SettingRow
                label="Digest recipients"
                formName="weeklyDigest.recipients"
                help="Email allowlist for --email delivery (weeklyDigest.recipients). Press Enter after each address."
              >
                <Form.Item name={['weeklyDigest', 'recipients']} style={{ marginBottom: 0 }}>
                  <Select
                    mode="tags"
                    open={false}
                    suffixIcon={null}
                    tokenSeparators={[',']}
                    placeholder="you@example.com"
                  />
                </Form.Item>
              </SettingRow>
            </>
          ) : null
        }
      </Form.Item>

      <SettingRow
        label="Max parallel cron jobs"
        formName="cronMaxParallelJobs"
        help="Cron firings allowed to run at once (cron.maxParallelJobs). Blank = uncapped."
      >
        <Form.Item name="cronMaxParallelJobs" style={{ marginBottom: 0 }}>
          <InputNumber min={1} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </SettingRow>
    </>
  );
}

// The brake on the supervisor's own restarts of a crashed team member: how many
// it may attempt, and the window it counts them in. Nothing scheduled and
// nothing per-channel, which is why it is not folded into scheduled passes.
function TeamSupervisorFields() {
  return (
    <>
      <SettingRow
        label="Max restarts in the window"
        formName="teamSupervisorRestartLoopGuard.maxRestarts"
        help="Automatic member respawns allowed inside the window before the supervisor gives up (teamSupervisor.restartLoopGuard.maxRestarts, unset = 5 — one more than the old hardcoded four)."
      >
        <Form.Item
          name={['teamSupervisorRestartLoopGuard', 'maxRestarts']}
          style={{ marginBottom: 0 }}
        >
          <InputNumber min={1} max={1000} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Restart window (seconds)"
        formName="teamSupervisorRestartLoopGuard.windowSeconds"
        help="How long those respawns are counted over (teamSupervisor.restartLoopGuard.windowSeconds, unset = 60)."
      >
        <Form.Item
          name={['teamSupervisorRestartLoopGuard', 'windowSeconds']}
          style={{ marginBottom: 0 }}
        >
          <InputNumber min={1} max={86400} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </SettingRow>
    </>
  );
}

// ---------------------------------------------------------------------------
// Latest digest — read-only view of the most recent weekly governed-learning
// report. Generation runs out-of-band (weekly cron / `ethos digest run`); a
// "generate now" action is deferred. Not a `SettingRow` — a read-only view
// with its own action button, not a single labelled control.
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
    <div style={{ maxWidth: 640, marginTop: 24 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Typography.Text strong style={{ fontSize: 13 }}>
          Latest digest
        </Typography.Text>
        <Button size="small" loading={generateMut.isPending} onClick={() => generateMut.mutate()}>
          Generate now
        </Button>
      </div>
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
    </div>
  );
}
