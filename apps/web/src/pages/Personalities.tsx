import { InfoCircleOutlined } from '@ant-design/icons';
import type {
  McpPolicy,
  ModelTierConfigWire,
  Personality,
  PersonalitySkill,
  ProviderId,
  Skill,
} from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  AutoComplete,
  Button,
  Checkbox,
  Divider,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  type MenuProps,
  Modal,
  Popconfirm,
  Popover,
  Segmented,
  Select,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LivingSoulSection } from '../components/LivingSoulSection';
import { ExecutionTab } from '../components/personality/ExecutionTab';
import {
  type PersonalityVoice,
  PersonalityVoiceFields,
} from '../components/personality/PersonalityVoiceFields';
import { PersonalityRingAvatar } from '../components/ui/PersonalityRingAvatar';
import { toolAffordance } from '../lib/execution-posture';
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  categorizeGroup,
  categoryDetail,
} from '../lib/toolset-categories';
import { rpc } from '../rpc';

// Shape of one suggestion entry returned by the models.catalog RPC.
type CatalogModel = { id: string; label: string; contextWindow: number; default?: boolean };

function modelOptionsForProvider(
  catalog: { providers: Record<string, { models: CatalogModel[] }> } | undefined,
  provider: string | undefined,
): { value: string; label: string }[] {
  if (!catalog || !provider) return [];
  const models = catalog.providers[provider]?.models ?? [];
  return models.map((m) => ({ value: m.id, label: `${m.id} — ${m.label}` }));
}

// Case-insensitive substring match on the model id (option value) so typing
// narrows the suggestion list. AutoComplete still accepts arbitrary input.
const modelFilterOption = (input: string, option?: { value: string; label: string }) =>
  (option?.value ?? '').toLowerCase().includes(input.toLowerCase());

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
// Plus a "New personality" button at the top → tabbed create wizard.
//
// Live preview chat (plan: side-pane disposable session) is deferred
// to v1.x — the chat plumbing has assumptions about persistent
// session state that need a wider refactor to disposable mode.

export function Personalities() {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [duplicatePrompt, setDuplicatePrompt] = useState<Personality | null>(null);

  const listQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
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

  const personalities = listQuery.data?.items ?? [];
  const defaultId = listQuery.data?.defaultId ?? null;
  const userPersonalities = personalities.filter((p) => !p.system);
  const systemPersonalities = personalities.filter((p) => p.system);

  const columns = [
    {
      title: '',
      key: 'avatar',
      width: 48,
      render: (_: unknown, p: Personality) => (
        <PersonalityRingAvatar personalityId={p.id} size={32} />
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, p: Personality) => (
        <div>
          <div style={{ fontWeight: 500 }}>
            <Link
              to={`/personalities/${p.id}`}
              style={{ fontWeight: 500, color: 'var(--text-primary)' }}
            >
              {name}
            </Link>{' '}
            {p.id === defaultId ? <Tag color="blue">default</Tag> : null}{' '}
            {p.builtin ? <Tag>built-in</Tag> : null}
          </div>
          <div style={{ color: 'var(--ethos-text-dim)', fontSize: 11 }}>{p.id}</div>
        </div>
      ),
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      render: (d: string | null) =>
        d ? (
          <span
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              fontSize: 12,
              color: 'var(--ethos-text-dim)',
              lineHeight: 1.5,
            }}
          >
            {d}
          </span>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: 'Model',
      dataIndex: 'model',
      key: 'model',
      width: 140,
      render: (m: string | { trivial?: string; default?: string; deep?: string } | null) =>
        m ? (
          <span
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ethos-text-dim)' }}
          >
            {typeof m === 'string' ? m : (m.default ?? m.trivial ?? m.deep ?? '—')}
          </span>
        ) : (
          <span style={{ color: 'var(--ethos-text-dim)' }}>—</span>
        ),
    },
    {
      title: 'Tools',
      dataIndex: 'toolset',
      key: 'toolset',
      width: 60,
      align: 'right' as const,
      render: (t: string[] | null) => (
        <span
          style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ethos-text-dim)' }}
        >
          {t?.length ?? 0}
        </span>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 48,
      render: (_: unknown, p: Personality) => (
        <PersonalityRowActions
          personality={p}
          onEdit={() => navigate(`/personalities/${p.id}`)}
          onDuplicate={() => setDuplicatePrompt(p)}
        />
      ),
    },
  ];

  return (
    <div className="personalities-tab">
      <header className="page-header-row">
        <h1 className="page-h1">Personalities</h1>
        <span className="page-subtitle">
          {userPersonalities.length}{' '}
          {userPersonalities.length === 1 ? 'personality' : 'personalities'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="page-action-btn" onClick={() => setCreateOpen(true)}>
          + New Personality
        </button>
      </header>

      <Table<Personality>
        rowKey="id"
        dataSource={userPersonalities}
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
        columns={columns}
      />

      {systemPersonalities.length > 0 ? (
        <>
          <Divider titlePlacement="left">System</Divider>
          <Table<Personality>
            rowKey="id"
            dataSource={systemPersonalities}
            pagination={false}
            size="small"
            columns={columns}
          />
        </>
      ) : null}

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
  const { notification, modal } = AntApp.useApp();
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

  const items: MenuProps['items'] = [
    { key: 'edit', label: '✎ Edit' },
    { key: 'duplicate', label: '⧉ Duplicate' },
    ...(personality.builtin
      ? []
      : [{ type: 'divider' as const }, { key: 'delete', label: '🗑 Delete', danger: true }]),
  ];

  return (
    <Dropdown
      menu={{
        items,
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          if (key === 'edit') onEdit();
          else if (key === 'duplicate') onDuplicate();
          else if (key === 'delete') {
            modal.confirm({
              title: `Delete ${personality.name}?`,
              content: 'The directory under ~/.ethos/personalities/ is removed.',
              okText: 'Delete',
              okButtonProps: { danger: true },
              onOk: () => deleteMut.mutate(personality.id),
            });
          }
        },
      }}
      trigger={['click']}
      placement="bottomRight"
    >
      <button
        type="button"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--ethos-text-dim)',
          cursor: 'pointer',
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ⋯
      </button>
    </Dropdown>
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
  modelTrivial: string;
  modelDefault: string;
  modelDeep: string;
  modelTiered: boolean;
  provider: string;
  capabilities: string[];
  fsReachRead: string[];
  fsReachWrite: string[];
  fsReachWorkdir: string;
  toolset: string[];
  soulMd: string;
  skills: string[];
  plugins: string[];
  skillEvolutionEnabled: boolean;
  skillEvolutionMinToolCalls: number;
  skillEvolutionCooldownMinutes: number;
  evolutionApprovalMode: 'auto' | 'user';
  /** `voice.tts_provider` — a `voice.tts.providers.*` roster name; '' = default. */
  voiceTtsProvider: string;
  /** `voice.tts_voice`. */
  voiceTtsVoice: string;
  /** `voice.stt_provider` — a `voice.stt.providers.*` roster name; '' = default. */
  voiceSttProvider: string;
}

const SOUL_TEMPLATE = `# About me\n\nI am a {role}. I {what I do}. I {how I work}.\n\n## How I respond\n\n- {tone / shape}\n- {tone / shape}\n- {tone / shape}\n`;

function CreateWizard({ existingIds, onClose }: { existingIds: Set<string>; onClose: () => void }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [state, setState] = useState<WizardState>({
    id: '',
    name: '',
    description: '',
    model: '',
    modelTrivial: '',
    modelDefault: '',
    modelDeep: '',
    modelTiered: false,
    provider: '',
    capabilities: [],
    fsReachRead: [],
    fsReachWrite: [],
    fsReachWorkdir: '',
    toolset: ['memory_read', 'memory_write', 'session_search', 'cron'],
    soulMd: SOUL_TEMPLATE,
    skills: [],
    plugins: [],
    skillEvolutionEnabled: true,
    skillEvolutionMinToolCalls: 3,
    skillEvolutionCooldownMinutes: 30,
    evolutionApprovalMode: 'user',
    voiceTtsProvider: '',
    voiceTtsVoice: '',
    voiceSttProvider: '',
  });

  const createMut = useMutation({
    mutationFn: () =>
      rpc.personalities.create({
        id: state.id,
        name: state.name,
        ...(state.description ? { description: state.description } : {}),
        ...(state.modelTiered
          ? (() => {
              const tier: Record<string, string> = {};
              if (state.modelTrivial) tier.trivial = state.modelTrivial;
              if (state.modelDefault) tier.default = state.modelDefault;
              if (state.modelDeep) tier.deep = state.modelDeep;
              return Object.keys(tier).length > 0 ? { model: tier } : {};
            })()
          : state.model
            ? { model: state.model }
            : {}),
        ...(state.provider ? { provider: state.provider as ProviderId } : {}),
        ...(state.capabilities.length > 0 ? { capabilities: state.capabilities } : {}),
        ...(state.fsReachRead.length > 0 ||
        state.fsReachWrite.length > 0 ||
        state.fsReachWorkdir !== ''
          ? {
              fs_reach: {
                read: state.fsReachRead,
                write: state.fsReachWrite,
                ...(state.fsReachWorkdir ? { workdir: state.fsReachWorkdir } : {}),
              },
            }
          : {}),
        ...(state.plugins.length > 0 ? { plugins: state.plugins } : {}),
        toolset: state.toolset,
        soulMd: state.soulMd,
        skill_evolution: {
          enabled: state.skillEvolutionEnabled,
          min_tool_calls: state.skillEvolutionMinToolCalls,
          cooldown_minutes: state.skillEvolutionCooldownMinutes,
        },
        evolution_approval_mode: state.evolutionApprovalMode,
        // Omitted entirely when none is set, so a personality created without
        // touching these carries no `voice` block at all.
        ...(state.voiceTtsProvider || state.voiceTtsVoice || state.voiceSttProvider
          ? {
              voice: {
                ...(state.voiceTtsProvider ? { tts_provider: state.voiceTtsProvider } : {}),
                ...(state.voiceTtsVoice ? { tts_voice: state.voiceTtsVoice } : {}),
                ...(state.voiceSttProvider ? { stt_provider: state.voiceSttProvider } : {}),
              },
            }
          : {}),
      }),
    onSuccess: async () => {
      if (state.skills.length > 0) {
        try {
          await rpc.personalities.skillsImportGlobal({
            personalityId: state.id,
            skillIds: state.skills,
          });
        } catch {
          notification.warning({
            message: `Created ${state.name}, but skill attachment failed`,
            description: 'Open the personality editor to attach skills manually.',
            placement: 'topRight',
          });
          qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
          qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
          onClose();
          return;
        }
      }
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
  const canCreate = idValid && nameValid && !idCollision && state.soulMd.length > 0;

  return (
    <Modal
      open
      title="New personality"
      onCancel={onClose}
      width={720}
      destroyOnClose
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="primary"
            disabled={!canCreate}
            loading={createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            Create
          </Button>
        </div>
      }
    >
      <Tabs
        defaultActiveKey="basics"
        items={[
          {
            key: 'basics',
            label: 'Basics',
            children: <IdentityStep state={state} setState={setState} idCollision={idCollision} />,
          },
          {
            key: 'soul',
            label: 'Soul',
            children: <SoulMdStep state={state} setState={setState} />,
          },
          {
            key: 'config',
            label: 'Config',
            children: <WizardConfigTab state={state} setState={setState} />,
          },
          {
            key: 'toolset',
            label: 'Toolset',
            children: <ToolsetStep state={state} setState={setState} />,
          },
          {
            key: 'skill-learning',
            label: 'Skill Learning',
            children: <SkillLearningStep state={state} setState={setState} />,
          },
          {
            key: 'skills',
            label: 'Skills',
            children: <WizardSkillsStep state={state} setState={setState} />,
          },
          {
            key: 'plugins',
            label: 'Plugins',
            children: (
              <WizardPluginsTab
                selected={state.plugins}
                onChange={(next) => setState((s) => ({ ...s, plugins: next }))}
              />
            ),
          },
        ]}
      />
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
      <PersonalityVoiceFields
        value={{
          ttsProvider: state.voiceTtsProvider,
          ttsVoice: state.voiceTtsVoice,
          sttProvider: state.voiceSttProvider,
        }}
        onChange={(next) =>
          setState((s) => ({
            ...s,
            voiceTtsProvider: next.ttsProvider,
            voiceTtsVoice: next.ttsVoice,
            voiceSttProvider: next.sttProvider,
          }))
        }
      />
    </Form>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
}

function ToolsetStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  const catalogQuery = useQuery({
    queryKey: ['tools', 'catalog'],
    queryFn: () => rpc.tools.catalog({}),
  });
  const TOOL_GROUPS = (catalogQuery.data?.groups ?? []).map((g) => ({
    group: g.group,
    tools: g.tools.map((t) => t.name),
  }));

  const toggle = (name: string) => {
    setState((s) => {
      const has = s.toolset.includes(name);
      return { ...s, toolset: has ? s.toolset.filter((t) => t !== name) : [...s.toolset, name] };
    });
  };

  const descMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of catalogQuery.data?.groups ?? []) {
      for (const tool of g.tools) {
        if (typeof tool.description === 'string' && tool.description.length > 0) {
          map.set(tool.name, tool.description);
        }
      }
    }
    return map;
  }, [catalogQuery.data]);

  if (catalogQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  if (TOOL_GROUPS.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="Tools will appear after your first chat session."
      >
        <Button size="small" onClick={() => void catalogQuery.refetch()}>
          Refresh
        </Button>
      </Empty>
    );
  }

  return (
    <div>
      <Typography.Paragraph type="secondary">
        Pick the tools this personality can call. Memory and cron tools are pre-selected as
        recommended defaults. You can edit this later.
      </Typography.Paragraph>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {CATEGORY_ORDER.map((cat) => {
          const groups = TOOL_GROUPS.filter((g) => categorizeGroup(g.group) === cat);
          if (groups.length === 0) return null;
          const meta = CATEGORY_META[cat];
          const detail = categoryDetail(cat);
          return (
            <section key={cat}>
              {/* Category header: title + honest boundary chip + (i) details popover.
                  Execution's chip is conditional here — the personality does not exist
                  yet, so there is no resolved posture to fetch. The live posture shows on
                  the Execution tab after creation. We never claim a definitive "Sandboxed". */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--ethos-text-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                >
                  {meta.title}
                </span>
                {cat === 'execution' ? (
                  <span style={{ fontSize: 11, color: 'var(--warning)' }}>
                    ▣ Sandboxed under Docker · host without it
                  </span>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {meta.staticBoundary?.icon} {meta.staticBoundary?.label}
                  </span>
                )}
                <Popover
                  placement="right"
                  title={`${meta.title} — execution boundary`}
                  content={
                    <div style={{ maxWidth: 280, fontSize: 12 }}>
                      <p style={{ margin: '0 0 6px' }}>{detail.whatTheyTouch}</p>
                      <p style={{ margin: '0 0 6px' }}>
                        <strong>Enforced by:</strong> {detail.enforcedBy}
                      </p>
                      {detail.note ? (
                        <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{detail.note}</p>
                      ) : null}
                    </div>
                  }
                >
                  <Button
                    type="text"
                    size="small"
                    aria-label={`About the ${meta.title} execution boundary`}
                    style={{ minWidth: 0, padding: '0 4px', color: 'var(--text-secondary)' }}
                  >
                    ⓘ
                  </Button>
                </Popover>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {groups.map((group) => (
                  <div key={group.group}>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                      {group.group}
                      {group.group === 'Memory' || group.group === 'Cron' ? (
                        <Tag
                          color="blue"
                          bordered={false}
                          style={{ fontSize: 10, marginLeft: 6, verticalAlign: 'middle' }}
                        >
                          recommended
                        </Tag>
                      ) : null}
                    </div>
                    {group.group === 'Cron' ? (
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 11, display: 'block', marginBottom: 4 }}
                      >
                        Requires a running CronScheduler (serve/gateway mode).
                      </Typography.Text>
                    ) : null}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {group.tools.map((tool) => {
                        const enabled = state.toolset.includes(tool);
                        return (
                          <Tooltip
                            key={tool}
                            title={descMap.get(tool) ?? 'No description available'}
                          >
                            <Tag.CheckableTag
                              checked={enabled}
                              onChange={() => toggle(tool)}
                              style={{ padding: '4px 10px', fontSize: 12 }}
                            >
                              {tool}
                            </Tag.CheckableTag>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SkillLearningStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary">
        When enabled, the agent automatically proposes new skills based on repeated tool-call
        patterns. Proposed skills land in a pending queue for review.
      </Typography.Paragraph>
      <Form.Item>
        <Checkbox
          checked={state.skillEvolutionEnabled}
          onChange={(e) => setState((s) => ({ ...s, skillEvolutionEnabled: e.target.checked }))}
        >
          Enable automatic skill learning
        </Checkbox>
      </Form.Item>
      <Form.Item
        label="Minimum tool calls"
        help="Number of tool calls in a turn before the evolver considers proposing a skill (1-20)."
      >
        <Input
          type="number"
          min={1}
          max={20}
          value={state.skillEvolutionMinToolCalls}
          disabled={!state.skillEvolutionEnabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 1 && v <= 20) setState((s) => ({ ...s, skillEvolutionMinToolCalls: v }));
          }}
        />
      </Form.Item>
      <Form.Item
        label="Cooldown (minutes)"
        help="Minimum time between skill proposals to avoid noise."
      >
        <Input
          type="number"
          min={0}
          step={5}
          value={state.skillEvolutionCooldownMinutes}
          disabled={!state.skillEvolutionEnabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v >= 0) setState((s) => ({ ...s, skillEvolutionCooldownMinutes: v }));
          }}
        />
      </Form.Item>
      <Form.Item
        label="Approval mode"
        help="Whether evolved voice updates apply automatically or wait for your approval."
      >
        <Select
          value={state.evolutionApprovalMode}
          onChange={(v) => setState((s) => ({ ...s, evolutionApprovalMode: v }))}
          options={[
            { label: 'Automatic', value: 'auto' },
            { label: 'Requires approval', value: 'user' },
          ]}
        />
      </Form.Item>
    </Form>
  );
}

function SoulMdStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [core, setCore] = useState('');
  const [expression, setExpression] = useState('');
  const [rationale, setRationale] = useState('');

  const splitMut = useMutation({
    mutationFn: () => rpc.personalities.proposeSoulSplit({ soulMd: state.soulMd }),
    onSuccess: (data) => {
      setCore(data.core);
      setExpression(data.expression);
      setRationale(data.rationale);
      setReviewOpen(true);
    },
  });

  const notConfigured = splitMut.isError && errorCode(splitMut.error) === 'NOT_CONFIGURED';

  function applySplit() {
    const sectioned = `# Core\n${core.trim()}\n\n# Expression\n${expression.trim()}\n`;
    setState((s) => ({ ...s, soulMd: sectioned }));
    setReviewOpen(false);
    splitMut.reset();
  }

  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary">
        First-person identity. The agent reads this on every turn — keep it short and concrete.
        Avoid "🚀 ready to help!" boilerplate.
      </Typography.Paragraph>
      <Form.Item required>
        <Input.TextArea
          value={state.soulMd}
          autoSize={{ minRows: 12, maxRows: 24 }}
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
          onChange={(e) => setState((s) => ({ ...s, soulMd: e.target.value }))}
        />
      </Form.Item>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Button
          disabled={state.soulMd.trim().length === 0}
          loading={splitMut.isPending}
          onClick={() => splitMut.mutate()}
        >
          Refine soul
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Proposes a Core / Expression split for you to review before it's applied.
        </Typography.Text>
      </div>
      {notConfigured ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message="Soul refinement needs an LLM configured on the server"
        />
      ) : splitMut.isError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginTop: 12 }}
          message="Couldn't propose a split"
          description={(splitMut.error as Error).message}
        />
      ) : null}

      <Modal
        open={reviewOpen}
        title="Review Core / Expression split"
        onCancel={() => setReviewOpen(false)}
        width={680}
        destroyOnClose
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => setReviewOpen(false)}>Cancel</Button>
            <Button type="primary" onClick={applySplit}>
              Apply split
            </Button>
          </div>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          {rationale}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          Core is your immutable identity; Expression is the voice that can evolve later. Adjust the
          partition below before applying.
        </Typography.Paragraph>
        <Form layout="vertical">
          <Form.Item label="Core">
            <Input.TextArea
              value={core}
              autoSize={{ minRows: 6, maxRows: 16 }}
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
              onChange={(e) => setCore(e.target.value)}
            />
          </Form.Item>
          <Form.Item label="Expression">
            <Input.TextArea
              value={expression}
              autoSize={{ minRows: 6, maxRows: 16 }}
              style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
              onChange={(e) => setExpression(e.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Form>
  );
}

/** Reads the structured `code` off an oRPC client error, if present. */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function WizardSkillsStep({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  const skillsQuery = useQuery({
    queryKey: ['skills', 'list'],
    queryFn: () => rpc.skills.list({}),
  });

  if (skillsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  const skills = skillsQuery.data?.skills ?? [];

  if (skills.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No skills available. Create skills on the Skills page first."
      />
    );
  }

  const systemSkills = skills.filter((s) => s.source === 'system');
  const userSkills = skills.filter((s) => s.source !== 'system');
  const selectedSet = new Set(state.skills);

  const renderCheckbox = (s: Skill) => (
    <Checkbox
      key={s.id}
      checked={selectedSet.has(s.id)}
      onChange={(e) => {
        setState((prev) => {
          const next = new Set(prev.skills);
          if (e.target.checked) next.add(s.id);
          else next.delete(s.id);
          return { ...prev, skills: [...next] };
        });
      }}
    >
      <span style={{ fontWeight: 500 }}>{s.name}</span>
      {s.description ? (
        <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
          {s.description}
        </Typography.Text>
      ) : null}
    </Checkbox>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Typography.Paragraph type="secondary">
        Select skills to attach from the library. Skills can also be added after creation.
      </Typography.Paragraph>
      {systemSkills.length > 0 ? (
        <>
          <Typography.Text strong>System</Typography.Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {systemSkills.map(renderCheckbox)}
          </div>
        </>
      ) : null}
      {userSkills.length > 0 ? (
        <>
          <Typography.Text strong style={systemSkills.length > 0 ? { marginTop: 12 } : {}}>
            My Skills
          </Typography.Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {userSkills.map(renderCheckbox)}
          </div>
        </>
      ) : null}
    </div>
  );
}

function WizardConfigTab({
  state,
  setState,
}: {
  state: WizardState;
  setState: React.Dispatch<React.SetStateAction<WizardState>>;
}) {
  const catalogQuery = useQuery({
    queryKey: ['models', 'catalog'],
    queryFn: () => rpc.models.catalog(),
  });
  const modelOptions = modelOptionsForProvider(catalogQuery.data, state.provider || undefined);
  return (
    <Form layout="vertical">
      <Typography.Paragraph type="secondary">
        Optional. Leave blank to use the global default from Settings.
      </Typography.Paragraph>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Typography.Text strong>Models</Typography.Text>
          <Switch
            size="small"
            checked={state.modelTiered}
            onChange={(checked) =>
              setState((prev) => ({
                ...prev,
                modelTiered: checked,
                model: checked ? '' : prev.model,
                modelTrivial: checked ? prev.modelTrivial : '',
                modelDefault: checked ? prev.modelDefault : '',
                modelDeep: checked ? prev.modelDeep : '',
              }))
            }
            checkedChildren="tiered"
            unCheckedChildren="single"
          />
        </div>
        {state.modelTiered ? (
          <>
            <Form.Item label="Trivial" help="e.g. claude-haiku-4-5">
              <AutoComplete
                value={state.modelTrivial}
                placeholder="claude-haiku-4-5"
                options={modelOptions}
                filterOption={modelFilterOption}
                onChange={(val) => setState((prev) => ({ ...prev, modelTrivial: val }))}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item label="Default" help="e.g. claude-sonnet-4-6">
              <AutoComplete
                value={state.modelDefault}
                placeholder="claude-sonnet-4-6"
                options={modelOptions}
                filterOption={modelFilterOption}
                onChange={(val) => setState((prev) => ({ ...prev, modelDefault: val }))}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item label="Deep" help="e.g. claude-opus-4-7">
              <AutoComplete
                value={state.modelDeep}
                placeholder="claude-opus-4-7"
                options={modelOptions}
                filterOption={modelFilterOption}
                onChange={(val) => setState((prev) => ({ ...prev, modelDeep: val }))}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              default is the model used unless a tier is explicitly selected. trivial and deep are
              selectable tiers. Automatic per-task tier routing is not configured here.
            </Typography.Text>
          </>
        ) : (
          <Form.Item label="Model" help="e.g. claude-opus-4-7, gpt-4o, moonshotai/kimi-k2.6">
            <AutoComplete
              value={state.model}
              placeholder="claude-opus-4-7"
              options={modelOptions}
              filterOption={modelFilterOption}
              onChange={(val) => setState((prev) => ({ ...prev, model: val }))}
              style={{ width: '100%' }}
            />
          </Form.Item>
        )}
      </div>
      <Form.Item
        label="Provider"
        extra="Engine default is set in Settings. Set this only if this personality must route to a specific provider."
      >
        <Select
          allowClear
          placeholder="engine default"
          value={state.provider || undefined}
          onChange={(val) => setState((s) => ({ ...s, provider: val ?? '' }))}
          options={[
            { label: 'Anthropic', value: 'anthropic' },
            { label: 'OpenAI', value: 'openai' },
            { label: 'Codex', value: 'codex' },
            { label: 'OpenRouter', value: 'openrouter' },
            { label: 'OpenAI Compatible', value: 'openai-compat' },
            { label: 'Ollama', value: 'ollama' },
            { label: 'Azure', value: 'azure' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label={
          <span>
            Capabilities{' '}
            <Tooltip title="Tells the team what kind of work this agent does — e.g. coding, triage, release. Used when this agent collaborates with or delegates to other agents (mesh routing).">
              <InfoCircleOutlined style={{ color: 'var(--text-tertiary)' }} />
            </Tooltip>
          </span>
        }
        extra="What kind of work this agent does, e.g. coding, triage, release. Helps other agents route work to it when working as a team."
      >
        <Select
          mode="tags"
          allowClear
          placeholder="add capability tags"
          tokenSeparators={[',']}
          value={state.capabilities}
          onChange={(val) => setState((s) => ({ ...s, capabilities: val }))}
        />
      </Form.Item>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Filesystem reach"
        description="These paths control which directories this personality can read and write. Adding broad paths (e.g. /, /home) lets the personality access anything inside. Edit only if you understand the implications."
      />
      <Form.Item label="Read paths" extra={FS_REACH_READ_HELP}>
        <Select
          mode="tags"
          allowClear
          placeholder={FS_REACH_READ_PLACEHOLDER}
          tokenSeparators={[',']}
          value={state.fsReachRead}
          onChange={(val) => setState((s) => ({ ...s, fsReachRead: val }))}
        />
      </Form.Item>
      <Form.Item label="Write paths" extra={FS_REACH_WRITE_HELP}>
        <Select
          mode="tags"
          allowClear
          placeholder="e.g. /data/output"
          tokenSeparators={[',']}
          value={state.fsReachWrite}
          onChange={(val) => setState((s) => ({ ...s, fsReachWrite: val }))}
        />
      </Form.Item>
      <Form.Item label="Working directory" extra={FS_REACH_WORKDIR_HELP}>
        <Input
          placeholder={FS_REACH_WORKDIR_PLACEHOLDER}
          value={state.fsReachWorkdir}
          onChange={(e) => setState((s) => ({ ...s, fsReachWorkdir: e.target.value }))}
        />
      </Form.Item>
    </Form>
  );
}

function WizardPluginsTab({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [installOpen, setInstallOpen] = useState(false);
  const [packageSpec, setPackageSpec] = useState('');

  const pluginsQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const installMut = useMutation({
    mutationFn: () => rpc.plugins.install({ packageSpec: packageSpec.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plugins', 'list'] });
      setPackageSpec('');
      setInstallOpen(false);
      notification.success({ message: 'Plugin installed', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Install failed', description: (err as Error).message }),
  });

  if (pluginsQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
        <Spin />
      </div>
    );
  }

  const plugins = pluginsQuery.data?.plugins ?? [];
  const selectedSet = new Set(selected);

  function toggle(pluginId: string, on: boolean) {
    const next = new Set(selectedSet);
    if (on) next.add(pluginId);
    else next.delete(pluginId);
    onChange([...next]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        {installOpen ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <Input
              autoFocus
              placeholder="npm package name or path"
              value={packageSpec}
              onChange={(e) => setPackageSpec(e.target.value)}
              onPressEnter={() => installMut.mutate()}
              style={{ flex: 1 }}
            />
            <Button
              type="primary"
              size="small"
              loading={installMut.isPending}
              disabled={!packageSpec.trim()}
              onClick={() => installMut.mutate()}
            >
              Install
            </Button>
            <Button
              size="small"
              onClick={() => {
                setInstallOpen(false);
                setPackageSpec('');
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="small" onClick={() => setInstallOpen(true)} style={{ marginBottom: 12 }}>
            Install plugin
          </Button>
        )}
      </div>
      {plugins.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              No plugins installed.{' '}
              <Typography.Text code>ethos plugin install &lt;path&gt;</Typography.Text>
            </span>
          }
        />
      ) : (
        <>
          {selectedSet.size === 0 ? (
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
                checked={selectedSet.has(p.id)}
                onChange={(on) => toggle(p.id, on)}
                aria-label={`Attach ${p.name}`}
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
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP Tokens — set / remove bearer tokens for attached MCP servers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edit modal — three tabs (Identity / Toolset / Config) + Skills sub-surface
// ---------------------------------------------------------------------------

export function EditModal({ id, onClose }: { id: string; onClose: () => void }) {
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
          defaultActiveKey="characterSheet"
          items={[
            {
              key: 'characterSheet',
              label: 'Character sheet',
              children: <CharacterSheetPanel id={id} />,
            },
            {
              key: 'identity',
              label: 'Identity',
              children: <IdentityEditor id={id} initialSoulMd={data.soulMd} />,
            },
            {
              key: 'toolset',
              label: 'Toolset',
              children: <ToolsetEditor id={id} initialToolset={data.personality.toolset ?? []} />,
            },
            {
              key: 'execution',
              label: 'Execution',
              children: <ExecutionTab id={id} />,
            },
            {
              key: 'config',
              label: 'Config',
              children: <ConfigEditor id={id} personality={data.personality} />,
            },
            {
              key: 'soul',
              label: 'Living Soul',
              children: <LivingSoulSection personalityId={id} />,
            },
            {
              key: 'skills',
              label: 'Skills',
              children: <PersonalitySkillsPanel personalityId={id} />,
            },
            {
              key: 'plugins',
              label: 'Plugins',
              children: (
                <PluginsAttachPanel id={id} initialPlugins={data.personality.plugins ?? []} />
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}

// The generated character sheet — one screen of what the personality is,
// what it has, and what it can reach. Same Markdown artifact `ethos
// personality show` prints; rendered read-only here as the primary read.
function CharacterSheetPanel({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['personalities', 'characterSheet', id],
    queryFn: () => rpc.personalities.characterSheet({ id }),
  });

  if (isLoading || !data) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 240 }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Auto-generated from config + SOUL.md — the same artifact <code>ethos personality show</code>{' '}
        prints.
      </Typography.Paragraph>
      <pre
        style={{
          fontFamily: 'Geist Mono, monospace',
          fontSize: 12.5,
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}
      >
        {data.markdown}
      </pre>
    </>
  );
}

export function IdentityEditor({ id, initialSoulMd }: { id: string; initialSoulMd: string }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [draft, setDraft] = useState(initialSoulMd);

  const mut = useMutation({
    mutationFn: () => rpc.personalities.update({ id, soulMd: draft }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'SOUL.md saved', placement: 'topRight' });
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
        disabled={draft === initialSoulMd}
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
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
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
      <ToolsetAffordances draft={draft} />
    </Form>
  );
}

// Per-tool affordance legend (Phase 2a, lane E2). Exec tools route through the
// execution backend ("runs sandboxed", linking to the Execution tab); host-side
// tools stay app-confined. No per-tool docker variants — posture is a property
// of the persona, set on the Execution tab.
function ToolsetAffordances({ draft }: { draft: string }) {
  const tools = draft
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (tools.length === 0) return null;
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 11, letterSpacing: '0.04em' }}>
        EXECUTION
      </Typography.Text>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
        {tools.map((tool) => {
          const a = toolAffordance(tool);
          return (
            <div key={tool} style={{ display: 'flex', gap: 10, fontSize: 12.5 }}>
              <span style={{ fontFamily: 'Geist Mono, monospace', minWidth: 140 }}>{tool}</span>
              {a.kind === 'exec' ? (
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  runs sandboxed ↗ Execution
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  host-side (app-confined)
                </Typography.Text>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text for the UI, not a template variable
const FS_REACH_READ_PLACEHOLDER = 'e.g. /data, ${self}/docs';

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder text for the UI, not a template variable
const FS_REACH_WORKDIR_PLACEHOLDER = 'e.g. ${ETHOS_HOME}/workspace/${self}';

const FS_REACH_READ_HELP = 'Directories this personality may read from.';

const FS_REACH_WRITE_HELP = 'Directories this personality may write to.';

const FS_REACH_WORKDIR_HELP =
  'The one folder bare filenames land in — the output home for this personality, and what the Documents tab lists for download and deletion. Recommended: without it, output goes to whatever directory the server was started in.';

export function ConfigEditor({ id, personality }: { id: string; personality: Personality }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [form] = Form.useForm<{
    name: string;
    description: string;
    provider: ProviderId | '';
    model: string;
    modelTrivial: string;
    modelDefault: string;
    modelDeep: string;
    capabilities: string[];
    fsReachRead: string[];
    fsReachWrite: string[];
    fsReachWorkdir: string;
    dreaming: boolean;
    dreamingIdleMinutes: number;
    dreamingMaxPerDay: number;
    evolutionApprovalMode: 'auto' | 'user';
    skillEvolutionEnabled: boolean;
    skillEvolutionEvolveExisting: boolean;
    skillEvolutionPromotion: 'review' | 'auto';
    skillEvolutionScope: 'personality' | 'shared';
    skillEvolutionMinToolCalls: number;
    skillEvolutionCooldownMinutes: number;
    skillEvolutionModel: string;
    safetyApprovalMode: 'manual' | 'smart' | 'off';
    memoryProvider: string;
    nightlyEnabled: boolean;
    nightlyJudgeEnabled: boolean;
    nightlyJudgeMinInteractions: number;
    nightlyExpression: boolean;
  }>();
  const [tieredMode, setTieredMode] = useState(
    typeof personality.model === 'object' && personality.model !== null,
  );
  // Voice lives outside the Antd form: `PersonalityVoiceFields` is a controlled
  // pair (the voice control switches between a select and free text as the
  // provider changes), and threading that through registered Form.Items buys
  // nothing but indirection.
  const [voice, setVoice] = useState<PersonalityVoice>({
    ttsProvider: '',
    ttsVoice: '',
    sttProvider: '',
  });
  const catalogQuery = useQuery({
    queryKey: ['models', 'catalog'],
    queryFn: () => rpc.models.catalog(),
  });
  const watchedProvider = Form.useWatch('provider', form);
  const modelOptions = modelOptionsForProvider(catalogQuery.data, watchedProvider || undefined);

  useEffect(() => {
    const m = personality.model;
    const isObj = typeof m === 'object' && m !== null;
    setTieredMode(isObj);
    form.setFieldsValue({
      name: personality.name,
      description: personality.description ?? '',
      provider: (personality.provider ?? '') as ProviderId | '',
      model: isObj ? '' : (m ?? ''),
      modelTrivial: isObj ? (m.trivial ?? '') : '',
      modelDefault: isObj ? (m.default ?? '') : '',
      modelDeep: isObj ? (m.deep ?? '') : '',
      capabilities: personality.capabilities ?? [],
      fsReachRead: personality.fs_reach?.read ?? [],
      fsReachWrite: personality.fs_reach?.write ?? [],
      fsReachWorkdir: personality.fs_reach?.workdir ?? '',
      dreaming: personality.dreaming?.enable ?? false,
      dreamingIdleMinutes: personality.dreaming?.idleMinutes ?? 60,
      dreamingMaxPerDay: personality.dreaming?.maxPerDay ?? 1,
      evolutionApprovalMode: personality.evolution_approval_mode ?? 'user',
      skillEvolutionEnabled: personality.skill_evolution?.enabled ?? false,
      skillEvolutionEvolveExisting:
        personality.skill_evolution?.evolve_existing ??
        personality.skill_evolution?.enabled ??
        false,
      skillEvolutionPromotion: personality.skill_evolution?.promotion ?? 'review',
      skillEvolutionScope: personality.skill_evolution?.scope ?? 'shared',
      skillEvolutionMinToolCalls: personality.skill_evolution?.min_tool_calls ?? 3,
      skillEvolutionCooldownMinutes: personality.skill_evolution?.cooldown_minutes ?? 30,
      skillEvolutionModel: personality.skill_evolution?.model ?? '',
      safetyApprovalMode: personality.safety?.approvalMode ?? 'manual',
      memoryProvider: personality.memory?.provider ?? 'markdown',
      nightlyEnabled: personality.nightly?.enabled ?? true,
      nightlyJudgeEnabled: personality.nightly?.judge?.enabled ?? true,
      nightlyJudgeMinInteractions: personality.nightly?.judge?.minInteractions ?? 20,
      nightlyExpression: personality.nightly?.expression ?? true,
    });
    setVoice({
      ttsProvider: personality.voice?.tts_provider ?? '',
      ttsVoice: personality.voice?.tts_voice ?? '',
      sttProvider: personality.voice?.stt_provider ?? '',
    });
  }, [personality, form]);

  const mut = useMutation({
    mutationFn: (values: {
      name: string;
      description: string;
      provider: ProviderId | '';
      model: string;
      modelTrivial: string;
      modelDefault: string;
      modelDeep: string;
      capabilities: string[];
      fsReachRead: string[];
      fsReachWrite: string[];
      fsReachWorkdir: string;
      dreaming: boolean;
      dreamingIdleMinutes: number;
      dreamingMaxPerDay: number;
      evolutionApprovalMode: 'auto' | 'user';
      skillEvolutionEnabled: boolean;
      skillEvolutionEvolveExisting: boolean;
      skillEvolutionPromotion: 'review' | 'auto';
      skillEvolutionScope: 'personality' | 'shared';
      skillEvolutionMinToolCalls: number;
      skillEvolutionCooldownMinutes: number;
      skillEvolutionModel: string;
      safetyApprovalMode: 'manual' | 'smart' | 'off';
      memoryProvider: string;
      nightlyEnabled: boolean;
      nightlyJudgeEnabled: boolean;
      nightlyJudgeMinInteractions: number;
      nightlyExpression: boolean;
    }) => {
      let model: string | ModelTierConfigWire;
      if (tieredMode) {
        const tier: ModelTierConfigWire = {};
        if (values.modelTrivial) tier.trivial = values.modelTrivial;
        if (values.modelDefault) tier.default = values.modelDefault;
        if (values.modelDeep) tier.deep = values.modelDeep;
        model = Object.keys(tier).length > 0 ? tier : '';
      } else {
        model = values.model;
      }
      return rpc.personalities.update({
        id,
        name: values.name,
        description: values.description,
        model,
        provider: values.provider || '',
        capabilities: values.capabilities,
        // `workdir` is always sent, empty string included: the registry
        // shallow-merges fs_reach sub-keys, so omitting it would preserve the
        // stored value and make the field impossible to clear from here.
        fs_reach: {
          read: values.fsReachRead,
          write: values.fsReachWrite,
          workdir: values.fsReachWorkdir,
        },
        dreaming: {
          enable: values.dreaming,
          idleMinutes: values.dreamingIdleMinutes,
          maxPerDay: values.dreamingMaxPerDay,
        },
        evolution_approval_mode: values.evolutionApprovalMode,
        skill_evolution: {
          enabled: values.skillEvolutionEnabled,
          evolve_existing: values.skillEvolutionEvolveExisting,
          promotion: values.skillEvolutionPromotion,
          scope: values.skillEvolutionScope,
          min_tool_calls: values.skillEvolutionMinToolCalls,
          cooldown_minutes: values.skillEvolutionCooldownMinutes,
          ...(values.skillEvolutionModel ? { model: values.skillEvolutionModel } : {}),
        },
        safety: { approvalMode: values.safetyApprovalMode },
        memory: { provider: values.memoryProvider },
        // Every sub-key always sent, empty string included: the registry
        // shallow-merges the voice block, so omitting one would preserve the
        // stored value and make "back to the default provider" unexpressible.
        voice: {
          tts_provider: voice.ttsProvider,
          tts_voice: voice.ttsVoice,
          stt_provider: voice.sttProvider,
        },
        nightly: {
          enabled: values.nightlyEnabled,
          judge: {
            enabled: values.nightlyJudgeEnabled,
            minInteractions: values.nightlyJudgeMinInteractions,
          },
          expression: values.nightlyExpression,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
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
          provider: values.provider,
          model: values.model,
          modelTrivial: values.modelTrivial ?? '',
          modelDefault: values.modelDefault ?? '',
          modelDeep: values.modelDeep ?? '',
          capabilities: values.capabilities ?? [],
          fsReachRead: values.fsReachRead ?? [],
          fsReachWrite: values.fsReachWrite ?? [],
          fsReachWorkdir: values.fsReachWorkdir ?? '',
          dreaming: values.dreaming ?? false,
          dreamingIdleMinutes: values.dreamingIdleMinutes ?? 60,
          dreamingMaxPerDay: values.dreamingMaxPerDay ?? 1,
          evolutionApprovalMode: values.evolutionApprovalMode ?? 'user',
          skillEvolutionEnabled: values.skillEvolutionEnabled ?? false,
          skillEvolutionEvolveExisting: values.skillEvolutionEvolveExisting ?? false,
          skillEvolutionPromotion: values.skillEvolutionPromotion ?? 'review',
          skillEvolutionScope: values.skillEvolutionScope ?? 'shared',
          skillEvolutionMinToolCalls: values.skillEvolutionMinToolCalls ?? 3,
          skillEvolutionCooldownMinutes: values.skillEvolutionCooldownMinutes ?? 30,
          skillEvolutionModel: values.skillEvolutionModel ?? '',
          safetyApprovalMode: values.safetyApprovalMode ?? 'manual',
          memoryProvider: values.memoryProvider ?? 'markdown',
          nightlyEnabled: values.nightlyEnabled ?? true,
          nightlyJudgeEnabled: values.nightlyJudgeEnabled ?? true,
          nightlyJudgeMinInteractions: values.nightlyJudgeMinInteractions ?? 20,
          nightlyExpression: values.nightlyExpression ?? true,
        })
      }
    >
      <Form.Item label="Name" name="name" rules={[{ required: true, message: 'Required' }]}>
        <Input />
      </Form.Item>
      <Form.Item label="Description" name="description">
        <Input />
      </Form.Item>
      <PersonalityVoiceFields value={voice} onChange={setVoice} />
      <Form.Item
        label="Provider"
        name="provider"
        extra="Engine default is set in Settings. Set this only if this personality must route to a specific provider."
      >
        <Select
          allowClear
          placeholder="engine default"
          options={[
            { label: 'Anthropic', value: 'anthropic' },
            { label: 'OpenAI', value: 'openai' },
            { label: 'Codex', value: 'codex' },
            { label: 'OpenRouter', value: 'openrouter' },
            { label: 'OpenAI Compatible', value: 'openai-compat' },
            { label: 'Ollama', value: 'ollama' },
            { label: 'Azure', value: 'azure' },
          ]}
        />
      </Form.Item>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Typography.Text strong>Models</Typography.Text>
          <Switch
            size="small"
            checked={tieredMode}
            onChange={(checked) => {
              setTieredMode(checked);
              if (!checked) {
                form.setFieldsValue({ modelTrivial: '', modelDefault: '', modelDeep: '' });
              } else {
                form.setFieldsValue({ model: '' });
              }
            }}
            checkedChildren="tiered"
            unCheckedChildren="single"
          />
        </div>
        {tieredMode ? (
          <>
            <Form.Item label="Trivial" name="modelTrivial" style={{ marginBottom: 8 }}>
              <AutoComplete
                placeholder="e.g. claude-haiku-4-5"
                options={modelOptions}
                filterOption={modelFilterOption}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item label="Default" name="modelDefault" style={{ marginBottom: 8 }}>
              <AutoComplete
                placeholder="e.g. claude-sonnet-4-6"
                options={modelOptions}
                filterOption={modelFilterOption}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item label="Deep" name="modelDeep" style={{ marginBottom: 8 }}>
              <AutoComplete
                placeholder="e.g. claude-opus-4-7"
                options={modelOptions}
                filterOption={modelFilterOption}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              default is the model used unless a tier is explicitly selected. trivial and deep are
              selectable tiers. Automatic per-task tier routing is not configured here.
            </Typography.Text>
          </>
        ) : (
          <Form.Item label="Model" name="model" style={{ marginBottom: 0 }}>
            <AutoComplete
              placeholder="optional override"
              options={modelOptions}
              filterOption={modelFilterOption}
              style={{ width: '100%' }}
            />
          </Form.Item>
        )}
      </div>
      <Form.Item label="Memory scope">
        <Typography.Text>per-personality</Typography.Text>
      </Form.Item>
      <Form.Item
        label={
          <span>
            Capabilities{' '}
            <Tooltip title="Tells the team what kind of work this agent does — e.g. coding, triage, release. Used when this agent collaborates with or delegates to other agents (mesh routing).">
              <InfoCircleOutlined style={{ color: 'var(--text-tertiary)' }} />
            </Tooltip>
          </span>
        }
        name="capabilities"
        extra="What kind of work this agent does, e.g. coding, triage, release. Helps other agents route work to it when working as a team."
      >
        <Select mode="tags" allowClear placeholder="add capability tags" tokenSeparators={[',']} />
      </Form.Item>
      <Form.Item label="Dreaming" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="dreaming" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Periodic background memory consolidation for this personality.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.dreaming !== cur.dreaming}>
        {({ getFieldValue }) =>
          getFieldValue('dreaming') ? (
            <>
              <Form.Item
                label="Idle minutes"
                name="dreamingIdleMinutes"
                extra="How long idle before a background dream turn."
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                label="Max per day"
                name="dreamingMaxPerDay"
                extra="Cap on dream turns per rolling 24h."
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </>
          ) : null
        }
      </Form.Item>
      <Form.Item
        label="Approval mode"
        name="evolutionApprovalMode"
        extra="Whether evolved voice updates apply automatically or wait for your approval."
      >
        <Select
          options={[
            { label: 'Automatic', value: 'auto' },
            { label: 'Requires approval', value: 'user' },
          ]}
        />
      </Form.Item>
      <Form.Item label="Skill creation" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="skillEvolutionEnabled" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Auto-generate new skills from repeated task patterns.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item label="Skill evolution" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="skillEvolutionEvolveExisting" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Improve existing skills during eval-driven evolution. Does not affect the nightly create
            path.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item
        label="Promotion"
        name="skillEvolutionPromotion"
        extra="Review queues a new skill for your approval; Auto promotes it automatically."
      >
        <Segmented
          options={[
            { label: 'Review', value: 'review' },
            { label: 'Auto', value: 'auto' },
          ]}
        />
      </Form.Item>
      <Form.Item label="Scope" name="skillEvolutionScope" extra="Where a promoted skill is saved.">
        <Segmented
          options={[
            { label: 'This personality', value: 'personality' },
            { label: 'Shared', value: 'shared' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Minimum tool calls"
        name="skillEvolutionMinToolCalls"
        extra="Tool calls in a turn before the evolver considers proposing a skill (1-20)."
      >
        <InputNumber min={1} max={20} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Cooldown (minutes)"
        name="skillEvolutionCooldownMinutes"
        extra="Minimum time between skill proposals to avoid noise."
      >
        <InputNumber min={0} step={5} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item
        label="Model"
        name="skillEvolutionModel"
        extra="Model the skill evolver uses. Leave empty for the engine default."
      >
        <Input placeholder="engine default" />
      </Form.Item>
      <Form.Item
        label="Approval mode (safety)"
        name="safetyApprovalMode"
        extra="What the agent may do without asking — Manual asks every sensitive call; Smart asks only high-risk; Off runs all, trusted machines only."
      >
        <Select
          options={[
            { label: 'Manual', value: 'manual' },
            { label: 'Smart', value: 'smart' },
            { label: 'Off', value: 'off' },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="Memory backend"
        name="memoryProvider"
        extra="Where this personality stores memory. Markdown is human-editable; Vector uses embeddings for semantic recall."
      >
        <Select
          options={[
            { label: 'Markdown', value: 'markdown' },
            { label: 'Vector', value: 'vector' },
          ]}
        />
      </Form.Item>
      <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
        Nightly learning
      </Typography.Text>
      <Form.Item label="Nightly learning pass" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="nightlyEnabled" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Master switch for the nightly governed-learning sweep.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item label="Personality Judge" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="nightlyJudgeEnabled" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Score recent responses against Core; needs at least N interactions.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item
        noStyle
        shouldUpdate={(prev, cur) => prev.nightlyJudgeEnabled !== cur.nightlyJudgeEnabled}
      >
        {({ getFieldValue }) =>
          getFieldValue('nightlyJudgeEnabled') ? (
            <Form.Item
              label="Activation threshold"
              name="nightlyJudgeMinInteractions"
              extra="Minimum interactions before the Judge scores this personality."
            >
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
          ) : null
        }
      </Form.Item>
      <Form.Item label="Expression evolution" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Form.Item name="nightlyExpression" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Sharpen voice toward what works during the nightly pass.
          </Typography.Text>
        </div>
      </Form.Item>
      <Form.Item>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Provider API keys and Web API keys are account-wide — manage them in{' '}
          <Link to="/settings">Settings</Link>.
        </Typography.Text>
      </Form.Item>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Filesystem reach"
        description="These paths control which directories this personality can read and write. Adding broad paths (e.g. /, /home) lets the personality access anything inside. Edit only if you understand the implications."
      />
      <Form.Item label="Read paths" name="fsReachRead" extra={FS_REACH_READ_HELP}>
        <Select
          mode="tags"
          allowClear
          placeholder={FS_REACH_READ_PLACEHOLDER}
          tokenSeparators={[',']}
        />
      </Form.Item>
      <Form.Item label="Write paths" name="fsReachWrite" extra={FS_REACH_WRITE_HELP}>
        <Select mode="tags" allowClear placeholder="e.g. /data/output" tokenSeparators={[',']} />
      </Form.Item>
      <Form.Item label="Working directory" name="fsReachWorkdir" extra={FS_REACH_WORKDIR_HELP}>
        <Input placeholder={FS_REACH_WORKDIR_PLACEHOLDER} />
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
                <div style={{ color: 'var(--ethos-text-dim)', fontSize: 11 }}>{s.id}.md</div>
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
    queryFn: () => rpc.skills.list({}),
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
          Copies all four files (SOUL.md, toolset.yaml, config.yaml, skills/) into{' '}
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
// MCP servers panel — checkbox list of all configured MCP servers, each with
// a per-server tool checklist (loaded from the personality's mcp.yaml).
// Saves via personalities.update({ mcp_servers, mcp_tools }).
// ---------------------------------------------------------------------------

// Per-server tool selection state held in the parent so Save can build the
// `mcp_tools` payload. `tools` is the set of discovered tool names; `null`
// means tools have not been discovered yet (or the server is unreachable).
export type ServerToolState = {
  /** All bare tool names the server exposes, or null when undiscovered. */
  tools: string[] | null;
  /** Currently-checked bare tool names. */
  selected: Set<string>;
};

// A server with no `tools` entry in mcp.yaml = all tools allowed.
export function initialSelectionFor(
  serverName: string,
  policy: McpPolicy | null,
): string[] | undefined {
  return policy?.servers?.[serverName]?.tools;
}

export function ServerToolChecklist({
  personalityId,
  serverName,
  state,
  onDiscovered,
  onToggle,
}: {
  personalityId: string;
  serverName: string;
  state: ServerToolState | undefined;
  onDiscovered: (tools: string[]) => void;
  onToggle: (toolName: string) => void;
}) {
  const [allTools, setAllTools] = useState<{ name: string; description?: string }[]>([]);
  const [displayCount, setDisplayCount] = useState(50);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [available, setAvailable] = useState(false);
  const fetchedRef = useRef(false);

  const stableOnDiscovered = useCallback(onDiscovered, [onDiscovered]);

  const load = useCallback(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    let cancelled = false;

    async function fetchAllTools() {
      const collected: { name: string; description?: string }[] = [];
      let cursor: string | undefined;
      let serverAvailable = false;
      do {
        const result = await rpc.mcp.serverTools({
          personalityId,
          serverName,
          limit: 200,
          cursor,
        });
        if (cancelled) return;
        serverAvailable = result.available ?? false;
        collected.push(...result.tools);
        cursor = result.nextCursor ?? undefined;
      } while (cursor);

      if (!cancelled) {
        setAvailable(serverAvailable);
        setAllTools(collected);
        setLoading(false);
        if (collected.length > 0) {
          stableOnDiscovered(collected.map((t) => t.name));
        }
      }
    }

    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), 10_000),
    );
    Promise.race([fetchAllTools(), timeout]).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [personalityId, serverName, stableOnDiscovered]);

  if (!expanded) {
    return (
      <div style={{ paddingLeft: 24, paddingTop: 2 }}>
        <Button
          type="link"
          size="small"
          style={{ padding: 0, fontSize: 11, height: 'auto' }}
          onClick={() => {
            setExpanded(true);
            load();
          }}
        >
          Configure tools ▾
        </Button>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ paddingLeft: 24, paddingTop: 4 }}>
        <Spin size="small" />
      </div>
    );
  }

  if (!available || allTools.length === 0) {
    return (
      <Typography.Text
        type="secondary"
        style={{ fontSize: 11, display: 'block', paddingLeft: 24, paddingTop: 2 }}
      >
        Tool list unavailable — the server may not be reachable. All tools remain allowed.
      </Typography.Text>
    );
  }

  const visibleTools = allTools.slice(0, displayCount);
  const hasMore = displayCount < allTools.length;

  return (
    <div style={{ paddingLeft: 24, paddingTop: 4 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {visibleTools.map((tool) => (
          <Tag.CheckableTag
            key={tool.name}
            checked={state?.selected.has(tool.name) ?? true}
            onChange={() => onToggle(tool.name)}
            style={{ padding: '4px 10px', fontSize: 12 }}
          >
            {tool.name}
          </Tag.CheckableTag>
        ))}
      </div>
      {hasMore ? (
        <Button
          size="small"
          type="link"
          onClick={() => setDisplayCount((n) => n + 50)}
          style={{ paddingLeft: 0, marginTop: 4 }}
        >
          Show more tools ({allTools.length - displayCount} remaining)
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugins attach panel — toggle per plugin, optimistic updates.
// Saves via personalities.update({ plugins: [...] }).
// ---------------------------------------------------------------------------

function PluginsAttachPanel({ id, initialPlugins }: { id: string; initialPlugins: string[] }) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [attached, setAttached] = useState<Set<string>>(new Set(initialPlugins));

  const pluginsQuery = useQuery({
    queryKey: ['plugins', 'list'],
    queryFn: () => rpc.plugins.list(),
  });

  const mut = useMutation({
    mutationFn: (next: string[]) => rpc.personalities.update({ id, plugins: next }),
    onMutate: () => ({ prev: new Set(attached) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
    },
    onError: (err, _vars, ctx) => {
      if (ctx) setAttached(ctx.prev);
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
    const next = new Set(attached);
    if (on) next.add(pluginId);
    else next.delete(pluginId);
    setAttached(next);
    mut.mutate([...next]);
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
