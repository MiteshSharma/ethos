// The inline "New Folder" prompt — one text input, confirm, cancel.
//
// Presentational and antd-free on purpose. It is rendered in two places (the
// page toolbar, and inside the upload modal so a destination folder can be
// created without closing it), it owns no mutation, and being antd-free is
// what lets it be rendered in a test the way `DocumentPreviewBody` is.
//
// A prompt rather than a modal: creating a folder is one word of input, and a
// dialog over a dialog for one word is the wrong weight.

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /** In flight — the confirm is disabled and says so. */
  busy: boolean;
  /** Validation or server error, shown under the input. Never a toast: the
   *  thing that failed is right here, and so is the fix. */
  error: string | null;
  /** Where the folder would be created, as a relative path. `''` is the root. */
  parentLabel: string;
}

export function NewFolderPrompt({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  error,
  parentLabel,
}: Props) {
  return (
    <form
      className="documents-newfolder"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="documents-newfolder-row">
        <input
          // biome-ignore lint/a11y/noAutofocus: the prompt is opened by an explicit click and holds exactly one field — focusing anything else would mean a second click before you can type.
          autoFocus
          className="documents-newfolder-input"
          aria-label={`New folder name in ${parentLabel || 'the root'}`}
          placeholder="Folder name"
          value={value}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
          }}
        />
        <button type="submit" className="documents-action" disabled={busy}>
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button type="button" className="documents-action" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {error ? (
        <p className="documents-newfolder-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
