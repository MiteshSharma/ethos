import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import {
  type DocumentUploadFailure,
  documentUploadFailure,
  documentUploadHref,
} from '../../../lib/documents';
import { rpc } from '../../../rpc';
import { documentKeys } from './keys';

/**
 * A failed upload, as a real `Error` so react-query, error boundaries and the
 * devtools all see what they expect — carrying the classified `failure` the
 * modal branches on (a 409 is a CHOICE the user has, not just a message).
 */
export class DocumentUploadError extends Error {
  constructor(readonly failure: DocumentUploadFailure) {
    super(failure.message);
    this.name = 'DocumentUploadError';
  }
}

/**
 * Hard delete of one file. There is no trash tier — the operator has no shell
 * on the box to undo it — so the caller must confirm before firing.
 */
export function useDocumentDelete(personalityId: string, root: string) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (path: string) => rpc.documents.delete({ personalityId, root, path }),
    onSuccess: (_result, path) => {
      qc.invalidateQueries({ queryKey: documentKeys.rootLists(personalityId, root) });
      notification.success({ message: `Deleted ${path}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Delete failed', description: (err as Error).message }),
  });
}

/**
 * Create exactly ONE directory. The backend is non-recursive on purpose — the
 * parent must already exist — which every caller here satisfies by
 * construction: a folder is only ever created inside the folder being browsed
 * or the upload modal's current destination.
 *
 * No notification on success: both call sites show the result in place (the
 * new row appears in the listing, or the new folder becomes the upload
 * destination). Failures are returned to the caller rather than toasted, so a
 * name collision lands as an inline error next to the input that caused it.
 */
export function useCreateFolder(personalityId: string, root: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (path: string) => rpc.documents.createFolder({ personalityId, root, path }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: documentKeys.rootLists(personalityId, root) });
    },
  });
}

export interface UploadDocumentInput {
  file: File;
  /** Destination path relative to the root, INCLUDING the filename. */
  path: string;
  /** Only ever `true` after the user explicitly chose to replace a 409. */
  overwrite?: boolean;
}

/**
 * `POST /documents/upload` with the file as the raw body — not oRPC, because
 * bytes never travel over RPC in this codebase (the same split download
 * already lives on).
 *
 * The failure path is the interesting one: a 409 is a CHOICE the user has
 * (replace the existing file), so this throws a `DocumentUploadError` carrying
 * the classified failure and lets the modal branch on `kind`.
 */
export function useUploadDocument(personalityId: string, root: string) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: async ({ file, path, overwrite }: UploadDocumentInput) => {
      const res = await fetch(
        documentUploadHref(personalityId, root, path, { overwrite: overwrite === true }),
        {
          method: 'POST',
          // Echoed back by the route for logging only — there is no MIME
          // allowlist on this surface, by explicit design.
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        },
      );
      if (!res.ok) {
        throw new DocumentUploadError(
          documentUploadFailure(res.status, await res.json().catch(() => null)),
        );
      }
      return res;
    },
    onSuccess: (_res, { path }) => {
      qc.invalidateQueries({ queryKey: documentKeys.rootLists(personalityId, root) });
      // The upload can land in a folder the page is not currently browsing, so
      // the listing refresh alone is invisible feedback. Name the path.
      notification.success({ message: `Uploaded ${path}`, placement: 'topRight' });
    },
  });
}
