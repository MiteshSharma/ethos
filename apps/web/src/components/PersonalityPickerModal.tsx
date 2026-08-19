import { personalityAccent } from '@ethosagent/design-tokens';
import { Input, type InputRef, Modal } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePersonalityList } from '../features/personalities/api/queries';
import { useActivePersonality } from '../hooks/useActivePersonality';
import {
  buildNewSessionPath,
  filterPersonalities,
  moveSelection,
  type PickerPersonality,
  resolveInitialSelection,
} from '../lib/newSessionPicker';
import { PersonalityRingAvatar } from './ui/PersonalityRingAvatar';

interface PersonalityPickerModalProps {
  open: boolean;
  onClose: () => void;
}

const SEARCH_THRESHOLD = 6;

export function PersonalityPickerModal({ open, onClose }: PersonalityPickerModalProps) {
  const navigate = useNavigate();
  const { data } = usePersonalityList({ enabled: open });
  const { id: activeId } = useActivePersonality();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<InputRef>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<PickerPersonality[]>(
    () =>
      (data?.items ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        avatarUrl: p.display?.avatar_url,
      })),
    [data?.items],
  );
  const filtered = useMemo(() => filterPersonalities(items, query), [items, query]);
  const showSearch = items.length > SEARCH_THRESHOLD;

  // Reset query each open; recompute the highlighted tile from the active
  // personality whenever the modal opens or the filtered list changes.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSelectedId((prev) => {
      if (prev && filtered.some((p) => p.id === prev)) return prev;
      return resolveInitialSelection(filtered, activeId);
    });
  }, [open, filtered, activeId]);

  // Focus the search input when shown, else the list container so arrow
  // keys work immediately.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      if (showSearch) searchRef.current?.focus();
      else listRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open, showSearch]);

  const confirm = (id: string | null) => {
    if (!id) return;
    onClose();
    navigate(buildNewSessionPath(id));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedId((cur) => moveSelection(filtered, cur, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedId((cur) => moveSelection(filtered, cur, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      confirm(selectedId);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={480}
      destroyOnClose
      maskClosable
      styles={{ body: { padding: 0 } }}
      style={{ top: 96 }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard handler delegates arrow/enter nav to the inner focusable list and option buttons */}
      <div className="np-picker" onKeyDown={onKeyDown}>
        <div className="np-picker-header">
          <h3 className="np-picker-title">Start a new session</h3>
          <p className="np-picker-subtitle">Who do you want to talk to?</p>
        </div>
        {showSearch ? (
          <Input
            ref={searchRef}
            size="large"
            placeholder="Filter personalities…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            bordered={false}
            style={{ borderBottom: '1px solid var(--ethos-border)', borderRadius: 0, padding: 16 }}
          />
        ) : null}
        <div className="np-picker-list" ref={listRef} tabIndex={-1} role="listbox">
          {filtered.length === 0 ? (
            <div className="np-picker-empty">No personalities match.</div>
          ) : (
            filtered.map((p) => {
              const selected = p.id === selectedId;
              const accent = personalityAccent(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`np-picker-row${selected ? ' np-picker-row--selected' : ''}`}
                  style={
                    selected
                      ? { borderColor: accent, boxShadow: `inset 0 0 0 1px ${accent}` }
                      : undefined
                  }
                  onMouseEnter={() => setSelectedId(p.id)}
                  onClick={() => confirm(p.id)}
                >
                  <PersonalityRingAvatar
                    personalityId={p.id}
                    name={p.name}
                    size={32}
                    avatarUrl={p.avatarUrl}
                  />
                  <span className="np-picker-info">
                    <span className="np-picker-name">{p.name}</span>
                    {p.description ? <span className="np-picker-desc">{p.description}</span> : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
