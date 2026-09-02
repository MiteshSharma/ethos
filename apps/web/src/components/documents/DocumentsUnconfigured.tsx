import { Link } from 'react-router-dom';

// What Documents shows for a personality that declares no `fs_reach.workdir`.
//
// This state exists because the alternative reads as a lie. An empty table
// says "this folder is empty"; an error toast says "something broke". Neither
// is true — nothing is configured, and the fix is one line in a file the
// operator owns, so the state names that line and points at the page that
// edits it.
//
// Left-aligned prose over a centered `Empty` illustration on purpose: this is
// an instruction, not a decoration (DESIGN.md — empty states are practical).

interface Props {
  personalityId: string;
  /**
   * Route to the personality's identity page, where "Edit personality" opens
   * the config editor that owns this field. `null` when there is no such route
   * to offer — the sentence stands on its own without it.
   */
  identityHref: string | null;
}

export function DocumentsUnconfigured({ personalityId, identityHref }: Props) {
  return (
    <div className="documents-unconfigured">
      <p className="documents-unconfigured-line">
        <strong>{personalityId}</strong> has no Documents folder configured.
      </p>
      <p className="documents-unconfigured-line">
        Set <code className="documents-mono">fs_reach.workdir</code> in its{' '}
        <code className="documents-mono">config.yaml</code> to give it one.
      </p>
      {identityHref ? (
        <p className="documents-unconfigured-line">
          <Link to={identityHref}>Open {personalityId}’s configuration</Link>
        </p>
      ) : null}
    </div>
  );
}
