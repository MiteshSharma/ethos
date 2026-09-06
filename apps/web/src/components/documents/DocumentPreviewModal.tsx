import { Button, Modal } from 'antd';
import { useEffect, useState } from 'react';
import type { DocumentEntry } from '../../features/documents/api/queries';
import { documentPreviewPlan } from '../../lib/document-preview';
import { type DocumentsScope, documentDownloadHref } from '../../lib/documents';
import { DocumentPreviewBody, type PreviewContent } from './DocumentPreviewBody';

// Modal preview of one workdir file.
//
// The bytes come from the EXISTING `GET /documents/download` route, fetched
// rather than navigated to. `content-disposition: attachment` only steers a
// navigation, so `fetch` reads the body fine — and reusing the route means the
// preview inherits its cookie auth, its ScopedStorage confinement and its
// symlink refusal instead of opening a second way to get bytes out of a
// workdir.

interface Props {
  scope: DocumentsScope;
  /** The declared root the entry was listed from — an id from `documents.root`. */
  root: string;
  entry: DocumentEntry;
  onClose: () => void;
}

export function DocumentPreviewModal({ scope, root, entry, onClose }: Props) {
  const href = documentDownloadHref(scope, root, entry.path);
  const plan = documentPreviewPlan(entry.name, entry.size);
  // Depend on the primitive, not on `plan` — a fresh object every render would
  // re-fetch the file on every render.
  const fetchAs = plan.status === 'ready' ? plan.as : null;

  const [content, setContent] = useState<PreviewContent>({ status: 'loading' });

  useEffect(() => {
    if (!fetchAs) return;
    const abort = new AbortController();
    let objectUrl: string | null = null;
    setContent({ status: 'loading' });

    fetch(href, { signal: abort.signal, credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (fetchAs === 'text') {
          setContent({ status: 'text', text: await res.text() });
          return;
        }
        objectUrl = URL.createObjectURL(await res.blob());
        setContent({ status: 'blob', url: objectUrl });
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        setContent({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });

    return () => {
      abort.abort();
      // An object URL pins the entire file in memory until it is revoked —
      // without this every preview leaks a whole file for the tab's lifetime.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [href, fetchAs]);

  return (
    <Modal
      open
      title={<span className="documents-mono">{entry.name}</span>}
      onCancel={onClose}
      width={840}
      styles={{ body: { maxHeight: '68vh', overflow: 'auto' } }}
      footer={[
        <Button key="download" href={href} download={entry.name}>
          Download
        </Button>,
        <Button key="close" type="primary" onClick={onClose}>
          Close
        </Button>,
      ]}
    >
      <DocumentPreviewBody name={entry.name} size={entry.size} plan={plan} content={content} />
    </Modal>
  );
}
