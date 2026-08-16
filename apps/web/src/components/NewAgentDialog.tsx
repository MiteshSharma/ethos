import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, AutoComplete, Button, Form, Input, Modal } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePersonalityList } from '../features/personalities/api/queries';
import { buildWorkspaceChatPath } from '../lib/workspaceRoutes';
import {
  modelFilterOption,
  modelOptionsForProvider,
  SkillsPicker,
  slugify,
  ToolsetPicker,
} from '../pages/Personalities';
import { rpc } from '../rpc';
import { PersonalityMark } from './ui/PersonalityMark';

// P5 item 1 (plan/phases/personality-first-ui.md) — the "New agent" fast
// path, reachable as "Quick create" from the AltitudeRail `+` dropdown. A
// single-screen alternative to the `personality-architect` chat flow at
// `/personality/create` — not a replacement for it. Reuses the same
// slug/mark/toolset/skills building blocks the full create wizard
// (`CreateWizard` in `pages/Personalities.tsx`) already ships, parameterized
// down to just the fast-path fields: name, live slug, mark + accent preview,
// SOUL core, model, toolset, starting skills.

const DEFAULT_TOOLSET = ['memory_read', 'memory_write', 'session_search', 'cron'];

interface NewAgentState {
  name: string;
  id: string;
  soulMd: string;
  model: string;
  toolset: string[];
  skills: string[];
}

const INITIAL_STATE: NewAgentState = {
  name: '',
  id: '',
  soulMd: '',
  model: '',
  toolset: DEFAULT_TOOLSET,
  skills: [],
};

export function NewAgentDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [state, setState] = useState<NewAgentState>(INITIAL_STATE);

  const { data: listData } = usePersonalityList();
  const existingIds = useMemo(() => new Set((listData?.items ?? []).map((p) => p.id)), [listData]);

  // No provider field in the fast path (that's an advanced/wizard concern),
  // so suggestions are gathered across every provider in the catalog rather
  // than filtered to one — same `modelOptionsForProvider` mapping the full
  // wizard uses per-provider, just applied to each provider and concatenated.
  const catalogQuery = useQuery({
    queryKey: ['models', 'catalog'],
    queryFn: () => rpc.models.catalog(),
  });
  const modelOptions = useMemo(() => {
    const catalog = catalogQuery.data;
    if (!catalog) return [];
    return Object.keys(catalog.providers).flatMap((provider) =>
      modelOptionsForProvider(catalog, provider),
    );
  }, [catalogQuery.data]);

  const createMut = useMutation({
    mutationFn: () =>
      rpc.personalities.create({
        id: state.id,
        name: state.name,
        soulMd: state.soulMd,
        toolset: state.toolset,
        ...(state.model ? { model: state.model } : {}),
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
          navigate(buildWorkspaceChatPath(state.id));
          return;
        }
      }
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Created ${state.name}`, placement: 'topRight' });
      onClose();
      navigate(buildWorkspaceChatPath(state.id));
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
      title="Quick create"
      onCancel={onClose}
      width={640}
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
      <Form layout="vertical">
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ flexShrink: 0, marginTop: 28 }}>
            {state.id ? (
              <PersonalityMark personalityId={state.id} size={48} />
            ) : (
              <div
                aria-hidden="true"
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 'var(--radius-md)',
                  border: '1px dashed var(--ethos-border)',
                }}
              />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <Form.Item
              label="Name"
              required
              help="Display name. The id below is derived from this."
            >
              <Input
                autoFocus
                value={state.name}
                placeholder="e.g. Strategist"
                onChange={(e) => {
                  const name = e.target.value;
                  const derivedId = slugify(name);
                  setState((s) => ({
                    ...s,
                    name,
                    id: s.id === slugify(s.name) ? derivedId : s.id,
                  }));
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
          </div>
        </div>

        <Form.Item label="SOUL core" required>
          <Input.TextArea
            value={state.soulMd}
            placeholder="First-person identity — who is this agent and how do they respond?"
            autoSize={{ minRows: 6, maxRows: 14 }}
            style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
            onChange={(e) => setState((s) => ({ ...s, soulMd: e.target.value }))}
          />
        </Form.Item>

        <Form.Item
          label="Model"
          help="Optional. Leave blank to use the global default from Settings."
        >
          <AutoComplete
            value={state.model}
            placeholder="claude-opus-4-7"
            options={modelOptions}
            filterOption={modelFilterOption}
            onChange={(val) => setState((s) => ({ ...s, model: val }))}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <Form.Item label="Toolset">
          <ToolsetPicker
            selected={state.toolset}
            onToggle={(tool) =>
              setState((s) => {
                const has = s.toolset.includes(tool);
                return {
                  ...s,
                  toolset: has ? s.toolset.filter((t) => t !== tool) : [...s.toolset, tool],
                };
              })
            }
          />
        </Form.Item>

        <Form.Item label="Starting skills">
          <SkillsPicker
            selected={state.skills}
            onToggle={(skillId) =>
              setState((prev) => {
                const next = new Set(prev.skills);
                if (next.has(skillId)) next.delete(skillId);
                else next.add(skillId);
                return { ...prev, skills: [...next] };
              })
            }
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
