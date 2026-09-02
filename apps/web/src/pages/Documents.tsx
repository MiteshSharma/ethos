import { useQuery } from '@tanstack/react-query';
import { Empty, Popconfirm, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DocumentPreviewModal } from '../components/documents/DocumentPreviewModal';
import { DocumentsUnconfigured } from '../components/documents/DocumentsUnconfigured';
import { NewFolderPrompt } from '../components/documents/NewFolderPrompt';
import { RootSwitcher } from '../components/documents/RootSwitcher';
import { UploadDocumentModal } from '../components/documents/UploadDocumentModal';
import { PersonalitySelect } from '../components/personality/PersonalitySelect';
import { useCreateFolder, useDocumentDelete } from '../features/documents/api/mutations';
import {
  type DocumentEntry,
  useDocumentsList,
  useDocumentsRoot,
} from '../features/documents/api/queries';
import { useFavouritePersonality } from '../hooks/useFavouritePersonality';
import { formatBytes } from '../lib/attachments';
import {
  documentCrumbs,
  documentDownloadHref,
  documentRootOptions,
  documentRowActions,
  joinDocumentPath,
  newFolderNameError,
  sortDocumentEntries,
} from '../lib/documents';
import { resolvePersonalityId } from '../lib/favouritePersonality';
import { rpc } from '../rpc';

// Documents — the operator's view of the files the agent writes.
//
// Ethos usually runs on a headless box under a non-login user. The operator
// has no shell there, so this page is the only way to see, retrieve, or clear
// what the agent produced. It is rooted at the personality's declared
// `fs_reach.workdir`; SOUL.md / config.yaml / mcp.yaml are not on this surface.
//
// The personality selection is OWNED HERE, as component-local `useState`, not
// a shared store — this page threads its own id explicitly into every RPC
// call and into the download URL rather than assuming a global. P2
// (plan/phases/personality-first-ui.md): at `/p/:personalityId/documents` it
// defaults to — and stays in sync with — the route's id rather than the
// independently-remembered favourite; `documents.root`/`documents.list` take
// an optional `personalityId` (omitted = config default), so this is still no
// backend change.

export function Documents() {
  const { personalityId: routePersonalityId } = useParams<{ personalityId?: string }>();
  const [personalityId, setPersonalityId] = useState<string | null>(routePersonalityId ?? null);
  useEffect(() => {
    if (routePersonalityId) setPersonalityId(routePersonalityId);
  }, [routePersonalityId]);
  const { favouriteId, toggleFavourite } = useFavouritePersonality();

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  const personalities = personalitiesQuery.data?.items ?? [];
  const effectiveId = resolvePersonalityId({
    selectedId: personalityId,
    favouriteId,
    defaultId: personalitiesQuery.data?.defaultId ?? null,
    available: personalities.map((p) => p.id),
  });

  return (
    <div className="documents-tab">
      <header className="page-header-row">
        <h1 className="page-h1">Documents</h1>
        <div style={{ flex: 1 }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Personality
        </Typography.Text>
        <PersonalitySelect
          personalities={personalities}
          value={effectiveId}
          onChange={setPersonalityId}
          loading={personalitiesQuery.isLoading}
          favouriteId={favouriteId}
          onToggleFavourite={toggleFavourite}
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
  // Which declared root is being browsed. `null` means "whatever the first
  // declared root turns out to be" — the roots are not known until
  // `documents.root` answers, and defaulting there rather than in an effect
  // avoids a render pass against a root that does not exist.
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  // The row being previewed. Rendered conditionally rather than kept mounted
  // with `open={false}` so closing unmounts the modal, which is what revokes
  // any object URL it created.
  const [preview, setPreview] = useState<DocumentEntry | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);

  const rootQuery = useDocumentsRoot(personalityId);
  const roots = rootQuery.data?.roots ?? [];
  // A stale id (the personality's config changed under us) falls back to the
  // first declared root rather than asking for a root the backend will refuse.
  const activeRoot = roots.find((r) => r.id === selectedRoot) ?? roots[0] ?? null;
  const rootId = activeRoot?.id ?? '';

  const listQuery = useDocumentsList(personalityId, activeRoot ? rootId : null, path);
  const deleteMut = useDocumentDelete(personalityId, rootId);
  const createFolder = useCreateFolder(personalityId, rootId);

  const root = activeRoot?.path ?? '';
  const rootLabel = documentRootOptions(roots).find((o) => o.id === rootId)?.label ?? 'root';
  const entries = sortDocumentEntries(listQuery.data?.entries ?? []);
  const crumbs = documentCrumbs(path, rootLabel || 'root');

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
  // An empty roots list is the "unconfigured" answer, not an error and not an
  // empty folder — every other Documents call refuses with
  // WORKDIR_NOT_CONFIGURED in this state, so there is nothing to browse.
  if (!activeRoot) {
    return (
      <DocumentsUnconfigured
        personalityId={personalityId}
        identityHref={`/p/${personalityId}/identity`}
      />
    );
  }

  function submitFolder() {
    const invalid = newFolderNameError(folderName);
    if (invalid) {
      setFolderError(invalid);
      return;
    }
    setFolderError(null);
    createFolder.mutate(joinDocumentPath(path, folderName.trim()), {
      onSuccess: () => {
        setFolderOpen(false);
        setFolderName('');
      },
      onError: (err) => setFolderError((err as Error).message),
    });
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
        if (!actions.canDownload && !actions.canDelete) return null;
        return (
          // The row itself opens the preview, so the actions cell has to stop
          // the click and the Enter key here — downloading or deleting must
          // not also open a preview of the same file.
          <div
            role="toolbar"
            aria-label={`Actions for ${entry.name}`}
            style={{ display: 'flex', gap: 12, alignItems: 'center' }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {actions.canDownload ? (
              <a
                className="documents-action"
                href={documentDownloadHref(personalityId, rootId, entry.path)}
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
      <RootSwitcher
        roots={roots}
        value={rootId}
        onChange={(id) => {
          setSelectedRoot(id);
          // The browsed path belongs to the root it was browsed in — carrying
          // it across would point at a subdirectory the new root need not have.
          setPath('');
          setFolderOpen(false);
        }}
      />

      <div className="documents-rootline">
        <span className="documents-mono">{root}</span>
        <div className="documents-toolbar">
          <button
            type="button"
            className="documents-action"
            onClick={() => {
              setFolderError(null);
              setFolderOpen(true);
            }}
          >
            New folder
          </button>
          <button type="button" className="documents-action" onClick={() => setUploadOpen(true)}>
            Upload
          </button>
        </div>
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

      {folderOpen ? (
        <div className="documents-newfolder-slot">
          <NewFolderPrompt
            value={folderName}
            onChange={(value) => {
              setFolderName(value);
              setFolderError(null);
            }}
            onSubmit={submitFolder}
            onCancel={() => {
              setFolderOpen(false);
              setFolderName('');
              setFolderError(null);
            }}
            busy={createFolder.isPending}
            error={folderError}
            parentLabel={path}
          />
        </div>
      ) : null}

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
          onRow={(entry) => {
            // Directories keep their existing behaviour — the name button
            // navigates. Symlinks stay inert: preview reads bytes through the
            // download route, which refuses them.
            if (!documentRowActions(entry).canPreview) return {};
            return {
              className: 'documents-row--previewable',
              tabIndex: 0,
              onClick: () => setPreview(entry),
              onKeyDown: (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                setPreview(entry);
              },
            };
          }}
        />
      )}

      {preview ? (
        <DocumentPreviewModal
          key={preview.path}
          personalityId={personalityId}
          root={rootId}
          entry={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}

      {uploadOpen ? (
        <UploadDocumentModal
          personalityId={personalityId}
          root={rootId}
          rootLabel={rootLabel}
          initialPath={path}
          onClose={() => setUploadOpen(false)}
        />
      ) : null}
    </>
  );
}

/** `YYYY-MM-DD HH:MM` in local time — same shape the Memory timeline uses. */
function formatModified(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
