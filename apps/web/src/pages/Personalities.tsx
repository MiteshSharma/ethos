import type { Personality, PersonalitySkill } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Steps,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { rpc } from '../rpc';

// Personalities tab — v1.
//
// List of all personalities (built-in + user-created) with three
// row-level actions:
//   • Edit       — opens a 3-tab modal (Identity / Toolset / Config).
//                  Skills sub-surface lives there too. Built-ins are
//                  read-only here; the action becomes "Duplicate."
//   • Duplicate  — copies the personality into ~/.ethos/personalities/
//                  under a new id, opens the editor on the copy.
//   • Delete     — only for user-created personalities.
//
// Plus a "New personality" button at the top → 4-step create wizard.
//
// Live preview chat (plan: side-pane disposable session) is deferred
// to v1.x — the chat plumbing has assumptions about persistent
// session state that need a wider refactor to disposable mode.

export function Personalities() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState<Personality | null>(null);

  const listQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list(),
  });

  if (listQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (listQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load personalities: {(listQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const personalities = listQuery.data?.personalities ?? [];
  const defaultId = listQuery.data?.defaultId ?? null;

  return (
    <div className="personalities-tab">
      <header className="personalities-toolbar">
        <span className="personalities-count">
          {personalities.length} {personalities.length === 1 ? 'personality' : 'personalities'}
        </span>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          New personality
        </Button>
      </header>

      <Table<Personality>
        rowKey="id"
        dataSource={personalities}
        pagination={false}
        size="small"
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No personalities loaded. Run `ethos setup` first."
            />
          ),
        }}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            key: 'name',
            render: (name: string, p) => (
              <div>
                <div style={{ fontWeight: 500 }}>
                  {name} {p.id === defaultId ? <Tag color="blue">default</Tag> : null}{' '}
                  {p.builtin ? <Tag>built-in</Tag> : null}
                </div>
                <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{p.id}</div>
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
            title: 'Model',
            dataIndex: 'model',
            key: 'model',
            width: 200,
            render: (m: string | null) =>
              m ? (
                <Typography.Text code>{m}</Typography.Text>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          {
            title: 'Tools',
            dataIndex: 'toolset',
            key: 'toolset',
            width: 100,
            align: 'right',
            render: (t: string[] | null) => t?.length ?? 0,
          },
          {
            title: '',
            key: 'actions',
            width: 240,
            render: (_, p) => (
              <PersonalityRowActions
                personality={p}
                onEdit={() => setEditingId(p.id)}
                onDuplicate={() => setDuplicatePrompt(p)}
              />
            ),
          },
        ]}
      />

      {createOpen ? (
        <CreateWizard
          existingIds={new Set(personalities.map((p) => p.id))}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
      {editingId ? (
        <EditModal key={editingId} id={editingId} onClose={() => setEditingId(null)} />
      ) : null}
      {duplicatePrompt ? (
        <DuplicateModal
          source={duplicatePrompt}
          existingIds={new Set(personalities.map((p) => p.id))}
          onClose={() => setDuplicatePrompt(null)}
          onDone={(newId) => {
            setDuplicatePrompt(null);
            setEditingId(newId);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------

function PersonalityRowActions({
  personality,
  onEdit,
  onDuplicate,
}: {
  personality: Personality;
  onEdit: () => void;
  onDuplicate: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const deleteMut = useMutation({
    mutationFn: (id: string) => rpc.personalities.delete({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Deleted ${personality.name}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Delete failed', description: (err as Error).message }),
  });

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {personality.builtin ? null : (
        <Button size="small" onClick={onEdit}>
          Edit
        </Button>
      )}
      <Button size="small" onClick={onDuplicate}>
        Duplicate
      </Button>
      {personality.builtin ? null : (
        <Popconfirm
          title={`Delete ${personality.name}?`}
          description="The directory under ~/.ethos/personalities/ is removed."
          onConfirm={() => deleteMut.mutate(personality.id)}
          okText="Delete"
          okButtonProps={{ danger: true }}
        >
          <Button size="small" danger loading={deleteMut.isPending}>
            Delete
          </Button>
        </Popconfirm>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create wizard (4 steps)
// ---------------------------------------------------------------------------

interface WizardState {
  id: string;
  name: string;
  description: string;
  model: string;
  toolset: string[];
  ethosMd: string;
}

const ETHOS_TEMPLATE = `# About me\n\nI am a {role}. I {what I do}. I {how I work}.\n\n## How I respond\n\n- {tone / shape}\n- {tone / shape}\n- {tone / shape}\n`;

function CreateWizard({ existingIds, onClose }: { existingIds: Set<string>; onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>({
    id: '',
    name: '',
    description: '',
    model: '',
    toolset: [],
    ethosMd: ETHOS_TEMPLATE,
  });

  const createMut = useMutation({
    mutationFn: () =>
      rpc.personalities.create({
        id: state.id,
        name: state.name,
        ...(state.description ? { description: state.description } : {}),
        ...(state.model ? { model: state.model } : {}),
        toolset: state.toolset,
        ethosMd: state.ethosMd,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Created ${state.name}`, placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Create failed', description: (err as Error).message }),
  });

  const idValid = /^[a-z0-9_-]+$/.test(state.id);
  const nameValid = state.name.trim().length > 0;
  const idCollision = existingIds.has(state.id);

  const stepValid = (() => {
    if (step === 0) return idValid && nameValid && !idCollision;
    if (step === 1) return true; // model is optional
    if (step === 2) return true; // toolset can be empty
    if (step === 3) return state.ethosMd.length > 0;
    return false;
  })();

  return (
    <Modal
      open
      title="New personality"
      onCancel={onClose}
      width={720}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={onClose}>Cancel</Button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 ? <Button onClick={() => setStep(step - 1)}>Back</Button> : null}
            {step < 3 ? (
              <Button type="primary" disabled={!stepValid} onClick={() => setStep(step + 1)}>
                Next
              </Button>
            ) : (
              <Button
                type="primary"
                disabled={!stepValid}
                loading={createMut.isPending}
                onClick={() => createMut.mutate()}
              >
                Create
              </Button>
            )}
          </div>
        </div>
      }
    >
      <Steps
        current={step}
        size="small"
        items={[
          { title: 'Identity' },
          { title: 'Model' },
          { title: 'Toolset' },
          { title: 'ETHOS.md' },
        ]}
        style={{ marginBottom: 24 }}
      />
      {step === 0 ? (
        <IdentityStep state={state} setState={setState} idCollision={idCollision} />
      ) : null}
      {step === 1 ? <ModelStep state={state} setState={setState} /> : null}
      {step === 2 ? <ToolsetStep state={state} setState={setState} /> : null}
      {step === 3 ? <EthosMdStep state={state} setState={setState} /> : null}
    </Modal>
  );
}

function IdentityStep({
  state,
  setState,
  idCollision,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
  idCollision: boolean;
}) {
  return (
    <Form layout="vertical">
      <Form.Item label="Name" required help="Display name. The id below is derived from this.">
        <Input
          autoFocus
          value={state.name}
          placeholder="e.g. Strategist"
          onChange={(e) => {
            const name = e.target.value;
            const derivedId = name
              .toLowerCase()
              .replace(/\s+/g, '-')
              .replace(/[^a-z0-9_-]/g, '');
            setState((s) => ({ ...s, name, id: s.id === slugify(s.name) ? derivedId : s.id }));
          }}
        />
      </Form.Item>
      <Form.Item
        label="ID"
        required
        validateStatus={idCollision ? 'error' : undefined}
        help={
          idCollision
            ? 'Already taken by an existing personality.'
            : 'Lowercase, dash/underscore-separated. Becomes the directory name.'
        }
      >
        <Input
          value={state.id}
          placeholder="strategist"
          onChange={(e) => setState((s) => ({ ...s, id: e.target.value.toLowerCase() }))}
        />
      </Form.Item>
      <Form.Item label="Description" help="One-line summary, optional.">
        <Input
          value={state.description}
          placeholder="What this personality is good at."
          onChange={(e) => setState((s) => ({ ...s, description: e.target.value }))}
        />
      </Form.Item>
    </Form>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

function ModelStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary">
        Optional. Leave blank to use the global default from Settings.
      </Typography.Paragraph>
      <Form.Item label="Model" help="e.g. claude-opus-4-7, gpt-4o, moonshotai/kimi-k2.6">
        <Input
          value={state.model}
          placeholder="claude-opus-4-7"
          onChange={(e) => setState((s) => ({ ...s, model: e.target.value }))}
        />
      </Form.Item>
    </Form>
  );
}

function ToolsetStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  // Tool catalog is built into the wizard rather than fetched from the
  // server — the agent loop's runtime tool registry isn't surfaced via
  // RPC yet. Keep this list aligned with the standard tool extensions.
  const TOOL_GROUPS: Array<{ group: string; tools: string[] }> = [
    {
      group: 'File',
      tools: ['read_file', 'write_file', 'patch_file', 'search_files'],
    },
    {
      group: 'Web',
      tools: ['web_search', 'web_extract', 'web_crawl', 'web_fetch'],
    },
    {
      group: 'Terminal',
      tools: ['terminal'],
    },
    {
      group: 'Code',
      tools: ['execute_code', 'run_tests', 'lint'],
    },
    {
      group: 'Memory',
      tools: ['memory_read', 'memory_write', 'session_search'],
    },
    {
      group: 'Delegation',
      tools: ['delegate'],
    },
  ];

  const toggle = (name: string) => {
    setState((s) => {
      const has = s.toolset.includes(name);
      return { ...s, toolset: has ? s.toolset.filter((t) => t !== name) : [...s.toolset, name] };
    });
  };

  return (
    <div>
      <Typography.Paragraph type="secondary">
        Pick the tools this personality can call. Empty = the agent runs without any external action
        (text-only). You can edit this later.
      </Typography.Paragraph>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {TOOL_GROUPS.map((group) => (
          <section key={group.group}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.55)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: 6,
              }}
            >
              {group.group}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {group.tools.map((tool) => {
                const enabled = state.toolset.includes(tool);
                return (
                  <Tag.CheckableTag
                    key={tool}
                    checked={enabled}
                    onChange={() => toggle(tool)}
                    style={{ padding: '4px 10px', fontSize: 12 }}
                  >
                    {tool}
                  </Tag.CheckableTag>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function EthosMdStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary">
        First-person identity. The agent reads this on every turn — keep it short and concrete.
        Avoid "🚀 ready to help!" boilerplate.
      </Typography.Paragraph>
      <Form.Item required>
        <Input.TextArea
          value={state.ethosMd}
          autoSize={{ minRows: 12, maxRows: 24 }}
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
          onChange={(e) => setState((s) => ({ ...s, ethosMd: e.target.value }))}
        />
      </Form.Item>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Edit modal — three tabs (Identity / Toolset / Config) + Skills sub-surface
// ---------------------------------------------------------------------------

function EditModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['personalities', 'get', id],
    queryFn: () => rpc.personalities.get({ id }),
  });

  return (
    <Modal open title={`Edit ${id}`} onCancel={onClose} footer={null} width={780} destroyOnClose>
      {isLoading || !data ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 240 }}>
          <Spin />
        </div>
      ) : (
        <Tabs
          defaultActiveKey="identity"
          items={[
            {
              key: 'identity',
              label: 'Identity',
              children: <IdentityEditor id={id} initialEthosMd={data.ethosMd} />,
            },
            {
              key: 'toolset',
              label: 'Toolset',
              children: <ToolsetEditor id={id} initialToolset={data.personality.toolset ?? []} />,
            },
            {
              key: 'config',
              label: 'Config',
              children: <ConfigEditor id={id} personality={data.personality} />,
            },
            {
              key: 'skills',
              label: 'Skills',
              children: <PersonalitySkillsPanel personalityId={id} />,
            },
            {
              key: 'mcp',
              label: 'MCP',
              children: (
                <McpServersPanel
                  id={id}
                  initialMcpServers={data.personality.mcp_servers ?? []}
                />
              ),
            },
            {
              key: 'plugins',
              label: 'Plugins',
              children: (
                <PluginsAttachPanel
                  id={id}
                  initialPlugins={data.personality.plugins ?? []}
                />
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}

function IdentityEditor({ id, initialEthosMd }: { id: string; initialEthosMd: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [draft, setDraft] = useState(initialEthosMd);

  const mut = useMutation({
    mutationFn: () => rpc.personalities.update({ id, ethosMd: draft }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'ETHOS.md saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        First-person identity body. The agent loads this each turn.
      </Typography.Paragraph>
      <Form.Item>
        <Input.TextArea
          value={draft}
          autoSize={{ minRows: 14, maxRows: 30 }}
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Form.Item>
      <Button
        type="primary"
        disabled={draft === initialEthosMd}
        loading={mut.isPending}
        onClick={() => mut.mutate()}
      >
        Save
      </Button>
    </Form>
  );
}

function ToolsetEditor({ id, initialToolset }: { id: string; initialToolset: string[] }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [draft, setDraft] = useState(initialToolset.join('\n'));

  const mut = useMutation({
    mutationFn: () =>
      rpc.personalities.update({
        id,
        toolset: draft
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'Toolset saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        One tool per line. Blank lines ignored. Tool names follow{' '}
        <Typography.Text code>tool_name_in_snake_case</Typography.Text>.
      </Typography.Paragraph>
      <Form.Item>
        <Input.TextArea
          value={draft}
          autoSize={{ minRows: 12, maxRows: 24 }}
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Form.Item>
      <Button
        type="primary"
        disabled={draft === initialToolset.join('\n')}
        loading={mut.isPending}
        onClick={() => mut.mutate()}
      >
        Save
      </Button>
    </Form>
  );
}

function ConfigEditor({ id, personality }: { id: string; personality: Personality }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{
    name: string;
    description: string;
    model: string;
    memoryScope: 'global' | 'per-personality' | undefined;
  }>();

  useEffect(() => {
    form.setFieldsValue({
      name: personality.name,
      description: personality.description ?? '',
      model: personality.model ?? '',
      memoryScope: personality.memoryScope ?? undefined,
    });
  }, [personality, form]);

  const mut = useMutation({
    mutationFn: (values: {
      name: string;
      description: string;
      model: string;
      memoryScope?: 'global' | 'per-personality';
    }) =>
      rpc.personalities.update({
        id,
        name: values.name,
        description: values.description,
        model: values.model,
        ...(values.memoryScope ? { memoryScope: values.memoryScope } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'Config saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={(values) =>
        mut.mutate({
          name: values.name,
          description: values.description,
          model: values.model,
          ...(values.memoryScope ? { memoryScope: values.memoryScope } : {}),
        })
      }
    >
      <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Required' }]}>
        <Input />
      </Form.Item>
      <Form.Item label="Description" name="description">
        <Input />
      </Form.Item>
      <Form.Item label="Model" name="model">
        <Input placeholder="optional override" />
      </Form.Item>
      <Form.Item label="Memory scope" name="memoryScope">
        <Select
          allowClear
          options={[
            { label: 'global (default)', value: 'global' },
            { label: 'per-personality', value: 'per-personality' },
          ]}
        />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={mut.isPending}>
          Save
        </Button>
      </Form.Item>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Per-personality skills panel
// ---------------------------------------------------------------------------

function PersonalitySkillsPanel({ personalityId }: { personalityId: string }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<PersonalitySkill | null>(null);

  const skillsQuery = useQuery({
    queryKey: ['personalities', 'skills', personalityId],
    queryFn: () => rpc.personalities.skillsList({ personalityId }),
  });

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
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {skills.length} {skills.length === 1 ? 'skill' : 'skills'} for this personality
        </Typography.Text>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => setImportOpen(true)}>Import from global</Button>
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            New skill
          </Button>
        </div>
      </header>

      <Table<PersonalitySkill>
        rowKey="id"
        dataSource={skills}
        pagination={false}
        size="small"
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No personality-specific skills. Import from the global library or create one."
            />
          ),
        }}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            key: 'name',
            render: (name: string, s) => (
              <div>
                <div style={{ fontWeight: 500 }}>{name}</div>
                <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{s.id}.md</div>
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
            title: '',
            key: 'actions',
            width: 160,
            render: (_, s) => (
              <PersonalitySkillRowActions
                personalityId={personalityId}
                skill={s}
                onEdit={() => setEditing(s)}
              />
            ),
          },
        ]}
      />

      {createOpen ? (
        <CreatePersonalitySkillModal
          personalityId={personalityId}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
      {importOpen ? (
        <ImportGlobalSkillsModal
          personalityId={personalityId}
          existingIds={new Set(skills.map((s) => s.id))}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
      {editing ? (
        <EditPersonalitySkillModal
          key={editing.id}
          personalityId={personalityId}
          skill={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function PersonalitySkillRowActions({
  personalityId,
  skill,
  onEdit,
}: {
  personalityId: string;
  skill: PersonalitySkill;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const deleteMut = useMutation({
    mutationFn: () => rpc.personalities.skillsDelete({ personalityId, skillId: skill.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'skills', personalityId] });
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
        onConfirm={() => deleteMut.mutate()}
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

function CreatePersonalitySkillModal({
  personalityId,
  onClose,
}: {
  personalityId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{ skillId: string; body: string }>();

  const createMut = useMutation({
    mutationFn: (values: { skillId: string; body: string }) =>
      rpc.personalities.skillsCreate({ personalityId, skillId: values.skillId, body: values.body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'skills', personalityId] });
      notification.success({ message: 'Skill created', placement: 'topRight' });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Create failed', description: (err as Error).message }),
  });

  return (
    <Modal
      open
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
        onFinish={(v) => createMut.mutate(v)}
        initialValues={{
          body: '---\nname: my-skill\ndescription: One-line summary\n---\n\nWrite the skill body here.\n',
        }}
      >
        <Form.Item
          label="ID"
          name="skillId"
          rules={[
            { required: true, message: 'Required' },
            { pattern: /^[a-zA-Z0-9_-]+$/, message: 'Letters, digits, dash, underscore only.' },
          ]}
        >
          <Input autoFocus />
        </Form.Item>
        <Form.Item label="Body" name="body" rules={[{ required: true }]}>
          <Input.TextArea rows={14} style={{ fontFamily: 'Geist Mono, monospace' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function EditPersonalitySkillModal({
  personalityId,
  skill,
  onClose,
}: {
  personalityId: string;
  skill: PersonalitySkill;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [body, setBody] = useState(skill.body);

  const mut = useMutation({
    mutationFn: () => rpc.personalities.skillsUpdate({ personalityId, skillId: skill.id, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'skills', personalityId] });
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
      onOk={() => mut.mutate()}
      okText="Save"
      okButtonProps={{ loading: mut.isPending, disabled: body === skill.body }}
      destroyOnClose
      width={680}
    >
      <Input.TextArea
        value={body}
        autoSize={{ minRows: 14, maxRows: 24 }}
        style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
        onChange={(e) => setBody(e.target.value)}
      />
    </Modal>
  );
}

function ImportGlobalSkillsModal({
  personalityId,
  existingIds,
  onClose,
}: {
  personalityId: string;
  existingIds: Set<string>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [selected, setSelected] = useState<string[]>([]);

  const globalQuery = useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => rpc.skills.list(),
  });

  const importMut = useMutation({
    mutationFn: () => rpc.personalities.skillsImportGlobal({ personalityId, skillIds: selected }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['personalities', 'skills', personalityId] });
      notification.success({
        message: `Imported ${result.imported.length} skill${result.imported.length === 1 ? '' : 's'}`,
        placement: 'topRight',
      });
      onClose();
    },
    onError: (err) =>
      notification.error({ message: 'Import failed', description: (err as Error).message }),
  });

  const importable = useMemo(
    () => (globalQuery.data?.skills ?? []).filter((s) => !existingIds.has(s.id)),
    [globalQuery.data, existingIds],
  );

  return (
    <Modal
      open
      title="Import skills from global library"
      onCancel={onClose}
      onOk={() => importMut.mutate()}
      okText="Import"
      okButtonProps={{
        loading: importMut.isPending,
        disabled: selected.length === 0,
      }}
      destroyOnClose
      width={620}
    >
      {globalQuery.isLoading ? (
        <Spin />
      ) : importable.length === 0 ? (
        <Empty description="Every global skill is already imported (or the global library is empty)." />
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            Skills already in this personality are excluded. Imported skills become independent
            copies; later edits to the global file don't propagate.
          </Typography.Paragraph>
          <Select
            mode="multiple"
            value={selected}
            onChange={setSelected}
            style={{ width: '100%' }}
            placeholder="Pick skills to copy in"
            options={importable.map((s) => ({ label: `${s.name} — ${s.id}`, value: s.id }))}
          />
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Duplicate modal — pick a new id, then open the editor on the copy
// ---------------------------------------------------------------------------

function DuplicateModal({
  source,
  existingIds,
  onClose,
  onDone,
}: {
  source: Personality;
  existingIds: Set<string>;
  onClose: () => void;
  onDone: (newId: string) => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [newId, setNewId] = useState(`${source.id}-copy`);

  const mut = useMutation({
    mutationFn: () => rpc.personalities.duplicate({ id: source.id, newId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Duplicated → ${newId}`, placement: 'topRight' });
      onDone(newId);
    },
    onError: (err) =>
      notification.error({ message: 'Duplicate failed', description: (err as Error).message }),
  });

  const idValid = /^[a-z0-9_-]+$/.test(newId);
  const collision = existingIds.has(newId);

  return (
    <Modal
      open
      title={`Duplicate ${source.name}`}
      onCancel={onClose}
      onOk={() => mut.mutate()}
      okText="Duplicate"
      okButtonProps={{ loading: mut.isPending, disabled: !idValid || collision }}
      destroyOnClose
    >
      <Form layout="vertical">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Copies all four files (ETHOS.md, toolset.yaml, config.yaml, skills/) into{' '}
          <Typography.Text code>~/.ethos/personalities/&lt;new-id&gt;/</Typography.Text>. The editor
          opens on the copy when this completes.
        </Typography.Paragraph>
        <Form.Item
          label="New ID"
          required
          validateStatus={collision ? 'error' : !idValid && newId ? 'error' : undefined}
          help={
            collision
              ? 'Already taken.'
              : !idValid
                ? 'Lowercase, dash/underscore-separated.'
                : undefined
          }
        >
          <Input autoFocus value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// MCP servers panel — checkbox list of all configured MCP servers.
// Saves via personalities.update({ mcp_servers: [...] }).
// ---------------------------------------------------------------------------

function McpServersPanel({
  id,
  initialMcpServers,
}: {
  id: string;
  initialMcpServers: string[];
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [attached, setAttached] = useState<Set<string>>(new Set(initialMcpServers));
  const [dirty, setDirty] = useState(false);

  const pluginsQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const mut = useMutation({
    mutationFn: () => rpc.personalities.update({ id, mcp_servers: [...attached] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      setDirty(false);
      notification.success({ message: 'MCP servers saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const servers = pluginsQuery.data?.mcpServers ?? [];

  if (pluginsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No MCP servers configured. Edit{' '}
            <Typography.Text code>~/.ethos/mcp.json</Typography.Text>.
          </span>
        }
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        Check each MCP server this personality can reach. Unchecked servers are invisible to this
        role.
      </Typography.Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {servers.map((s) => (
          <Checkbox
            key={s.name}
            checked={attached.has(s.name)}
            onChange={(e) => {
              const next = new Set(attached);
              if (e.target.checked) next.add(s.name);
              else next.delete(s.name);
              setAttached(next);
              setDirty(true);
            }}
            aria-label={`Enable MCP server ${s.name} for ${id}`}
          >
            <span style={{ fontWeight: 500 }}>{s.name}</span>{' '}
            <Tag bordered={false} style={{ fontSize: 11 }}>
              {s.transport}
            </Tag>
            {s.command ? (
              <Typography.Text
                type="secondary"
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
              >
                {s.command}
              </Typography.Text>
            ) : s.url ? (
              <Typography.Text
                type="secondary"
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
              >
                {s.url}
              </Typography.Text>
            ) : null}
          </Checkbox>
        ))}
      </div>
      <Button
        type="primary"
        disabled={!dirty}
        loading={mut.isPending}
        onClick={() => mut.mutate()}
        style={{ alignSelf: 'flex-start' }}
      >
        Save
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugins attach panel — toggle per plugin, optimistic updates.
// Saves via personalities.update({ plugins: [...] }).
// ---------------------------------------------------------------------------

function PluginsAttachPanel({
  id,
  initialPlugins,
}: {
  id: string;
  initialPlugins: string[];
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [attached, setAttached] = useState<Set<string>>(new Set(initialPlugins));

  const pluginsQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const mut = useMutation({
    mutationFn: (next: string[]) => rpc.personalities.update({ id, plugins: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
    },
    onError: (err, _vars, ctx) => {
      if (ctx) setAttached((ctx as { prev: Set<string> }).prev);
      notification.error({ message: 'Save failed', description: (err as Error).message });
    },
  });

  const plugins = pluginsQuery.data?.plugins ?? [];

  if (pluginsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (plugins.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            No plugins installed.{' '}
            <Typography.Text code>ethos plugin install &lt;path&gt;</Typography.Text>
          </span>
        }
      />
    );
  }

  function toggle(pluginId: string, on: boolean) {
    const prev = new Set(attached);
    const next = new Set(attached);
    if (on) next.add(pluginId);
    else next.delete(pluginId);
    setAttached(next);
    mut.mutate([...next], { context: { prev } });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {attached.size === 0 ? (
        <Alert
          type="info"
          showIcon
          message="0 plugins attached"
          description="Toggle a plugin below to enable it for this personality."
          style={{ marginBottom: 4 }}
        />
      ) : null}
      {plugins.map((p) => (
        <div key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <Switch
            size="small"
            checked={attached.has(p.id)}
            loading={mut.isPending}
            onChange={(on) => toggle(p.id, on)}
            aria-label={`Attach ${p.name} to ${id}`}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>{p.name}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography.Text
                style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12 }}
                type="secondary"
              >
                {p.id}
              </Typography.Text>
              <Tag bordered={false} style={{ fontSize: 11 }}>
                {p.source}
              </Tag>
              {p.pluginContractMajor !== null ? (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  v{p.pluginContractMajor}
                </Typography.Text>
              ) : null}
            </div>
            {p.description ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {p.description}
              </Typography.Text>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
