import { describe, expect, it } from 'vitest';
import {
  buildNewSessionPath,
  filterPersonalities,
  HIDDEN_FROM_CHAT,
  moveSelection,
  type PickerPersonality,
  resolveInitialSelection,
} from '../newSessionPicker';

const items: PickerPersonality[] = [
  { id: 'researcher', name: 'Researcher', description: 'Digs into sources' },
  { id: 'coder', name: 'Coder', description: 'Writes TypeScript' },
  { id: 'writer', name: 'Writer', description: null },
  { id: 'personality-architect', name: 'Architect', description: 'meta agent' },
  { id: 'team-architect', name: 'Team Architect', description: 'meta agent' },
  { id: 'debug', name: 'Debug Assistant', description: 'meta agent' },
];

describe('filterPersonalities', () => {
  it('hides HIDDEN_FROM_CHAT ids', () => {
    const out = filterPersonalities(items, '');
    expect(out.map((p) => p.id)).toEqual(['researcher', 'coder', 'writer']);
    expect(out.some((p) => HIDDEN_FROM_CHAT.has(p.id))).toBe(false);
  });

  it('returns all visible items for an empty/whitespace query', () => {
    expect(filterPersonalities(items, '   ').map((p) => p.id)).toEqual([
      'researcher',
      'coder',
      'writer',
    ]);
  });

  it('matches name case-insensitively', () => {
    expect(filterPersonalities(items, 'CODER').map((p) => p.id)).toEqual(['coder']);
  });

  it('matches description case-insensitively', () => {
    expect(filterPersonalities(items, 'typescript').map((p) => p.id)).toEqual(['coder']);
  });

  it('returns empty when nothing matches', () => {
    expect(filterPersonalities(items, 'zzz')).toEqual([]);
  });
});

describe('resolveInitialSelection', () => {
  const filtered = filterPersonalities(items, '');

  it('returns the active id when present in the filtered list', () => {
    expect(resolveInitialSelection(filtered, 'coder')).toBe('coder');
  });

  it('falls back to the first item when active id is absent', () => {
    expect(resolveInitialSelection(filtered, 'personality-architect')).toBe('researcher');
    expect(resolveInitialSelection(filtered, null)).toBe('researcher');
  });

  it('returns null on an empty list', () => {
    expect(resolveInitialSelection([], 'coder')).toBeNull();
  });
});

describe('moveSelection', () => {
  const filtered = filterPersonalities(items, ''); // researcher, coder, writer

  it('moves down', () => {
    expect(moveSelection(filtered, 'researcher', 1)).toBe('coder');
  });

  it('moves up', () => {
    expect(moveSelection(filtered, 'coder', -1)).toBe('researcher');
  });

  it('clamps at the bottom (no wrap)', () => {
    expect(moveSelection(filtered, 'writer', 1)).toBe('writer');
  });

  it('clamps at the top (no wrap)', () => {
    expect(moveSelection(filtered, 'researcher', -1)).toBe('researcher');
  });
});

describe('buildNewSessionPath', () => {
  it('routes to the personality’s own workspace chat with new=1', () => {
    expect(buildNewSessionPath('coder')).toBe('/p/coder/chat?new=1');
  });

  it('url-encodes special characters in the id', () => {
    expect(buildNewSessionPath('team architect')).toBe('/p/team%20architect/chat?new=1');
  });
});
