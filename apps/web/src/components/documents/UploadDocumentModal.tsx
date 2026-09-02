import { Button, Modal, Select, Typography } from 'antd';
import { useState } from 'react';
import {
  DocumentUploadError,
  useCreateFolder,
  useUploadDocument,
} from '../../features/documents/api/mutations';
import { useDocumentsList } from '../../features/documents/api/queries';
import {
  type DocumentUploadFailure,
  documentFolderOptions,
  joinDocumentPath,
  newFolderNameError,
} from '../../lib/documents';
import { NewFolderPrompt } from './NewFolderPrompt';

// Upload one file into the selected root.
//
// Native `<input type="file">`, single file: the route takes one raw body per
// request (no multipart parser exists in this app), so a multi-file picker
// would be a UI promise the backend does not keep.
//
// The destination picker is a NAVIGATOR, not a tree: its options are the
// current destination's ancestors, itself, and its immediate subfolders, all
// from the same `documents.list` query the page already runs (see
// `documentFolderOptions`). Picking a subfolder moves the destination there
// and the next level loads — usually from cache, because it is the same query
// key the page browses with. No folder-tree endpoint, and no recursive walk.
//
// Overwrite is never sent by default. The route refuses an existing file with
// a 409, and that refusal becomes a choice on screen — "Replace" retries the
// same upload with `overwrite=true` — rather than a silent clobber.

interface Props {
  personalityId: string;
  root: string;
  /** The selected root's short label, for the destination picker's root row. */
  rootLabel: string;
  /** The folder the page is browsing — the default destination. */
  initialPath: string;
  onClose: () => void;
}

export function UploadDocumentModal({
  personalityId,
  root,
  rootLabel,
  initialPath,
  onClose,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [filename, setFilename] = useState('');
  const [dest, setDest] = useState(initialPath);
  const [failure, setFailure] = useState<DocumentUploadFailure | null>(null);

  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState<string | null>(null);

  const listQuery = useDocumentsList(personalityId, root, dest);
  const createFolder = useCreateFolder(personalityId, root);
  const upload = useUploadDocument(personalityId, root);

  const options = documentFolderOptions(dest, listQuery.data?.entries ?? [], rootLabel);
  const name = filename.trim() || file?.name || '';
  const targetPath = name ? joinDocumentPath(dest, name) : '';

  function submit(overwrite: boolean) {
    if (!file || !targetPath) return;
    setFailure(null);
    upload.mutate(
      { file, path: targetPath, overwrite },
      {
        onSuccess: onClose,
        onError: (err) =>
          setFailure(
            err instanceof DocumentUploadError
              ? err.failure
              : { kind: 'other', message: err.message || 'Upload failed.' },
          ),
      },
    );
  }

  function createDestinationFolder() {
    const invalid = newFolderNameError(folderName);
    if (invalid) {
      setFolderError(invalid);
      return;
    }
    setFolderError(null);
    createFolder.mutate(joinDocumentPath(dest, folderName.trim()), {
      onSuccess: (entry) => {
        // Move the destination into the folder that was just created — the
        // only reason to create one from inside this modal is to upload into
        // it, so making the user then pick it would be a second step for a
        // decision already made.
        setDest(entry.path);
        setFolderOpen(false);
        setFolderName('');
      },
      onError: (err) => setFolderError((err as Error).message),
    });
  }

  return (
    <Modal
      open
      title="Upload file"
      onCancel={onClose}
      width={560}
      footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        failure?.kind === 'exists' ? (
          <Button key="replace" danger loading={upload.isPending} onClick={() => submit(true)}>
            Replace existing file
          </Button>
        ) : null,
        <Button
          key="upload"
          type="primary"
          loading={upload.isPending}
          disabled={!file || !name}
          onClick={() => submit(false)}
        >
          Upload
        </Button>,
      ]}
    >
      <div className="documents-upload">
        <label className="documents-upload-field">
          <span className="documents-upload-label">File</span>
          <input
            type="file"
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              setFile(picked);
              setFilename(picked?.name ?? '');
              setFailure(null);
            }}
          />
        </label>

        {/* A div, not a label: the destination is an antd Select, which is not
            a native form control for a `<label>` to be associated with. */}
        <div className="documents-upload-field">
          <span className="documents-upload-label" id="documents-upload-dest">
            Destination folder
          </span>
          <Select
            aria-labelledby="documents-upload-dest"
            value={dest}
            onChange={(value) => {
              setDest(value);
              setFailure(null);
            }}
            loading={listQuery.isLoading}
            options={options.map((option) => ({
              value: option.value,
              label: option.isCurrent ? `${option.label} (current)` : option.label,
            }))}
          />
        </div>

        {folderOpen ? (
          <NewFolderPrompt
            value={folderName}
            onChange={(value) => {
              setFolderName(value);
              setFolderError(null);
            }}
            onSubmit={createDestinationFolder}
            onCancel={() => {
              setFolderOpen(false);
              setFolderName('');
              setFolderError(null);
            }}
            busy={createFolder.isPending}
            error={folderError}
            parentLabel={dest}
          />
        ) : (
          <button type="button" className="documents-action" onClick={() => setFolderOpen(true)}>
            New folder here
          </button>
        )}

        <label className="documents-upload-field">
          <span className="documents-upload-label">Filename</span>
          <input
            className="documents-newfolder-input"
            placeholder={file?.name ?? 'Pick a file first'}
            value={filename}
            onChange={(e) => {
              setFilename(e.target.value);
              setFailure(null);
            }}
          />
        </label>

        {targetPath ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Uploads to <span className="documents-mono">{targetPath}</span>
          </Typography.Text>
        ) : null}

        {failure ? (
          <p className="documents-newfolder-error" role="alert">
            {failure.message}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
