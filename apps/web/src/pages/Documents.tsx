import { useQuery } from '@tanstack/react-query';
import { Empty, Popconfirm, Select, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { useDocumentDelete } from '../features/documents/api/mutations';
import {
  type DocumentEntry,
  useDocumentsList,
  useDocumentsRoot,
} from '../features/documents/api/queries';
import { formatBytes } from '../lib/attachments';
import {
  documentCrumbs,
  documentDownloadHref,
  documentRowActions,
  sortDocumentEntries,
} from '../lib/documents';
import { rpc } from '../rpc';

// Documents — the operator's view of the files the agent writes.
//
// Ethos usually runs on a headless box under a non-login user. The operator
// has no shell there, so this page is the only way to see, retrieve, or clear
// what the agent produced. It is rooted at the personality's declared
// `fs_reach.workdir`; SOUL.md / config.yaml / mcp.yaml are not on this surface.
//
// The personality selection is OWNED HERE. `useActivePersonality`'s override
// is component-local `useState`, not a shared store, so this page threads its
// own id explicitly into every RPC call and into the download URL rather than
// assuming a global.

export function Documents() {
  const [personalityId, setPersonalityId] = useState<string | null>(null);

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  const effectiveId = personalityId ?? personalitiesQuery.data?.defaultId ?? null;
  const personalities = personalitiesQuery.data?.items ?? [];

  return (
    <div className="documents-tab">
      <header className="page-header-row">
        <h1 className="page-h1">Documents</h1>
        <div style={{ flex: 1 }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Personality
        </Typography.Text>
        <Select
          size="small"
          style={{ width: 200 }}
          value={effectiveId ?? undefined}
          onChange={setPersonalityId}
          loading={personalitiesQuery.isLoading}
          options={personalities.map((p) => ({ value: p.id, label: p.name }))}
        />
      </header>

      {personalitiesQuery.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      ) : personalitiesQuery.error ? (
        <Typography.Text type="danger">
          Failed to load personalities: {(personalitiesQuery.error as Error).message}
        </Typography.Text>
      ) : effectiveId ? (
        // Remount on personality change so the browsed path resets to the
        // new root instead of pointing at a subdirectory that may not exist.
        <Browser key={effectiveId} personalityId={effectiveId} />
      ) : (
        <Typography.Text type="secondary">No personalities loaded.</Typography.Text>
      )}
    </div>
  );
}

function Browser({ personalityId }: { personalityId: string }) {
  const [path, setPath] = useState('');

  const rootQuery = useDocumentsRoot(personalityId);
  const listQuery = useDocumentsList(personalityId, path);
  const deleteMut = useDocumentDelete(personalityId);

  const root = rootQuery.data?.root ?? '';
  const entries = sortDocumentEntries(listQuery.data?.entries ?? []);
  const crumbs = documentCrumbs(path, basename(root) || 'root');

  if (rootQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (rootQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to resolve the workdir: {(rootQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const columns = [
    {
      title: 'Name',
      key: 'name',
      render: (_: unknown, entry: DocumentEntry) =>
        entry.isDir && !entry.isSymlink ? (
          <button type="button" className="documents-dir-btn" onClick={() => setPath(entry.path)}>
            {entry.name}/
          </button>
        ) : (
          <span>
            {entry.name}
            {entry.isSymlink ? (
              <Tooltip title="Symlinks can point outside the workdir, so they are listed but never served.">
                <Tag style={{ marginInlineStart: 8 }}>symlink</Tag>
              </Tooltip>
            ) : null}
          </span>
        ),
    },
    {
      title: 'Size',
      key: 'size',
      width: 110,
      align: 'right' as const,
      render: (_: unknown, entry: DocumentEntry) =>
        entry.isDir || entry.size === undefined ? (
          <span className="documents-dim">—</span>
        ) : (
          <span className="documents-mono">{formatBytes(entry.size)}</span>
        ),
    },
    {
      title: 'Modified',
      key: 'mtimeMs',
      width: 170,
      render: (_: unknown, entry: DocumentEntry) =>
        entry.mtimeMs === undefined ? (
          <span className="documents-dim">—</span>
        ) : (
          <span className="documents-mono">{formatModified(entry.mtimeMs)}</span>
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 190,
      render: (_: unknown, entry: DocumentEntry) => {
        // Directories and symlinks are refused by the backend on both
        // download and delete, so they get no buttons at all — a control
        // that always errors is worse than no control.
        const actions = documentRowActions(entry);
        return (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {actions.canDownload ? (
              <a
                className="documents-action"
                href={documentDownloadHref(personalityId, entry.path)}
                download={entry.name}
              >
                Download
              </a>
            ) : null}
            {actions.canDelete ? (
              <Popconfirm
                title={`Delete ${entry.name}?`}
                description="Removed from disk immediately. There is no trash — this cannot be undone from here."
                okText="Delete"
                okButtonProps={{ danger: true, loading: deleteMut.isPending }}
                cancelText="Cancel"
                onConfirm={() => deleteMut.mutate(entry.path)}
              >
                <button type="button" className="documents-action documents-action--danger">
                  Delete
                </button>
              </Popconfirm>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <div className="documents-rootline">
        <span className="documents-mono">{root}</span>
      </div>

      <nav className="documents-breadcrumb" aria-label="Directory path">
        {crumbs.map((crumb, i) =>
          i === crumbs.length - 1 ? (
            <span key={crumb.path} className="documents-crumb documents-crumb--current">
              {crumb.label}
            </span>
          ) : (
            <span key={crumb.path}>
              <button type="button" className="documents-crumb" onClick={() => setPath(crumb.path)}>
                {crumb.label}
              </button>
              <span className="documents-crumb-sep">/</span>
            </span>
          ),
        )}
      </nav>

      {/* The breadcrumb stays mounted through a directory change — it is the
          only way back to the root, so it must not vanish behind a spinner. */}
      {listQuery.error ? (
        <Typography.Text type="danger">
          Failed to list {path || root}: {(listQuery.error as Error).message}
        </Typography.Text>
      ) : (
        <Table<DocumentEntry>
          rowKey="path"
          dataSource={entries}
          loading={listQuery.isLoading}
          pagination={false}
          size="small"
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  path
                    ? 'Empty directory.'
                    : `Nothing in ${root} yet. Files the agent writes with a relative path land here.`
                }
              />
            ),
          }}
          columns={columns}
        />
      )}
    </>
  );
}

/** Last segment of an absolute path — the root crumb's label. */
function basename(absolutePath: string): string {
  const trimmed = absolutePath.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** `YYYY-MM-DD HH:MM` in local time — same shape the Memory timeline uses. */
function formatModified(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
