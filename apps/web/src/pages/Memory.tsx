import type { MemoryFile, MemoryStoreId } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Input, Spin, Tabs, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { rpc } from '../rpc';

// Memory tab — v1.
//
// Edits the two markdown files MarkdownFileMemoryProvider reads:
//   • MEMORY.md — rolling project context
//   • USER.md   — who you are; persists across personalities + sessions
//
// Vector-mode chunk CRUD is out of scope for this commit. The Settings
// tab toggles between markdown and vector providers; when vector is
// active these files exist but the agent loop ignores them. The page
// shows a hint pointing the user back to Settings in that case.
//
// Search across both files is local-only (a substring filter on the
// active file's content) — the vector retrieval is the agent loop's
// path, not the editor's.

export function Memory() {
  const [activeStore, setActiveStore] = useState<MemoryStoreId>('memory');

  const listQuery = useQuery({
    queryKey: ['memory', 'list'],
    queryFn: () => rpc.memory.list(),
  });

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  if (listQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (listQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load memory: {(listQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const files = listQuery.data?.files ?? [];
  const fileByStore = new Map(files.map((f) => [f.store, f] as const));
  const memoryMode = configQuery.data?.memory ?? 'markdown';

  return (
    <div className="memory-tab">
      {memoryMode === 'vector' ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          Vector mode is active — the agent uses semantic chunks, not these files. Switch to{' '}
          <code>markdown</code> mode in Settings if you want edits here to flow back to the agent.
        </Typography.Paragraph>
      ) : null}

      <Tabs
        activeKey={activeStore}
        onChange={(k) => setActiveStore(k as MemoryStoreId)}
        items={[
          {
            key: 'memory',
            label: 'MEMORY.md',
            children: <MemoryEditor store="memory" file={fileByStore.get('memory') ?? null} />,
          },
          {
            key: 'user',
            label: 'USER.md',
            children: <MemoryEditor store="user" file={fileByStore.get('user') ?? null} />,
          },
        ]}
      />
    </div>
  );
}

function MemoryEditor({ store, file }: { store: MemoryStoreId; file: MemoryFile | null }) {
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();
  const [draft, setDraft] = useState(file?.content ?? '');
  const [search, setSearch] = useState('');

  // Re-hydrate when the upstream file changes (mode switch, refresh).
  useEffect(() => {
    setDraft(file?.content ?? '');
  }, [file]);

  const writeMut = useMutation({
    mutationFn: (content: string) => rpc.memory.write({ store, content }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['memory', 'list'] });
      notification.success({ message: 'Saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const dirty = draft !== (file?.content ?? '');
  const matchCount = search ? countMatches(draft, search) : 0;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      notification.info({ message: 'Copied to clipboard', placement: 'topRight' });
    } catch (err) {
      notification.error({ message: 'Copy failed', description: (err as Error).message });
    }
  };

  const onRevert = () => {
    if (!dirty) return;
    modal.confirm({
      title: 'Discard local edits?',
      content: 'Your unsaved changes will be lost.',
      okText: 'Discard',
      okButtonProps: { danger: true },
      onOk: () => setDraft(file?.content ?? ''),
    });
  };

  return (
    <div className="memory-editor">
      <header className="memory-toolbar">
        <span className="memory-meta">
          {file?.path ? (
            <Tooltip title={file.path}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {file.path.replace(/^.+\/(?=[^/]+$)/, '')}
              </Typography.Text>
            </Tooltip>
          ) : null}
          {file?.modifiedAt ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              · edited {formatRelative(file.modifiedAt)}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              · not yet written
            </Typography.Text>
          )}
        </span>
        <Input
          placeholder="Search…"
          allowClear
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 220 }}
          suffix={
            search ? (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {matchCount} match{matchCount === 1 ? '' : 'es'}
              </Typography.Text>
            ) : null
          }
        />
      </header>

      <Input.TextArea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoSize={{ minRows: 18, maxRows: 36 }}
        style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5, marginTop: 12 }}
        placeholder={
          store === 'memory'
            ? '# Project context\n\nNotes the agent reads each turn. Edits land in ~/.ethos/MEMORY.md.'
            : '# About me\n\nWho you are, what you build, how you work. Edits land in ~/.ethos/USER.md.'
        }
      />

      <footer className="memory-actions">
        <Button onClick={onCopy}>Copy</Button>
        <Button onClick={onRevert} disabled={!dirty}>
          Revert
        </Button>
        <Button
          type="primary"
          onClick={() => writeMut.mutate(draft)}
          loading={writeMut.isPending}
          disabled={!dirty}
        >
          Save
        </Button>
      </footer>
    </div>
  );
}

function countMatches(text: string, q: string): number {
  if (!q) return 0;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let count = 0;
  let idx = lower.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = lower.indexOf(needle, idx + needle.length);
  }
  return count;
}

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
