import type { ExecutionPostureWire } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Select, Spin, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import {
  DEFAULT_OVERRIDE,
  edgeState,
  type OverrideMode,
  overrideOptions,
  postureBadge,
  postureColorVar,
  postureWhy,
} from '../../lib/execution-posture';
import { rpc } from '../../rpc';

// Phase 2a, lane E2 — the Execution tab in the personality editor. Posture is
// resolved server-side (`buildExecutionPosture`) and arrives on the
// `personalities.characterSheet` RPC; this tab renders it, never recomputes it.
// Boundary fields are read-only here — they derive from Filesystem reach /
// Network, which are edited on their own tabs (single source of truth).

const MONO = 'Geist Mono, monospace';

function PostureBadge({ posture }: { posture: ExecutionPostureWire }) {
  const badge = postureBadge(posture);
  const color = postureColorVar(badge.variant);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {/* icon + text — status is never colour-alone (DESIGN.md). */}
      <span aria-hidden style={{ color, fontSize: 16, lineHeight: 1 }}>
        {badge.icon}
      </span>
      <Typography.Text strong style={{ color, fontSize: 15 }}>
        {badge.label}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        (computed)
      </Typography.Text>
    </div>
  );
}

function BoundaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {label}
      </Typography.Text>
      <div style={{ fontSize: 13 }}>{children}</div>
    </>
  );
}

function BoundaryBlock({ posture }: { posture: ExecutionPostureWire }) {
  const rwRoots = posture.mounts.filter((m) => m.mode === 'rw');
  return (
    <div
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: '12px 16px',
        marginTop: 16,
      }}
    >
      <Typography.Text strong style={{ fontSize: 12, letterSpacing: '0.04em' }}>
        BOUNDARY
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
        derived — read-only
      </Typography.Text>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '6px 20px',
          marginTop: 10,
        }}
      >
        <BoundaryRow label="Mounts">
          {posture.mounts.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {posture.backend === 'docker'
                ? 'default — personality directory + cwd'
                : 'not mount-confined in this posture'}
            </Typography.Text>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {posture.mounts.map((m) => (
                <span key={`${m.hostPath}:${m.mode}`} style={{ fontFamily: MONO, fontSize: 12.5 }}>
                  {m.hostPath} <span style={{ color: 'var(--text-secondary)' }}>{m.mode}</span>
                </span>
              ))}
            </div>
          )}
          {posture.scratchPaths.map((p) => (
            <div
              key={p}
              style={{ fontFamily: MONO, fontSize: 12.5, color: 'var(--text-secondary)' }}
            >
              + {p} (ephemeral scratch, wiped on exit)
            </div>
          ))}
        </BoundaryRow>

        <BoundaryRow label="Network">
          {posture.networkMode === 'none'
            ? '◇ Deny-all (shell is air-gapped)'
            : 'Allow-all (open egress)'}
        </BoundaryRow>

        <BoundaryRow label="Memory cap">{`${posture.memoryMb} MB`}</BoundaryRow>

        <BoundaryRow label="Env">clean — API keys are NOT visible in the shell</BoundaryRow>

        {rwRoots.length > 0 ? (
          <BoundaryRow label="Write reach">
            <span style={{ fontFamily: MONO, fontSize: 12.5 }}>
              {rwRoots.map((m) => m.hostPath).join(', ')}
            </span>
          </BoundaryRow>
        ) : null}
      </div>

      <Typography.Paragraph
        type="secondary"
        style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}
      >
        These derive from Filesystem reach + Network. Edit them on the Config tab.
      </Typography.Paragraph>
    </div>
  );
}

// Edge state A — Docker required but not running. Blocking, never silent.
function DockerAbsentSection({
  canConsentLocal,
  consentForbiddenReason,
}: {
  canConsentLocal: boolean;
  consentForbiddenReason?: string;
}) {
  const consentButton = (
    <Button danger disabled={!canConsentLocal}>
      Run un-sandboxed on host ⚠
    </Button>
  );
  return (
    <Alert
      type="error"
      showIcon
      style={{ marginBottom: 16 }}
      message="This personality needs Docker to run its tools safely"
      description={
        <div>
          <Typography.Paragraph style={{ marginBottom: 12 }}>
            Docker isn’t running on this machine. Tools will not run until you install Docker or
            explicitly choose to run un-sandboxed.
          </Typography.Paragraph>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              type="primary"
              href="https://docs.docker.com/get-docker/"
              target="_blank"
              rel="noreferrer"
            >
              Install Docker
            </Button>
            {canConsentLocal ? (
              consentButton
            ) : (
              <Tooltip
                title={
                  consentForbiddenReason ?? 'The operator constitution forbids local execution.'
                }
              >
                {consentButton}
              </Tooltip>
            )}
          </div>
          {!canConsentLocal ? (
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: 'block', marginTop: 8 }}
            >
              {consentForbiddenReason ?? 'The operator constitution forbids local execution.'}
            </Typography.Text>
          ) : null}
        </div>
      }
    />
  );
}

// Edge state B — Ethos itself runs inside a container. Calm info, no action.
function ContainerizedNote() {
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 16 }}
      message="Ethos is running inside a container"
      description="Tools run here — the container is the boundary. Per-personality file and network limits are enforced in-app (not as separate mounts)."
    />
  );
}

export function ExecutionTab({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['personalities', 'characterSheet', id],
    queryFn: () => rpc.personalities.characterSheet({ id }),
  });
  // Override is editor-local for now — the resolver owns the effective posture;
  // persisting an explicit override is a follow-up. Defaults to Auto.
  const [override, setOverride] = useState<OverrideMode>(DEFAULT_OVERRIDE);

  if (isLoading || !data) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 240 }}>
        <Spin />
      </div>
    );
  }

  const { posture } = data;
  if (!posture) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Execution posture unavailable"
        description="The server could not resolve this personality’s execution posture (no data directory wired)."
      />
    );
  }

  const edge = edgeState(posture);
  const options = overrideOptions(posture);

  return (
    <div>
      {edge.kind === 'docker-absent' ? (
        <DockerAbsentSection
          canConsentLocal={edge.canConsentLocal}
          {...(edge.consentForbiddenReason !== undefined
            ? { consentForbiddenReason: edge.consentForbiddenReason }
            : {})}
        />
      ) : null}
      {edge.kind === 'containerized' ? <ContainerizedNote /> : null}

      <PostureBadge posture={posture} />

      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 16 }}>
        {postureWhy(posture)}
      </Typography.Paragraph>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Typography.Text style={{ fontSize: 13 }}>Posture</Typography.Text>
        <Select<OverrideMode>
          value={override}
          onChange={setOverride}
          style={{ width: 200 }}
          options={options.map((o) => ({
            value: o.value,
            label: o.disabledReason ? `${o.label} — forbidden` : o.label,
            disabled: o.disabledReason !== undefined,
          }))}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Auto = Docker (recommended)
        </Typography.Text>
      </div>
      {/* No save bar here, and that is deliberate: nothing on this tab
          persists. Saying so beats a Save button that would write nothing. */}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
        Not saved. This selection changes what you see here only — the server resolves the effective
        posture, and a stored per-personality override is not implemented yet.
      </Typography.Paragraph>

      <BoundaryBlock posture={posture} />
    </div>
  );
}
