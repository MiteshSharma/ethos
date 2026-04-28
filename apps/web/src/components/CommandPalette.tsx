import { useQuery } from '@tanstack/react-query';
import { Input, Modal } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clearLastSessionId, setLastSessionId } from '../lib/lastSession';
import { rpc } from '../rpc';

// ⌘K command palette — global keyboard nav surface that indexes every
// reachable destination + the user's recent state.
//
// Three groups:
//   1. Pages       — every active sidebar route + the disabled v1 hints
//                    (so users can see where future tabs will live).
//   2. Sessions    — most recent N from the same SessionStore the
//                    Sessions tab paginates over.
//   3. Actions     — verbs: new chat, toggle drawer, switch personality.
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
}

interface CommandItem {
  id: string;
  group: 'Pages' | 'Sessions' | 'Actions';
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

export function CommandPalette({ open, onClose, onToggleDrawer }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Reset on every open so a previous query doesn't linger.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
    }
  }, [open]);

  // Sessions + personalities feed the dynamic items. We only fetch when
  // the palette is open so closed-state users don't pay the network cost
  // every render.
  const sessionsQuery = useQuery({
    queryKey: ['palette', 'sessions'],
    queryFn: () => rpc.sessions.list({ limit: RECENT_SESSION_COUNT }),
    enabled: open,
  });
  const personalitiesQuery = useQuery({
    queryKey: ['palette', 'personalities'],
    queryFn: () => rpc.personalities.list(),
    enabled: open,
  });

  const items = useMemo<CommandItem[]>(() => {
    const closeAfter = (fn: () => void) => () => {
      fn();
      onClose();
    };

    const pages: CommandItem[] = [
      page('Chat', '/chat', ['talk', 'message', 'agent']),
      page('Sessions', '/sessions', ['history', 'past', 'fts']),
      page('Cron', '/cron', ['schedule', 'job']),
      page('Skills', '/skills', ['library', 'evolver']),
      page('Mesh', '/mesh', ['swarm', 'agents', 'route']),
      page('Settings', '/settings', ['config', 'provider', 'model', 'key']),
      page('Memory', '/memory', ['notes', 'context', 'user', 'remember']),
      page('Plugins', '/plugins', ['mcp', 'install', 'tools']),
      page('Communications', '/communications', ['telegram', 'slack', 'discord', 'email', 'comms']),
      pageDisabled('Personalities', '/personalities', 'v1'),
    ].map((p) => ({ ...p, run: closeAfter(p.run) }));

    const sessions: CommandItem[] = (sessionsQuery.data?.sessions ?? []).map((s) => ({
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
        run: closeAfter(() => {
          clearLastSessionId();
          navigate('/chat');
        }),
      },
      {
        id: 'action:toggle-drawer',
        group: 'Actions',
        label: 'Toggle activity drawer',
        hint: '⌘.',
        keywords: ['stream', 'notifications', 'tools'],
        run: closeAfter(() => onToggleDrawer()),
      },
      ...(personalitiesQuery.data?.personalities ?? []).map<CommandItem>((p) => ({
        id: `action:personality:${p.id}`,
        group: 'Actions',
        label: `Switch personality → ${p.name}`,
        hint: p.id,
        keywords: ['personality', 'switch', p.id, ...(p.capabilities ?? [])],
        run: closeAfter(() => {
          // Switching mid-conversation forks the session, so we can't fire
          // that flow from here without owning the chat hook. Cleanest
          // path: navigate to /chat with a query param the page picks up
          // and triggers its own switcher logic. We deep-link with
          // `?personality=<id>` and let Chat consume + clear it.
          navigate(`/chat?personality=${encodeURIComponent(p.id)}`);
        }),
      })),
    ];

    return [...pages, ...sessions, ...actions];

    function page(label: string, path: string, keywords: string[] = []): CommandItem {
      return {
        id: `page:${path}`,
        group: 'Pages',
        label,
        hint: path,
        keywords,
        run: () => navigate(path),
      };
    }
    function pageDisabled(label: string, path: string, hint: string): CommandItem {
      return {
        id: `page:${path}`,
        group: 'Pages',
        label,
        hint,
        keywords: [],
        disabled: true,
        run: () => {},
      };
    }
  }, [navigate, onClose, onToggleDrawer, sessionsQuery.data, personalitiesQuery.data]);

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
