import type { TeamSummary } from '@ethosagent/web-contracts';
import { Badge, Button, Empty, Spin, Table, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { PersonalityMark } from '../components/ui/PersonalityMark';
import { TeamRing } from '../components/ui/TeamRing';
import { useTeamsList } from '../features/teams/api/queries';
import { teamAccents } from '../features/teams/lib/membership';
import { buildTeamPath } from '../lib/workspaceRoutes';

// Teams listing — the Library's second door into a team's scope
// (plan/phases/teams-as-a-scope.md D2/§2, §10). Still a table, no card grid:
// every row is the team's ring, name, coordinator, mode, members, health,
// and `Open scope →` — which, like a row click, lands on
// `/t/<team>/overview`. Refetches every 5s so an `ethos team start`
// surfaces without a hard reload.

export function Teams() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch, isFetching } = useTeamsList();

  if (isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <Typography.Text type="danger">
        Failed to load teams: {(error as Error).message}
      </Typography.Text>
    );
  }

  const teams = data?.items ?? [];

  return (
    <div className="teams-tab">
      <header className="teams-toolbar" style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <span>
          {teams.length} {teams.length === 1 ? 'team' : 'teams'}
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => void refetch()} loading={isFetching}>
          Refresh
        </Button>
      </header>

      <Table<TeamSummary>
        rowKey="name"
        dataSource={teams}
        pagination={false}
        size="small"
        onRow={(record) => ({
          onClick: () => navigate(buildTeamPath(record.name)),
          style: { cursor: 'pointer' },
        })}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No teams configured. Create one with `ethos team create <name>` and start it with `ethos team start <name>`."
            />
          ),
        }}
        columns={[
          {
            title: 'Team',
            dataIndex: 'name',
            key: 'name',
            render: (name: string, record: TeamSummary) => (
              <span className="teams-row-name">
                <TeamRing accents={teamAccents(record)} size={18} title={name} />
                <Typography.Text strong>{name}</Typography.Text>
              </span>
            ),
          },
          {
            title: 'Coordinator',
            dataIndex: 'coordinator',
            key: 'coordinator',
            width: 160,
            render: (coordinator: string | null) =>
              coordinator ? (
                <span className="teams-row-coordinator">
                  <PersonalityMark personalityId={coordinator} size={12} />
                  {coordinator}
                </span>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          {
            title: 'Description',
            dataIndex: 'description',
            key: 'description',
            ellipsis: true,
            render: (text: string) =>
              text ? (
                <Typography.Text>{text}</Typography.Text>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          {
            title: 'Mode',
            dataIndex: 'dispatchMode',
            key: 'dispatchMode',
            width: 120,
            render: (mode: TeamSummary['dispatchMode']) => <Tag bordered={false}>{mode}</Tag>,
          },
          {
            title: 'Members',
            key: 'members',
            width: 140,
            render: (_: unknown, record: TeamSummary) => (
              <span>
                {record.runningCount}/{record.memberCount} running
              </span>
            ),
          },
          {
            title: 'Health',
            dataIndex: 'health',
            key: 'health',
            width: 110,
            render: (health: TeamSummary['health']) => <HealthBadge health={health} />,
          },
          {
            title: '',
            key: 'open',
            width: 120,
            align: 'right' as const,
            render: (_: unknown, record: TeamSummary) => (
              <Button
                type="link"
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(buildTeamPath(record.name));
                }}
              >
                Open scope →
              </Button>
            ),
          },
        ]}
      />
    </div>
  );
}

function HealthBadge({ health }: { health: TeamSummary['health'] }) {
  if (health === 'running') return <Badge status="success" text="running" />;
  if (health === 'stale') return <Badge status="warning" text="stale" />;
  return <Badge status="default" text="stopped" />;
}
