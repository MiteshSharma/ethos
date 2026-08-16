import { describe, expect, it } from 'vitest';
import {
  type PersonalityAttachment,
  splitByAttachment,
  usedByPersonalityIds,
} from '../attachmentLists';

const idOf = (item: { id: string }) => item.id;

// P3 — plan/phases/personality-first-ui.md, "dual-altitude twins". Proves the
// two shared shapes: the workspace attached/not-attached split, and the
// Library "Used by" join.

describe('splitByAttachment', () => {
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('splits into attached and not-attached by id membership', () => {
    const { attached, notAttached } = splitByAttachment(all, new Set(['a', 'c']), idOf);
    expect(attached.map((x) => x.id)).toEqual(['a', 'c']);
    expect(notAttached.map((x) => x.id)).toEqual(['b']);
  });

  it('preserves the input order within each list', () => {
    const { attached } = splitByAttachment(all, new Set(['c', 'a']), idOf);
    expect(attached.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('everything lands in notAttached when the attached set is empty', () => {
    const { attached, notAttached } = splitByAttachment(all, new Set(), idOf);
    expect(attached).toEqual([]);
    expect(notAttached.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('everything lands in attached when every id is in the set', () => {
    const { attached, notAttached } = splitByAttachment(all, new Set(['a', 'b', 'c']), idOf);
    expect(attached.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(notAttached).toEqual([]);
  });

  it('accepts a non-"id" key — e.g. an MCP server keyed by name', () => {
    const servers = [{ name: 'stripe' }, { name: 'github' }];
    const { attached, notAttached } = splitByAttachment(
      servers,
      new Set(['github']),
      (s) => s.name,
    );
    expect(attached.map((s) => s.name)).toEqual(['github']);
    expect(notAttached.map((s) => s.name)).toEqual(['stripe']);
  });
});

describe('usedByPersonalityIds', () => {
  const attachments: PersonalityAttachment[] = [
    { personalityId: 'engineer', itemIds: ['skill-a', 'skill-b'] },
    { personalityId: 'researcher', itemIds: ['skill-b'] },
    { personalityId: 'writer', itemIds: [] },
  ];

  it('returns every personality with the item attached', () => {
    expect(usedByPersonalityIds('skill-b', attachments)).toEqual(['engineer', 'researcher']);
  });

  it('returns a single-element list when only one personality has it', () => {
    expect(usedByPersonalityIds('skill-a', attachments)).toEqual(['engineer']);
  });

  it('returns an empty list when nobody has it attached', () => {
    expect(usedByPersonalityIds('skill-z', attachments)).toEqual([]);
  });
});
