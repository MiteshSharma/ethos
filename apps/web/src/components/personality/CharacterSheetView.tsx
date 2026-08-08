import type { ExecutionPostureWire, Personality } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Spin, Tag, Tooltip, Typography } from 'antd';
import { useMemo } from 'react';
import { useToolCatalog } from '../../features/settings/api/queries';
import { postureBadge, postureColorVar, postureWhy } from '../../lib/execution-posture';
import { rpc } from '../../rpc';

// The personality character sheet rendered as structured UI sections — the same
// information `renderCharacterSheet` produces as Markdown, but laid out with
// Typography + Tag instead of a <pre> dump. Most sections read straight off the
// typed `Personality`; the Sandbox section reads the resolved execution posture
// from the `personalities.characterSheet` RPC (shares the ExecutionTab cache).

const MONO = 'Geist Mono, monospace';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography.Text
      type="secondary"
      style={{ fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase' }}
    >
      {children}
    </Typography.Text>
  );
}

const dim = (text: string) => (
  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
    {text}
  </Typography.Text>
);

export function CharacterSheetView({ personality }: { personality: Personality }) {
  const { data: sheet, isLoading } = useQuery({
    queryKey: ['personalities', 'characterSheet', personality.id],
    queryFn: () => rpc.personalities.characterSheet({ id: personality.id }),
  });

  const { data: catalog } = useToolCatalog();
  const toolDescriptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of catalog?.groups ?? []) {
      for (const tool of g.tools) {
        if (typeof tool.description === 'string' && tool.description.length > 0) {
          map.set(tool.name, tool.description);
        }
      }
    }
    return map;
  }, [catalog]);

  const m = personality.model;
  const modelDisplay =
    typeof m === 'string'
      ? m
      : m
        ? (m.default ?? m.trivial ?? m.deep ?? '(engine default)')
        : '(engine default)';
  const providerDisplay = personality.provider ?? '(engine default)';

  const caps = personality.capabilities ?? [];
  const toolset = personality.toolset ?? [];
  const servers = personality.mcp_servers ?? [];
  const plugins = personality.plugins ?? [];
  const read = personality.fs_reach?.read ?? [];
  const write = personality.fs_reach?.write ?? [];

  const posture = sheet?.posture ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <section style={{ marginBottom: 20 }}>
        <SectionLabel>Routing</SectionLabel>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '4px 16px',
            marginTop: 6,
            fontSize: 13,
          }}
        >
          <Typography.Text type="secondary">Model</Typography.Text>
          <Typography.Text code>{modelDisplay}</Typography.Text>
          <Typography.Text type="secondary">Provider</Typography.Text>
          <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{providerDisplay}</span>
        </div>
      </section>

      <section style={{ marginBottom: 20 }}>
        <SectionLabel>Capabilities</SectionLabel>
        {caps.length === 0 ? (
          <div style={{ marginTop: 6 }}>{dim('(none)')}</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {caps.map((c) => (
              <Tag key={c}>{c}</Tag>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginBottom: 20 }}>
        <SectionLabel>Memory</SectionLabel>
        <div style={{ marginTop: 6 }}>
          <Typography.Text type="secondary" style={{ fontSize: 13, marginRight: 8 }}>
            Memory scope
          </Typography.Text>
          <span
            style={{ fontFamily: MONO, fontSize: 12.5 }}
          >{`personality:${personality.id}`}</span>
        </div>
      </section>

      <section style={{ marginBottom: 20 }}>
        <SectionLabel>Toolset</SectionLabel>
        {toolset.length === 0 ? (
          <div style={{ marginTop: 6 }}>{dim('(none)')}</div>
        ) : (
          <>
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, display: 'block', marginTop: 6, marginBottom: 6 }}
            >
              {toolset.length} tool{toolset.length === 1 ? '' : 's'}
            </Typography.Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {toolset.map((t) => (
                <Tooltip key={t} title={toolDescriptions.get(t) ?? 'No description available'}>
                  <Tag style={{ fontFamily: MONO, fontSize: 11 }}>{t}</Tag>
                </Tooltip>
              ))}
            </div>
          </>
        )}
      </section>

      <section style={{ marginBottom: 20 }}>
        <SectionLabel>MCP servers</SectionLabel>
        {servers.length === 0 ? (
          <div style={{ marginTop: 6 }}>{dim('(none)')}</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {servers.map((s) => (
              <Tag key={s} style={{ fontFamily: MONO, fontSize: 11 }}>
                {s}
              </Tag>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginBottom: 20 }}>
        <SectionLabel>Plugins</SectionLabel>
        {plugins.length === 0 ? (
          <div style={{ marginTop: 6 }}>{dim('(none)')}</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {plugins.map((p) => (
              <Tag key={p} style={{ fontFamily: MONO, fontSize: 11 }}>
                {p}
              </Tag>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginBottom: 20 }}>
        <SectionLabel>Filesystem reach</SectionLabel>
        {read.length === 0 && write.length === 0 ? (
          <div style={{ marginTop: 6 }}>
            {dim(
              '(default — read: own directory, ~/.ethos/skills/, working directory; write: own directory, working directory)',
            )}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '4px 16px',
              marginTop: 6,
              fontSize: 13,
            }}
          >
            <Typography.Text type="secondary">Read</Typography.Text>
            {read.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {read.map((p) => (
                  <span key={p} style={{ fontFamily: MONO, fontSize: 12.5 }}>
                    {p}
                  </span>
                ))}
              </div>
            ) : (
              dim('(none)')
            )}
            <Typography.Text type="secondary">Write</Typography.Text>
            {write.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {write.map((p) => (
                  <span key={p} style={{ fontFamily: MONO, fontSize: 12.5 }}>
                    {p}
                  </span>
                ))}
              </div>
            ) : (
              dim('(none)')
            )}
          </div>
        )}
      </section>

      <section style={{ marginBottom: 20 }}>
        <SectionLabel>Sandbox</SectionLabel>
        {isLoading && !posture ? (
          <div style={{ marginTop: 6 }}>
            <Spin size="small" />
          </div>
        ) : posture === null ? (
          <div style={{ marginTop: 6 }}>{dim('Execution posture unavailable')}</div>
        ) : (
          <SandboxFacts posture={posture} />
        )}
      </section>
    </div>
  );
}

function SandboxFacts({ posture }: { posture: ExecutionPostureWire }) {
  const badge = postureBadge(posture);
  const color = postureColorVar(badge.variant);
  const rwRoots = posture.mounts.filter((mount) => mount.mode === 'rw');
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <span aria-hidden style={{ color, fontSize: 16, lineHeight: 1 }}>
          {badge.icon}
        </span>
        <Typography.Text strong style={{ color, fontSize: 14 }}>
          {badge.label}
        </Typography.Text>
      </div>
      <Typography.Paragraph
        type="secondary"
        style={{ fontSize: 13, marginTop: 8, marginBottom: 8 }}
      >
        {postureWhy(posture)}
      </Typography.Paragraph>
      <div
        style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: 13 }}
      >
        <Typography.Text type="secondary">Network</Typography.Text>
        <span>
          {posture.networkMode === 'none' ? 'Deny-all (air-gapped)' : 'Allow-all (open egress)'}
        </span>
        <Typography.Text type="secondary">Memory cap</Typography.Text>
        <span>{`${posture.memoryMb} MB`}</span>
        {rwRoots.length > 0 ? (
          <>
            <Typography.Text type="secondary">Write reach</Typography.Text>
            <span style={{ fontFamily: MONO, fontSize: 12.5 }}>
              {rwRoots.map((mount) => mount.hostPath).join(', ')}
            </span>
          </>
        ) : null}
      </div>
    </>
  );
}
