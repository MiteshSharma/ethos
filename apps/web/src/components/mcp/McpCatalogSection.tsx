import type { McpAddServerInput, McpRemotePresetInfo } from '@ethosagent/web-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Spin, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useMcpCatalog } from '../../features/mcp/api/queries';
import { authBadgeLabel, buildRemoteSubmission, groupByCategory } from '../../features/mcp/catalog';
import { useMcpOAuthPopup } from '../../features/mcp/useMcpOAuthPopup';
import { splitByAttachment } from '../../lib/attachmentLists';
import { rpc } from '../../rpc';
import { McpSectionLabel } from './McpSectionLabel';

interface Props {
  /** Names already registered globally — a catalog entry whose `name` is in
   *  this set is omitted entirely (plan §2.3), not shown disabled. Callers
   *  pass the `['plugins','list']` query they already run; this component
   *  makes no query of its own for it. */
  registeredNames: Set<string>;
}

/**
 * The curated MCP catalog, rendered inline as dense rows (not a card grid —
 * DESIGN.md's "cards earn existence" rule, plan §2.1) with one click per
 * entry that either registers the server directly or starts OAuth. Shared by
 * `LibraryMcpPage` and `WorkspaceMcpPanel` (`apps/web/src/pages/Mcp.tsx`).
 */
export function McpCatalogSection({ registeredNames }: Props) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const catalog = useMcpCatalog(true);
  const [pendingName, setPendingName] = useState<string | null>(null);

  const remotePresets: McpRemotePresetInfo[] = catalog.data?.remote ?? [];
  const { notAttached: available } = splitByAttachment(
    remotePresets,
    registeredNames,
    (p) => p.name,
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['plugins'] });
    qc.invalidateQueries({ queryKey: ['mcp', 'list'] });
  };

  const addServerMutation = useMutation({
    mutationFn: (input: McpAddServerInput) => rpc.mcp.addServer(input),
    onSuccess: (result) => {
      setPendingName(null);
      if (!result.ok) {
        notification.error({
          message: 'Registration failed',
          description: ('detail' in result ? result.detail : result.code) ?? 'Failed to add server',
        });
        return;
      }
      invalidate();
      notification.success({ message: `${result.serverName} registered` });
    },
    onError: (err) => {
      setPendingName(null);
      notification.error({
        message: 'Registration failed',
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  // No `personalityId` — a catalog click only ever writes to the global
  // registry, never attaches a personality (product decision 1, plan §4).
  const oauth = useMcpOAuthPopup({
    onSuccess: (serverName) => {
      setPendingName(null);
      invalidate();
      notification.success({ message: `${serverName} registered` });
    },
    onError: (message) => {
      setPendingName(null);
      notification.error({ message: 'Registration failed', description: message });
    },
  });

  const handleClick = (preset: McpRemotePresetInfo) => {
    setPendingName(preset.name);
    if (preset.authType === 'oauth') {
      // `name` set explicitly to the preset's own name — omitting it lets
      // the server derive a name from the URL instead, which would break
      // this section's own "already registered" filter on the next load
      // (plan §1.2/§2.2).
      oauth.start({ url: preset.url, name: preset.name });
      return;
    }
    const submission = buildRemoteSubmission(preset, '');
    if (submission.kind === 'addServer') addServerMutation.mutate(submission.input);
  };

  if (catalog.isLoading) {
    return (
      <>
        <McpSectionLabel>Catalog</McpSectionLabel>
        <div style={{ display: 'grid', placeItems: 'center', height: 80 }}>
          <Spin />
        </div>
      </>
    );
  }

  if (catalog.isError || available.length === 0) {
    return null;
  }

  return (
    <>
      <McpSectionLabel>Catalog ({available.length})</McpSectionLabel>
      {groupByCategory(available).map((group) => (
        <div key={group.category} style={{ marginBottom: 12 }}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, fontWeight: 500, display: 'block', margin: '8px 0 4px' }}
          >
            {group.category}
          </Typography.Text>
          {group.items.map((preset) => (
            <div
              key={preset.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 0',
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong>{preset.label}</strong>
                  <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                    {authBadgeLabel(preset.authType)}
                  </Tag>
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {preset.description}
                </Typography.Text>
              </div>
              <Button
                size="small"
                loading={pendingName === preset.name}
                onClick={() => handleClick(preset)}
              >
                {preset.authType === 'oauth' ? 'Connect' : 'Add'}
              </Button>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
