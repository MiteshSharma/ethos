import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Modal, Popconfirm } from 'antd';
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { NavIcon } from '../../components/ui/NavIcon';
import { rpc } from '../../rpc';

// The team's Memory pane (plan/phases/teams-as-a-scope.md §8): topic list on
// the left (220px), the topic's content on the right, over the
// `teams.memory*` wrappers (`scopeId = team:<name>`). `?topic=` selects; the
// first topic is the default. Content is preformatted mono text — the
// personality Memory page renders its files the same way.

const TOPIC_KEY = /^[A-Za-z0-9_-]+$/;

const memoryKeys = {
  list: (team: string) => ['teams', 'memory', 'list', team] as const,
  read: (team: string, key: string) => ['teams', 'memory', 'read', team, key] as const,
};

export function TeamMemory() {
  const { teamId = '' } = useParams<{ teamId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: memoryKeys.list(teamId),
    queryFn: () => rpc.teams.memoryList({ team: teamId }),
    enabled: teamId.length > 0,
  });
  const topics = list.data?.items.map((t) => t.key) ?? [];
  const requested = searchParams.get('topic');
  const current = requested && topics.includes(requested) ? requested : (topics[0] ?? null);

  const read = useQuery({
    queryKey: memoryKeys.read(teamId, current ?? ''),
    queryFn: () => rpc.teams.memoryRead({ team: teamId, key: current ?? '' }),
    enabled: current !== null,
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState('');

  // Leaving a topic abandons its draft — the editor is per topic.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on topic change only
  useEffect(() => {
    setEditing(false);
  }, [current]);

  const invalidate = (key: string) => {
    queryClient.invalidateQueries({ queryKey: memoryKeys.list(teamId) });
    queryClient.invalidateQueries({ queryKey: memoryKeys.read(teamId, key) });
    queryClient.invalidateQueries({ queryKey: ['teams', 'get', teamId] });
  };

  const write = useMutation({
    mutationFn: (input: { key: string; action: 'add' | 'replace' | 'delete'; content?: string }) =>
      rpc.teams.memoryWrite({ team: teamId, ...input }),
    onSuccess: (_result, input) => invalidate(input.key),
  });

  const selectTopic = (key: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('topic', key);
        return next;
      },
      { replace: true },
    );
  };

  const startEdit = () => {
    setDraft(read.data?.content ?? '');
    setEditing(true);
  };
  const save = async () => {
    if (!current) return;
    await write.mutateAsync({ key: current, action: 'replace', content: draft });
    setEditing(false);
  };
  const remove = async () => {
    if (!current) return;
    await write.mutateAsync({ key: current, action: 'delete' });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('topic');
        return next;
      },
      { replace: true },
    );
  };
  const newKeyValid = TOPIC_KEY.test(newKey);
  const create = async () => {
    if (!newKeyValid) return;
    await write.mutateAsync({ key: newKey, action: 'replace', content: `# ${newKey}\n` });
    setCreating(false);
    setNewKey('');
    selectTopic(newKey);
  };

  return (
    <div className="team-pane">
      <div className="team-memory-split">
        <div className="team-memory-topics">
          <div className="team-sec">Topics</div>
          <div className="team-toplist">
            {topics.map((key) => (
              <button
                type="button"
                key={key}
                className={key === current ? 'team-toplist-on' : undefined}
                onClick={() => selectTopic(key)}
              >
                <NavIcon icon="memory" />
                {key}.md
              </button>
            ))}
            <button type="button" className="team-toplist-new" onClick={() => setCreating(true)}>
              + New topic
            </button>
          </div>
        </div>

        <div className="team-memory-body">
          {current ? (
            <>
              <div className="team-sec">
                {current}.md <span className="team-sec-cnt">team:{teamId}</span>
                {editing ? null : (
                  <button type="button" className="team-sec-more" onClick={startEdit}>
                    Edit
                  </button>
                )}
              </div>
              {editing ? (
                <div className="team-memory-editor">
                  <Input.TextArea
                    autoSize={{ minRows: 12 }}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label={`${current}.md`}
                  />
                  <div className="team-memory-actions">
                    <Button type="primary" size="small" loading={write.isPending} onClick={save}>
                      Save
                    </Button>
                    <Button size="small" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                    <Popconfirm
                      title={`Delete ${current}.md?`}
                      description="Every member loses this topic."
                      okText="Delete"
                      okButtonProps={{ danger: true }}
                      onConfirm={remove}
                    >
                      <Button size="small" danger style={{ marginLeft: 'auto' }}>
                        Delete topic
                      </Button>
                    </Popconfirm>
                  </div>
                </div>
              ) : (
                <pre className="team-md">
                  {read.data?.content ?? (read.isPending ? 'Loading…' : '')}
                </pre>
              )}
            </>
          ) : (
            <div className="team-empty">{list.isPending ? 'Loading…' : 'No topics yet.'}</div>
          )}
        </div>
      </div>

      <Modal
        title="New topic"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={create}
        okText="Create"
        okButtonProps={{ disabled: !newKeyValid, loading: write.isPending }}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={newKey}
          placeholder="brand-voice"
          aria-label="Topic key"
          status={newKey.length > 0 && !newKeyValid ? 'error' : undefined}
          onChange={(e) => setNewKey(e.target.value.trim())}
          onPressEnter={create}
        />
        <p className="team-side-para">
          Letters, digits, <span className="team-mono">-</span> and{' '}
          <span className="team-mono">_</span> only — it becomes{' '}
          <span className="team-mono">{newKey || '<key>'}.md</span>.
        </p>
      </Modal>
    </div>
  );
}
