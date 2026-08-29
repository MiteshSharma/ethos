// Dirty state, DERIVED rather than tracked (plan/phases/settings-navigation.md
// D9). `computeDirty` diffs the snapshot hydration pushed into the form against
// what the store and the row arrays hold now.
//
// It is category-BLIND by construction, and that is the whole design. Nothing
// here knows or asks which pane is mounted, so an edit made in Voice is still
// counted while you stand in Memory — the save bar reads `3 changes · Voice,
// Memory` and the rail dots the categories — without anyone having to remember
// to make it so. A tracker that hooked the mounted pane would have to be taught
// that fact, and would forget it the first time a pane was added.
//
// Pure, so it is tested like `chat-reducer`: no form instance, no DOM.

import type { SettingsRows } from './build-config-patch';
import type { FormShape } from './form-shape';
import { categoryForFormName } from './settings-index';

/** What hydration wrote. `null` before the first `config.get` lands. */
export interface DirtySnapshot {
  values: FormShape;
  rows: SettingsRows;
}

export interface DirtyState {
  /** Changed form fields, plus one per changed row set. */
  count: number;
  /** Category slugs holding at least one change, first-seen order. */
  categories: string[];
}

export const PRISTINE: DirtyState = { count: 0, categories: [] };

/**
 * Which category owns each row set. The row arrays are not `Form.Item`s, so
 * `categoryForFormName` cannot reach them and the mapping is stated once here.
 */
const ROW_SET_CATEGORY: Record<keyof SettingsRows, string> = {
  providerRows: 'models',
  quickCommandRows: 'automation',
  channelToolsetRows: 'automation',
  voiceTtsProviderRows: 'voice',
  voiceSttProviderRows: 'voice',
  voiceRealtimeProviderRows: 'voice',
  retentionRows: 'data',
  voiceBotRows: 'voice',
};

const ROW_SET_KEYS = Object.keys(ROW_SET_CATEGORY) as (keyof SettingsRows)[];

/**
 * Row fields that are UI state, not config: the React list key and the inline
 * provider test's result. Testing a provider must not read as an unsaved edit.
 */
const ROW_IGNORED_FIELDS = new Set(['_id', 'testStatus', 'testError']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten a form store into dotted paths. Nested blocks (`compaction.pressure`,
 * `voiceBargeIn.call.silenceMs`) become the same paths antd registers them
 * under, which is what lets the index resolve a changed path to a category.
 * Arrays are leaves — a tag list is one setting, not N.
 */
function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.set(prefix, value);
}

function sameLeaf(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function stripRow(row: unknown): unknown {
  if (!isPlainObject(row)) return row;
  return Object.fromEntries(Object.entries(row).filter(([k]) => !ROW_IGNORED_FIELDS.has(k)));
}

function sameRowSet(a: readonly unknown[], b: readonly unknown[]): boolean {
  return JSON.stringify(a.map(stripRow)) === JSON.stringify(b.map(stripRow));
}

export function computeDirty(
  saved: DirtySnapshot | null,
  values: FormShape,
  rows: SettingsRows,
): DirtyState {
  // Nothing has been hydrated yet, so nothing can have diverged from it.
  if (!saved) return PRISTINE;

  const before = new Map<string, unknown>();
  const after = new Map<string, unknown>();
  flatten(saved.values, '', before);
  flatten(values, '', after);

  let count = 0;
  const categories: string[] = [];
  const note = (category: string | null) => {
    if (category && !categories.includes(category)) categories.push(category);
  };

  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (sameLeaf(before.get(path), after.get(path))) continue;
    count += 1;
    note(categoryForFormName(path));
  }

  // A roster is counted as ONE change however many of its cells moved: the
  // patch it produces replaces the whole set, so "the provider chain changed"
  // is the honest unit and a per-cell number would promise a precision the
  // save does not have.
  for (const key of ROW_SET_KEYS) {
    if (sameRowSet(saved.rows[key], rows[key])) continue;
    count += 1;
    note(ROW_SET_CATEGORY[key]);
  }

  return { count, categories };
}
