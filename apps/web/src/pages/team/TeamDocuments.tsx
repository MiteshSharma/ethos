import { useParams } from 'react-router-dom';
import { DocumentsBrowser } from '../../components/documents/DocumentsBrowser';

// The team's Documents pane: every file under the team's work directory
// (`~/.ethos/teams/<team>/` — brand/, opportunities/, state/, memory/, …),
// with the same browse / preview / download / upload / new-folder / delete
// surface the workspace Documents page has. The browser is shared; only the
// scope differs (`{ team }` here, `{ personalityId }` there), and the backend
// confines every call to the team directory the same way it confines a
// personality's declared root.

export function TeamDocuments() {
  const { teamId = '' } = useParams<{ teamId: string }>();

  return (
    <div className="team-pane team-documents">
      <div className="team-sec team-documents-head">
        Documents <span className="team-sec-cnt team-mono">teams/{teamId}/</span>
      </div>
      <DocumentsBrowser key={teamId} scope={{ team: teamId }} />
    </div>
  );
}
