import type { TeamDetail } from '@ethosagent/web-contracts';
import { Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import { humanDuration } from '../../../lib/teamPresence';
import { NavIcon } from '../../ui/NavIcon';
import { primaryChannel, trustMode } from './helpers';

// The side sheet for a system node (plan/phases/teams-as-a-scope.md §6):
// team memory (topic list + how members reach it), the bound channel
// (who fronts it, what inbound / outbound do, the dedup note) and the board
// (dispatch, staleness, trust, verifier). Each ends in the door to its pane.

export interface SystemSheetProps {
  kind: 'board' | 'memory' | 'channel';
  team: TeamDetail;
}

export function SystemSheet({ kind, team }: SystemSheetProps) {
  const navigate = useNavigate();
  const base = `/t/${team.name}`;

  if (kind === 'memory') {
    const topics = team.memoryTopics;
    return (
      <div className="team-side">
        <div className="team-side-head">
          <NavIcon icon="memory" />
          <span>
            <span className="team-side-name">Team memory</span>
            <span className="team-side-sub">~/.ethos/teams/{team.name}/memory/</span>
          </span>
        </div>
        <div className="team-sec">Topics</div>
        {topics.length > 0 ? (
          <div className="team-toplist">
            {topics.map((topic) => (
              <button
                type="button"
                key={topic}
                onClick={() => navigate(`${base}/memory?topic=${encodeURIComponent(topic)}`)}
              >
                <NavIcon icon="memory" />
                {topic}.md
              </button>
            ))}
          </div>
        ) : (
          <div className="team-side-para">No topics yet.</div>
        )}
        <p className="team-side-para">
          Every member reads and writes here through the team_memory tools. Topic names are injected
          into each member's prompt; content loads on demand.
        </p>
        <div className="team-btns">
          <Button type="primary" size="small" onClick={() => navigate(`${base}/memory`)}>
            Open memory
          </Button>
        </div>
      </div>
    );
  }

  if (kind === 'channel') {
    const channel = primaryChannel(team);
    return (
      <div className="team-side">
        <div className="team-side-head">
          <NavIcon icon="channels" />
          <span>
            <span className="team-side-name">
              {channel ? `${channel.platform} ${channel.botKey}` : 'Channel'}
            </span>
            <span className="team-side-sub">
              bind: team{channel ? ` · botKey ${channel.botKey}` : ''}
            </span>
          </span>
        </div>
        <div className="team-kv">
          <b>Fronted by</b>
          <span>{team.coordinator ?? 'board'}</span>
          <b>Inbound</b>
          <span>creates a ticket the coordinator claims</span>
          <b>Outbound</b>
          <span>drafts only; a person posts</span>
          <b>Dedup</b>
          <span className="team-mono">30s · delivery ledger on</span>
        </div>
        <div className="team-btns">
          <Button type="primary" size="small" onClick={() => navigate(`${base}/channels`)}>
            Open channels
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="team-side">
      <div className="team-side-head">
        <NavIcon icon="board" />
        <span>
          <span className="team-side-name">Board</span>
          <span className="team-side-sub">~/.ethos/teams/{team.name}/board.db</span>
        </span>
      </div>
      <div className="team-kv">
        <b>Dispatch</b>
        <span>{team.dispatchMode}</span>
        <b>Stale after</b>
        <span>{humanDuration(team.kanban.staleMs)}</span>
        <b>Poll</b>
        <span>{humanDuration(team.kanban.pollMs)}</span>
        <b>Trust</b>
        <span>{trustMode(team)}</span>
        <b>Verifier</b>
        <span>before_ticket_complete · fails closed</span>
      </div>
      <div className="team-btns">
        <Button type="primary" size="small" onClick={() => navigate(`${base}/board`)}>
          Open board
        </Button>
      </div>
    </div>
  );
}
