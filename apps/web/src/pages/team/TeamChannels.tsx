import type { TeamChannel } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { PersonalityMark } from '../../components/ui/PersonalityMark';
import { useTeam } from '../../features/teams/api/queries';
import { rpc } from '../../rpc';

// The team's Channels pane (plan/phases/teams-as-a-scope.md §8): the
// manifest's channels, joined by botKey with the gateway's configured bots
// (telegram / slack / whatsapp lists — the ones that carry a `bind`). The
// gateway does not report a live connection, so Status is what the config
// says: whether the bot's credentials are in place. Read-only in v1;
// `+ Bind channel` goes to Platforms.

interface BotRow {
  botKey: string;
  /** Credentials present (token stored / WhatsApp paired). */
  configured: boolean;
  label: string;
}

async function loadBots(): Promise<BotRow[]> {
  const settled = await Promise.allSettled([
    rpc.platforms.botsListTelegram(),
    rpc.platforms.botsListSlack(),
    rpc.platforms.botsListWhatsApp(),
  ]);
  const rows: BotRow[] = [];
  const [telegram, slack, whatsapp] = settled;
  if (telegram.status === 'fulfilled') {
    for (const b of telegram.value.bots) {
      rows.push({
        botKey: b.botKey,
        configured: b.tokenConfigured,
        label: b.username ? `@${b.username}` : b.botKey,
      });
    }
  }
  if (slack.status === 'fulfilled') {
    for (const b of slack.value.bots) {
      rows.push({
        botKey: b.botKey,
        configured: b.botTokenConfigured && b.appTokenConfigured,
        label: b.botKey,
      });
    }
  }
  if (whatsapp.status === 'fulfilled') {
    for (const b of whatsapp.value.bots) {
      rows.push({
        botKey: b.botKey,
        configured: b.paired,
        label: b.phoneNumber ?? b.botKey,
      });
    }
  }
  return rows;
}

function Status({ bot }: { bot: BotRow | undefined }) {
  if (!bot) return <span>—</span>;
  const state = bot.configured ? 'ok' : 'err';
  return (
    <span className="team-tbl-inline">
      <span className={`team-dot team-dot-${state}`} />
      {bot.configured ? 'configured' : 'credentials missing'}
    </span>
  );
}

export function TeamChannels() {
  const { teamId = '' } = useParams<{ teamId: string }>();
  const teamQuery = useTeam(teamId);
  const bots = useQuery({ queryKey: ['platforms', 'bots', 'all'], queryFn: loadBots });

  const team = teamQuery.data;
  const channels: TeamChannel[] = team?.channels ?? [];
  const botByKey = new Map(bots.data?.map((b) => [b.botKey, b]));
  const coordinator = team?.coordinator ?? null;

  return (
    <div className="team-pane">
      <div className="team-sec">Channels bound to {teamId}</div>
      {!team ? (
        <div className="team-empty">
          {teamQuery.isError ? `Could not load ${teamId}.` : 'Loading…'}
        </div>
      ) : channels.length > 0 ? (
        <table className="team-tbl">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Channel / bot</th>
              <th>Bind</th>
              <th>Fronted by</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((ch) => {
              const bot = botByKey.get(ch.botKey);
              return (
                <tr key={`${ch.platform}:${ch.botKey}`}>
                  <td>{ch.platform}</td>
                  <td className="team-mono">{bot?.label ?? ch.botKey}</td>
                  <td>
                    <span className="team-tag">team</span>
                  </td>
                  <td>
                    {coordinator ? (
                      <span className="team-tbl-inline" data-p={coordinator}>
                        <PersonalityMark personalityId={coordinator} size={14} />
                        {coordinator}
                      </span>
                    ) : (
                      'board'
                    )}
                  </td>
                  <td>
                    <Status bot={bot} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="team-empty">
          No channel is bound to this team. Bind one and the coordinator fronts it: inbound messages
          become tickets, replies are drafted for a person to post.
        </div>
      )}
      <div>
        <Link to="/communications">
          <Button size="small">+ Bind channel</Button>
        </Link>
      </div>
    </div>
  );
}
