import type { EvolverRun, PendingSkill, Skill } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Badge,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Spin,
  Table,
  Tabs,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { rpc } from '../rpc';

// Skills tab — learning pillar of v0.5.
//
// Two panels behind one route:
//   Library — global skills CRUD over `~/.ethos/skills/*.md`
//   Evolver — config + pending approval queue + run history
//
// The pending queue's "Approve" button moves a candidate file from the
// pending dir into the live skills dir. The SkillsInjector picks it up
// on the next chat turn via mtime cache — no restart needed.

export function Skills() {
  const [activeTab, setActiveTab] = useState<'library' | 'evolver'>('library');

  const skillsQuery = useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => rpc.skills.list(),
  });

  const pendingCount = skillsQuery.data?.pendingCount ?? 0;

  return (
    <div className="skills-tab">
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'library' | 'evolver')}
        items={[
          {
            key: 'library',
            label: 'Library',
            children: <LibraryPanel skillsQuery={skillsQuery} />,
          },
          {
            key: 'evolver',
            label: (
              <span>
                Evolver{' '}
                {pendingCount > 0 ? <Badge count={pendingCount} style={{ marginLeft: 6 }} /> : null}
              </span>
            ),
            children: <EvolverPanel />,
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Library panel — list / view / edit / delete / create global skills
// ---------------------------------------------------------------------------

interface LibraryPanelProps {
  skillsQuery: ReturnType<typeof useQuery<{ skills: Skill[]; pendingCount: number }>>;
}

function LibraryPanel({ skillsQuery }: LibraryPanelProps) {
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  if (skillsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (skillsQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load skills: {(skillsQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const skills = skillsQuery.data?.skills ?? [];

  return (
    <>
      <header className="skills-toolbar">
        <span className="skills-count">
          {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
        </span>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          New skill
        </Button>
      </header>

      <Table<Skill>
        rowKey="id"
        dataSource={skills}
        pagination={false}
        size="small"
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No skills installed yet. Create one to teach this agent how you work."
            />
          ),
        }}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            key: 'name',
            render: (name: string, skill) => (
              <div>
                <div style={{ fontWeight: 500 }}>{name}</div>
                <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{skill.id}.md</div>
              </div>
            ),
          },
          {
            title: 'Description',
            dataIndex: 'description',
            key: 'description',
            render: (d: string | null) =>
              d ? d : <Typography.Text type="secondary">—</Typography.Text>,
          },
          {
            title: 'Modified',
            dataIndex: 'modifiedAt',
            key: 'modifiedAt',
            width: 140,
            render: (iso: string) => formatRelative(iso),
          },
          {
            title: '',
            key: 'actions',
            width: 160,
            render: (_, skill) => (
              <SkillRowActions skill={skill} onEdit={() => setEditingSkill(skill)} />
            ),
          },
        ]}
      />

      {createOpen ? (
        <CreateSkillModal open={createOpen} onClose={() => setCreateOpen(false)} />
      ) : null}
      {editingSkill ? (
        <EditSkillModal
          key={editingSkill.id}
          skill={editingSkill}
          onClose={() => setEditingSkill(null)}
        />
      ) : null}
    </>
  );
}

function SkillRowActions({ skill, onEdit }: { skill: Skill; onEdit: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const deleteMut = useMutation({
    mutationFn: (id: string) => rpc.skills.delete({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: `Deleted ${skill.name}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Delete failed', description: (err as Error).message }),
  });

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button size="small" onClick={onEdit}>
        Edit
      </Button>
      <Popconfirm
        title="Delete this skill?"
        description="The file is removed from disk."
        onConfirm={() => deleteMut.mutate(skill.id)}
        okText="Delete"
        okButtonProps={{ danger: true }}
      >
        <Button size="small" danger>
          Delete
        </Button>
      </Popconfirm>
    </div>
  );
}

function CreateSkillModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{ id: string; body: string }>();

  const createMut = useMutation({
    mutationFn: (input: { id: string; body: string }) => rpc.skills.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Skill created', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Create failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open={open}
      title="New skill"
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Create"
      okButtonProps={{ loading: createMut.isPending }}
      destroyOnClose
      width={680}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => createMut.mutate(values)}
        initialValues={{
          body: '---\nname: my-skill\ndescription: One-line summary\n---\n\nWrite the skill body here.\n',
        }}
      >
        <Form.Item
          label="ID"
          name="id"
          rules={[
            { required: true, message: 'Required' },
            {
              pattern: /^[a-zA-Z0-9_-]+$/,
              message: 'Letters, digits, dash, underscore only.',
            },
          ]}
          extra="Becomes the filename. Cannot be changed later."
        >
          <Input autoFocus placeholder="e.g. summarize-pr" />
        </Form.Item>
        <Form.Item label="Body" name="body" rules={[{ required: true, message: 'Required' }]}>
          <Input.TextArea rows={14} style={{ fontFamily: 'Geist Mono, monospace' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function EditSkillModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{ body: string }>();

  // Reload the full body via skills.get on open — list returns it but we
  // still want a fresh read in case the file changed on disk between
  // opening the editor and saving.
  const { data, isLoading } = useQuery({
    queryKey: ['skills', 'get', skill.id],
    queryFn: () => rpc.skills.get({ id: skill.id }),
  });

  useEffect(() => {
    if (data?.skill) {
      // Reconstruct the source body the editor sees — frontmatter block +
      // markdown body. The wire schema gives us them separately.
      form.setFieldsValue({ body: rebuildBody(data.skill) });
    }
  }, [data, form]);

  const updateMut = useMutation({
    mutationFn: (body: string) => rpc.skills.update({ id: skill.id, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Saved', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open
      title={`Edit ${skill.name}`}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="Save"
      okButtonProps={{ loading: updateMut.isPending }}
      destroyOnClose
      width={680}
    >
      {isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      ) : (
        <Form form={form} layout="vertical" onFinish={(values) => updateMut.mutate(values.body)}>
          <Form.Item label="Body" name="body" rules={[{ required: true, message: 'Required' }]}>
            <Input.TextArea rows={18} style={{ fontFamily: 'Geist Mono, monospace' }} />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}

function rebuildBody(skill: Skill): string {
  const fmKeys = Object.keys(skill.frontmatter);
  if (fmKeys.length === 0) return skill.body;
  const lines = fmKeys.map((k) => `${k}: ${stringifyFrontmatterValue(skill.frontmatter[k])}`);
  return `---\n${lines.join('\n')}\n---\n\n${skill.body}`;
}

function stringifyFrontmatterValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Evolver panel — config form + pending queue + run history
// ---------------------------------------------------------------------------

function EvolverPanel() {
  return (
    <div className="evolver-panel">
      <Tabs
        defaultActiveKey="config"
        items={[
          { key: 'config', label: 'Config', children: <EvolverConfigForm /> },
          { key: 'pending', label: 'Approval queue', children: <PendingQueue /> },
          { key: 'history', label: 'Run history', children: <EvolverHistory /> },
        ]}
      />
    </div>
  );
}

function EvolverConfigForm() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm();

  const { data, isLoading, error } = useQuery({
    queryKey: ['evolver', 'config'],
    queryFn: () => rpc.evolver.configGet(),
  });

  useEffect(() => {
    if (data?.config) form.setFieldsValue(data.config);
  }, [data, form]);

  const updateMut = useMutation({
    mutationFn: (cfg: Parameters<typeof rpc.evolver.configUpdate>[0]) =>
      rpc.evolver.configUpdate(cfg),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evolver', 'config'] });
      notification.success({ message: 'Saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

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
        Failed to load config: {(error as Error).message}
      </Typography.Text>
    );
  }

  return (
    <Form
      form={form}
      layout="vertical"
      style={{ maxWidth: 480 }}
      onFinish={(values) => updateMut.mutate(values)}
    >
      <Form.Item
        label="Rewrite threshold"
        name="rewriteThreshold"
        extra="Skills with avg score below this are rewrite candidates. 0–1."
      >
        <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="New-skill pattern threshold"
        name="newSkillPatternThreshold"
        extra="Tasks scoring above this with no skill assistance can seed a new skill. 0–1."
      >
        <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Min runs before evolving a skill"
        name="minRunsBeforeEvolve"
        extra="Don't propose a rewrite until a skill has at least this many runs."
      >
        <InputNumber min={0} step={1} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Min pattern count for new skills"
        name="minPatternCount"
        extra="A new-skill candidate needs at least this many high-scoring sample tasks."
      >
        <InputNumber min={0} step={1} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={updateMut.isPending}>
          Save
        </Button>
      </Form.Item>
    </Form>
  );
}

function PendingQueue() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  const { data, isLoading, error } = useQuery({
    queryKey: ['evolver', 'pending'],
    queryFn: () => rpc.evolver.pendingList(),
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => rpc.evolver.pendingApprove({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evolver', 'pending'] });
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Approved — skill is now live.', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Approve failed', description: (err as Error).message }),
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) => rpc.evolver.pendingReject({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['evolver', 'pending'] });
      qc.invalidateQueries({ queryKey: ['skills', 'list'] });
      notification.success({ message: 'Rejected', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Reject failed', description: (err as Error).message }),
  });

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
        Failed to load queue: {(error as Error).message}
      </Typography.Text>
    );
  }

  const pending = data?.pending ?? [];

  if (pending.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No pending candidates. Run `ethos skills evolve` against an eval JSONL to populate this queue."
      />
    );
  }

  return (
    <Table<PendingSkill>
      rowKey="id"
      dataSource={pending}
      pagination={false}
      size="small"
      expandable={{
        expandedRowRender: (row) => <PendingPreview skill={row} />,
      }}
      columns={[
        {
          title: 'Name',
          dataIndex: 'name',
          key: 'name',
          render: (name: string, row) => (
            <div>
              <div style={{ fontWeight: 500 }}>{name}</div>
              <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{row.id}.md</div>
            </div>
          ),
        },
        {
          title: 'Description',
          dataIndex: 'description',
          key: 'description',
          render: (d: string | null) =>
            d ? d : <Typography.Text type="secondary">—</Typography.Text>,
        },
        {
          title: 'Proposed',
          dataIndex: 'proposedAt',
          key: 'proposedAt',
          width: 140,
          render: (iso: string) => formatRelative(iso),
        },
        {
          title: '',
          key: 'actions',
          width: 200,
          render: (_, row) => (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                size="small"
                type="primary"
                onClick={() => approveMut.mutate(row.id)}
                loading={approveMut.isPending && approveMut.variables === row.id}
              >
                Approve
              </Button>
              <Popconfirm
                title="Reject this candidate?"
                description="The pending file is deleted."
                onConfirm={() => rejectMut.mutate(row.id)}
                okText="Reject"
                okButtonProps={{ danger: true }}
              >
                <Button size="small" danger>
                  Reject
                </Button>
              </Popconfirm>
            </div>
          ),
        },
      ]}
    />
  );
}

function PendingPreview({ skill }: { skill: PendingSkill }) {
  return (
    <pre
      style={{
        margin: 0,
        fontFamily: 'Geist Mono, monospace',
        fontSize: 12,
        maxHeight: 320,
        overflow: 'auto',
        background: 'rgba(255,255,255,0.02)',
        padding: 12,
        borderRadius: 6,
        whiteSpace: 'pre-wrap',
      }}
    >
      {skill.body}
    </pre>
  );
}

function EvolverHistory() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['evolver', 'history'],
    queryFn: () => rpc.evolver.history({ limit: 50 }),
  });

  const runs = useMemo(() => data?.runs ?? [], [data]);

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
        Failed to load history: {(error as Error).message}
      </Typography.Text>
    );
  }
  if (runs.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No evolver runs recorded yet. Each run appends a line to ~/.ethos/evolver-history.jsonl."
      />
    );
  }
  return (
    <Table<EvolverRun>
      rowKey="ranAt"
      dataSource={runs}
      pagination={false}
      size="small"
      columns={[
        {
          title: 'Ran at',
          dataIndex: 'ranAt',
          key: 'ranAt',
          width: 180,
          render: (iso: string) => formatRelative(iso),
        },
        {
          title: 'Eval source',
          dataIndex: 'evalOutputPath',
          key: 'evalOutputPath',
          render: (p: string) => <Typography.Text code>{p}</Typography.Text>,
        },
        {
          title: 'Rewrites',
          dataIndex: 'rewritesProposed',
          key: 'rewritesProposed',
          width: 100,
          align: 'right',
        },
        {
          title: 'New',
          dataIndex: 'newSkillsProposed',
          key: 'newSkillsProposed',
          width: 80,
          align: 'right',
        },
        {
          title: 'Skipped',
          key: 'skipped',
          width: 100,
          align: 'right',
          render: (_, row) => row.skipped.length,
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
