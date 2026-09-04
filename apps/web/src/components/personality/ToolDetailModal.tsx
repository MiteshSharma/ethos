import { CheckCircleOutlined, CloseCircleOutlined, MinusCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Modal, Spin, Tag, Typography } from 'antd';
import { Fragment, type ReactNode } from 'react';
import { rpc } from '../../rpc';

// The Toolset tab's per-tool inspector. Clicking a tool name in
// `ToolsetAffordances` opens this; it answers two questions the toolset
// textarea cannot:
//
//   1. "What is this tool allowed to touch?" — the declared capabilities,
//      flags and JSON schema, straight from the registry.
//   2. "Does it actually work in THIS deployment?" — the four checks, and
//      (only when the server's own gate agrees) a real execution.
//
// The load-bearing state is the MISMATCH: a personality's toolset naming a
// tool this deployment never registered. The registry filters unavailable
// tools out of the catalog, so nothing else in the UI says so — the agent just
// silently cannot call it.

type ToolDetail = Awaited<ReturnType<typeof rpc.tools.detail>>;
type ToolTest = Awaited<ReturnType<typeof rpc.tools.test>>;
type ToolCheck = ToolTest['checks'][number];
type FsReachEntry = string[] | 'from-personality';

const MONO = 'Geist Mono, monospace';

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--ethos-text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        margin: '20px 0 10px',
      }}
    >
      {children}
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: MONO, fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
      {children}
    </span>
  );
}

/** Wide content scrolls inside its own box so the modal body never does. */
function ScrollBlock({ children }: { children: string }) {
  return (
    <pre
      style={{
        margin: 0,
        maxHeight: 240,
        overflow: 'auto',
        background: 'var(--ethos-code-bg)',
        border: '1px solid var(--ethos-border)',
        borderRadius: 'var(--radius-sm)',
        padding: '10px 12px',
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      {children}
    </pre>
  );
}

function Facts({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(88px, max-content) minmax(0, 1fr)',
        columnGap: 16,
        rowGap: 6,
        fontSize: 12.5,
      }}
    >
      {rows.map((r) => (
        <Fragment key={r.label}>
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            {r.label}
          </Typography.Text>
          <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{r.value}</div>
        </Fragment>
      ))}
    </div>
  );
}

/** `'from-personality'` is a sentinel, not a path — say what it means. */
function reachValue(entry: FsReachEntry | undefined): ReactNode | null {
  if (entry === undefined) return null;
  if (entry === 'from-personality') return "Inherits this personality's reach";
  if (entry.length === 0) return 'None';
  return <Mono>{entry.join(', ')}</Mono>;
}

function capabilityRows(caps: ToolDetail['capabilities']): { label: string; value: ReactNode }[] {
  const rows: { label: string; value: ReactNode }[] = [];
  if (caps.network) {
    rows.push({
      label: 'Network',
      value:
        caps.network.allowedHosts.length > 0 ? (
          <Mono>{caps.network.allowedHosts.join(', ')}</Mono>
        ) : (
          'No hosts allowed'
        ),
    });
  }
  if (caps.secrets) {
    rows.push({
      label: 'Secrets',
      value: caps.secrets.length > 0 ? <Mono>{caps.secrets.join(', ')}</Mono> : 'None',
    });
  }
  if (caps.storage) {
    const ttl = caps.storage.ttlSecondsDefault;
    rows.push({
      label: 'Storage',
      value: (
        <Mono>
          {caps.storage.scope} · {caps.storage.kind}
          {ttl === undefined ? '' : ` · ttl ${ttl}s`}
        </Mono>
      ),
    });
  }
  const read = reachValue(caps.fs_reach?.read);
  if (read !== null) rows.push({ label: 'Reads', value: read });
  const write = reachValue(caps.fs_reach?.write);
  if (write !== null) rows.push({ label: 'Writes', value: write });
  if (caps.process) {
    rows.push({
      label: 'Process',
      value:
        caps.process.allowedBinaries.length > 0 ? (
          <Mono>{caps.process.allowedBinaries.join(', ')}</Mono>
        ) : (
          'No binaries allowed'
        ),
    });
  }
  if (caps.attachments) {
    const kinds = caps.attachments.kinds;
    rows.push({
      label: 'Attachments',
      value: kinds === '*' ? 'Any kind' : kinds.join(', '),
    });
  }
  return rows;
}

function behaviourRows(detail: ToolDetail): { label: string; value: ReactNode }[] {
  const rows: { label: string; value: ReactNode }[] = [];
  if (detail.maxResultChars !== undefined) {
    rows.push({
      label: 'Max result',
      value: <Mono>{detail.maxResultChars.toLocaleString('en-US')} chars</Mono>,
    });
  }
  if (detail.requiresApproval) {
    rows.push({ label: 'Approval', value: 'Required before every call' });
  }
  if (detail.outputIsUntrusted) {
    rows.push({ label: 'Output', value: 'Treated as untrusted input' });
  }
  if (detail.alwaysInclude) {
    rows.push({ label: 'Inclusion', value: 'Always included, regardless of toolset' });
  }
  if (detail.returnDirect) {
    rows.push({ label: 'Return', value: 'Sent straight to the user, ending the turn' });
  }
  if (detail.hasSettingsSchema) {
    rows.push({
      label: 'Settings',
      value: "Configurable — set values under Tool settings on this personality's page",
    });
  }
  return rows;
}

const CHECK_ICON: Record<ToolCheck['status'], ReactNode> = {
  pass: <CheckCircleOutlined style={{ color: 'var(--ethos-success)' }} />,
  fail: <CloseCircleOutlined style={{ color: 'var(--ethos-error)' }} />,
  skip: <MinusCircleOutlined style={{ color: 'var(--ethos-text-tertiary)' }} />,
};

function CheckRow({ check }: { check: ToolCheck }) {
  // The `args-valid` pass carries the generated sample arguments as JSON —
  // that is code, and reads as noise in prose.
  const detailIsCode = check.id === 'args-valid' && check.status === 'pass';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
      <span style={{ lineHeight: '20px' }}>{CHECK_ICON[check.status]}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ lineHeight: '20px' }}>{check.label}</div>
        {check.detail === undefined ? null : detailIsCode ? (
          <div style={{ marginTop: 4 }}>
            <ScrollBlock>{check.detail}</ScrollBlock>
          </div>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
            {check.detail}
          </Typography.Text>
        )}
      </div>
    </div>
  );
}

function TestOutcome({ test }: { test: ToolTest }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {test.checks.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </div>
      {test.ran && test.result ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            {test.result.ok ? (
              <Tag icon={<CheckCircleOutlined />} color="success">
                Ran — ok
              </Tag>
            ) : (
              <Tag icon={<CloseCircleOutlined />} color="error">
                Ran — failed
              </Tag>
            )}
            {test.durationMs === undefined ? null : (
              <Typography.Text type="secondary">
                <Mono>{test.durationMs}ms</Mono>
              </Typography.Text>
            )}
            {test.result.code === undefined ? null : (
              <Typography.Text type="secondary">
                <Mono>{test.result.code}</Mono>
              </Typography.Text>
            )}
          </div>
          <ScrollBlock>{test.result.value ?? test.result.error ?? '(no output)'}</ScrollBlock>
        </div>
      ) : test.testEligibility.reason ? (
        <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
          Not executed — {test.testEligibility.reason}
        </Typography.Text>
      ) : null}
    </div>
  );
}

export interface ToolDetailModalProps {
  /** The tool name as written in the toolset — registered or not. */
  toolName: string;
  personalityId: string;
  onClose: () => void;
}

export function ToolDetailModal({ toolName, personalityId, onClose }: ToolDetailModalProps) {
  const detailQuery = useQuery({
    queryKey: ['tools', 'detail', toolName, personalityId],
    queryFn: () => rpc.tools.detail({ name: toolName, personalityId }),
  });

  // A mutation, never a query: this can EXECUTE the tool, so it fires only on
  // the button press. `mode` is always `'run'` — the server re-derives
  // eligibility and degrades to verify-only itself, and a client-side gate
  // here would be a second, weaker copy of that decision.
  const testMut = useMutation({
    mutationFn: () => rpc.tools.test({ name: toolName, personalityId, mode: 'run' }),
  });

  const detail = detailQuery.data;
  const eligibility = detailQuery.data?.testEligibility;
  const canRun = eligibility?.canRun === true;
  const capRows = detail ? capabilityRows(detail.capabilities) : [];
  const behRows = detail ? behaviourRows(detail) : [];
  const schemaText = detail ? JSON.stringify(detail.schema, null, 2) : '';
  const hasSchema = detail ? Object.keys(detail.schema).length > 0 : false;

  return (
    <Modal open title={null} onCancel={onClose} footer={null} width={720}>
      {detailQuery.isLoading || !detail ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          {detailQuery.error ? (
            <Alert
              type="error"
              showIcon
              message="Could not load this tool"
              description={(detailQuery.error as Error).message}
            />
          ) : (
            <Spin />
          )}
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 500 }}>{detail.name}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              {detail.group}
            </Typography.Text>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {detail.registered ? (
              <Tag icon={<CheckCircleOutlined />} color="success">
                Registered
              </Tag>
            ) : (
              <Tag icon={<CloseCircleOutlined />} color="error">
                Not registered
              </Tag>
            )}
            {detail.available ? (
              <Tag icon={<CheckCircleOutlined />} color="success">
                Available
              </Tag>
            ) : (
              <Tag icon={<CloseCircleOutlined />} color="warning">
                Unavailable
              </Tag>
            )}
            {detail.inPersonalityToolset === undefined ? null : detail.inPersonalityToolset ? (
              <Tag icon={<CheckCircleOutlined />}>In toolset</Tag>
            ) : (
              <Tag icon={<MinusCircleOutlined />}>Not in toolset</Tag>
            )}
            {detail.pluginId === undefined ? null : <Tag>Plugin: {detail.pluginId}</Tag>}
          </div>

          {!detail.registered && detail.inPersonalityToolset === true ? (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 16 }}
              message="This personality lists a tool this deployment does not have"
              description={`No tool named "${detail.name}" is registered here, so the agent never sees it and silently cannot call it. Remove it from the toolset, or install the extension or plugin that provides it.`}
            />
          ) : null}
          {detail.registered && !detail.available ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 16 }}
              message="Registered, but unavailable in this deployment"
              description="The tool reports itself unavailable — a required key, binary, or service is missing. It is filtered out before the agent sees it, so calls silently never happen."
            />
          ) : null}

          <div style={{ marginTop: 16, fontSize: 13 }}>
            {detail.description ? (
              detail.description
            ) : (
              <Typography.Text type="secondary">
                No description — nothing is registered under this name.
              </Typography.Text>
            )}
          </div>

          {behRows.length > 0 ? (
            <>
              <SectionLabel>Behaviour</SectionLabel>
              <Facts rows={behRows} />
            </>
          ) : null}

          <SectionLabel>Capabilities</SectionLabel>
          {capRows.length > 0 ? (
            <Facts rows={capRows} />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              Declares no capabilities.
            </Typography.Text>
          )}

          <SectionLabel>Schema</SectionLabel>
          {hasSchema ? (
            <ScrollBlock>{schemaText}</ScrollBlock>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
              No schema.
            </Typography.Text>
          )}

          <SectionLabel>Verification</SectionLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Button type="primary" loading={testMut.isPending} onClick={() => testMut.mutate()}>
              {canRun ? 'Test — runs the tool' : 'Verify'}
            </Button>
            {!canRun && eligibility?.reason ? (
              <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                Checks only — {eligibility.reason}
              </Typography.Text>
            ) : null}
          </div>
          {testMut.error ? (
            <Alert
              type="error"
              showIcon
              style={{ marginTop: 12 }}
              message="Test failed to run"
              description={(testMut.error as Error).message}
            />
          ) : null}
          {testMut.data ? <TestOutcome test={testMut.data} /> : null}
        </div>
      )}
    </Modal>
  );
}
