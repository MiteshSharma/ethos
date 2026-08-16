import { useQuery } from '@tanstack/react-query';
import { Input, Modal } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfig } from '../features/config/api/queries';
import { usePersonalityList } from '../features/personalities/api/queries';
import { useNewSessionModal } from '../hooks/useNewSessionModal';
import { getLastPersonalityId } from '../lib/lastPersonality';
import { setLastSessionId } from '../lib/lastSession';
import {
  agentEntries,
  createActionEntries,
  libraryPageEntries,
  type PaletteEntry,
  workspacePageEntries,
} from '../lib/paletteDestinations';
import { capitalize } from '../lib/scopeNav';
import { resolveFallbackPersonalityId } from '../lib/workspaceRoutes';
import { rpc } from '../rpc';

// ⌘K command palette — global keyboard nav surface that indexes every
// reachable destination + the user's recent state.
//
// Four groups, each a `kind` per P5 (plan/phases/personality-first-ui.md):
//   1. Agents      — jump straight to an agent's Chat (its workspace home).
//   2. Pages       — both altitudes' destinations. Library (machine-wide)
//                    entries are context-free; the workspace entries that
//                    have no Library twin (Schedule, Memory, Documents,
//                    workspace Skills/MCP/Plugins, Goals, Tasks, Identity)
//                    resolve to the SAME fallback personality `/` and `/chat`
//                    use — last-visited agent, else config default — so
//                    they're always present and searchable regardless of
//                    which altitude you opened the palette from. The row's
//                    hint names which agent a workspace entry lands you in.
//   3. Sessions    — most recent N from the same SessionStore the
//                    Sessions tab paginates over.
//   4. Actions     — verbs: new chat, new agent, toggle drawer, and the
//                    per-pane create actions from `../lib/createActions.ts`
//                    (StageHeader's registry, P5 item 2).
//
// There is no "switch personality" verb: a session belongs to the personality
// it started with. Choosing an agent is part of starting a session, so it
// lives in the New Session picker the "New chat session" action opens.
//
// Keyboard:
//   ⌘K / Ctrl-K  → open
//   Arrow ↑/↓    → move selection
//   Enter        → run
//   Esc          → close
//
// The palette renders a custom list (not Antd Select / AutoComplete)
// because the cmdk-style flat command list is too custom to bend the
// Antd primitives into without fighting them.

const RECENT_SESSION_COUNT = 8;

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onToggleDrawer: () => void;
  /** Opens the rail `+`'s fast-path dialog (`NewAgentDialog`, P5 item 1) —
   *  state lives in App.tsx, same lift as `onToggleDrawer`. */
  onOpenQuickCreateAgent: () => void;
}

interface CommandItem {
  id: string;
  group: 'Agents' | 'Pages' | 'Sessions' | 'Actions';
  /** Display label rendered as the row's primary line. */
  label: string;
  /** Subtle right-aligned hint (path, agent id, shortcut). */
  hint?: string;
  /** Lowercase tokens used for matching; merged with `label` automatically. */
  keywords?: string[];
  /** Disabled rows render but won't fire on Enter. */
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onToggleDrawer,
  onOpenQuickCreateAgent,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const { openNewSessionModal } = useNewSessionModal();
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Reset on every open so a previous query doesn't linger.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
    }
  }, [open]);

  // Recent sessions feed the dynamic items. We only fetch when the palette is
  // open so closed-state users don't pay the network cost every render.
  const sessionsQuery = useQuery({
    queryKey: ['palette', 'sessions'],
    queryFn: () => rpc.sessions.list({ limit: RECENT_SESSION_COUNT }),
    enabled: open,
  });
  const personalitiesQuery = usePersonalityList({ enabled: open });
  const { data: config } = useConfig();

  const agents = personalitiesQuery.data?.items ?? [];
  // The fallback chain `/` and `/chat` (and every P1a redirect) already use:
  // last-visited agent, else the operator's config default. Workspace pages
  // with no Library twin (Schedule, Memory, Documents, Goals, Tasks,
  // Identity, workspace Skills/MCP/Plugins) resolve through it too, so
  // they're reachable from the palette no matter which altitude it opened
  // from — same reasoning as `WorkspaceRedirect` in App.tsx.
  const fallbackPersonalityId = resolveFallbackPersonalityId(
    getLastPersonalityId(),
    config?.personality,
  );
  const fallbackPersonalityName =
    agents.find((p) => p.id === fallbackPersonalityId)?.name ?? capitalize(fallbackPersonalityId);

  const items = useMemo<CommandItem[]>(() => {
    const closeAfter = (fn: () => void) => () => {
      fn();
      onClose();
    };

    // The destination lists themselves are pure data from
    // `../lib/paletteDestinations.ts` (unit-tested there); this just wraps
    // each entry's `path` in a `navigate()` call and wires the group's
    // fixed verbs on top.
    const toCommandItem = (e: PaletteEntry): CommandItem => ({
      id: e.id,
      group: e.group,
      label: e.label,
      hint: e.hint,
      keywords: e.keywords,
      run: closeAfter(() => navigate(e.path)),
    });

    const agentItems = agentEntries(agents).map(toCommandItem);
    const pages = [
      ...libraryPageEntries(config?.adminEnabled ?? false),
      ...workspacePageEntries(fallbackPersonalityId, fallbackPersonalityName),
    ].map(toCommandItem);
    const registryActions = createActionEntries(fallbackPersonalityId, fallbackPersonalityName).map(
      toCommandItem,
    );

    const sessions: CommandItem[] = (sessionsQuery.data?.items ?? []).map((s) => ({
      id: `session:${s.id}`,
      group: 'Sessions' as const,
      label: s.title || titleize(s.key) || s.id,
      hint: relativeTime(s.updatedAt),
      keywords: [s.id, s.key, s.personalityId ?? '', s.platform],
      run: closeAfter(() => {
        setLastSessionId(s.id);
        navigate(`/chat?session=${encodeURIComponent(s.id)}`);
      }),
    }));

    const actions: CommandItem[] = [
      {
        id: 'action:new-chat',
        group: 'Actions',
        label: 'New chat session',
        hint: '⏎',
        keywords: ['fresh', 'reset'],
        run: closeAfter(() => openNewSessionModal()),
      },
      {
        id: 'action:new-agent',
        group: 'Actions',
        label: 'New agent',
        hint: 'quick create',
        keywords: ['personality', 'create', 'fast path'],
        run: closeAfter(() => onOpenQuickCreateAgent()),
      },
      {
        id: 'action:new-agent-architect',
        group: 'Actions',
        label: 'Create with architect',
        keywords: ['personality', 'new', 'agent', 'wizard', 'scaffold'],
        run: closeAfter(() => navigate('/personality/create')),
      },
      ...registryActions,
      {
        id: 'action:toggle-drawer',
        group: 'Actions',
        label: 'Toggle activity drawer',
        hint: '⌘.',
        keywords: ['stream', 'notifications', 'tools'],
        run: closeAfter(() => onToggleDrawer()),
      },
    ];

    return [...agentItems, ...pages, ...sessions, ...actions];
  }, [
    navigate,
    onClose,
    onToggleDrawer,
    onOpenQuickCreateAgent,
    openNewSessionModal,
    sessionsQuery.data,
    agents,
    config?.adminEnabled,
    fallbackPersonalityId,
    fallbackPersonalityName,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const haystack = [
        it.label.toLowerCase(),
        it.hint?.toLowerCase() ?? '',
        ...(it.keywords ?? []),
      ].join(' ');
      return q.split(/\s+/).every((token) => haystack.includes(token));
    });
  }, [items, query]);

  // Keep the selection within bounds when the filtered list shrinks.
  useEffect(() => {
    setSelectedIdx((idx) => Math.min(idx, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const groups = useMemo(() => groupBy(filtered, (i) => i.group), [filtered]);

  const flatRunnable = filtered.filter((i) => !i.disabled);
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((idx) => Math.min(idx + 1, flatRunnable.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((idx) => Math.max(idx - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = flatRunnable[selectedIdx];
      if (target) target.run();
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={560}
      destroyOnClose
      styles={{ body: { padding: 0 } }}
      // Anchor near the top so users land on the input without scrolling.
      style={{ top: 96 }}
      maskClosable
    >
      <Input
        autoFocus
        size="large"
        placeholder="Search pages, sessions, actions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        bordered={false}
        style={{ borderBottom: '1px solid var(--ethos-border)', borderRadius: 0, padding: 16 }}
      />
      <div className="palette-results" role="listbox" aria-label="Command palette results">
        {filtered.length === 0 ? (
          <div className="palette-empty">No matches.</div>
        ) : (
          Array.from(groups.entries()).map(([group, rows]) => (
            <div key={group} className="palette-group">
              <div className="palette-group-title">{group}</div>
              {rows.map((row) => {
                const flatIdx = flatRunnable.indexOf(row);
                const selected = flatIdx === selectedIdx;
                return (
                  <CommandRow
                    key={row.id}
                    item={row}
                    selected={selected}
                    onMouseEnter={() => {
                      if (flatIdx >= 0) setSelectedIdx(flatIdx);
                    }}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

function CommandRow({
  item,
  selected,
  onMouseEnter,
}: {
  item: CommandItem;
  selected: boolean;
  onMouseEnter: () => void;
}) {
  const className = [
    'palette-row',
    selected ? 'palette-row--selected' : '',
    item.disabled ? 'palette-row--disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (!item.disabled) item.run();
      }}
      onMouseEnter={onMouseEnter}
      disabled={item.disabled}
      role="option"
      aria-selected={selected}
    >
      <span className="palette-row-label">{item.label}</span>
      {item.hint ? <span className="palette-row-hint">{item.hint}</span> : null}
    </button>
  );
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function titleize(s: string): string {
  if (!s) return '';
  return s
    .replace(/[:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
