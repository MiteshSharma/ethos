import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_INDEX, type SettingEntry } from '../lib/settings-index';

// T6 — plan/phases/settings-navigation.md D8. `SETTINGS_INDEX` has exactly ONE
// failure mode: drift. A control that moves, appears or disappears without the
// table following makes the rail's counts lie and the search miss it, and
// nothing else in the suite would notice.
//
// So both directions are checked against the pane sources:
//
//   forward  — every `name=` site in `settings/panes/*.tsx` has an entry
//   backward — every entry that COULD have a form name has a site
//
// `stateBacked: true` entries are exempt from the backward direction by
// definition: rosters, tables, row editors and action buttons are not named
// `Form.Item`s and have no name to find. They are in the table because five
// real sections would otherwise render a count of 0 for controls you can see.
//
// Source-text technique, same as T1 — `apps/web` has no jsdom and this change
// deliberately does not add one.

const panesDir = join(import.meta.dirname, '..', 'panes');

interface NameSite {
  file: string;
  line: number;
  raw: string;
  /** Dotted path when every segment is a string literal. */
  literal: string | null;
  /** Regex when at least one segment is an expression: `[slot, 'model']`. */
  pattern: RegExp | null;
  /** Group id from a marker comment, when the whole name is an expression. */
  group: string | null;
}

const NAME_RE = /name=(?:"([^"]+)"|\{\[([^\]]+)\]\}|\{([A-Za-z0-9_.]+)\})/g;
const MARKER_RE = /settings-index-group:\s*([a-z0-9-]+)/;

/** How far above a `name={expr}` site its group marker may sit. */
const MARKER_LOOKBACK = 6;

/**
 * Blank out comments while keeping every newline, so line numbers survive and
 * prose that happens to quote a `name=` cannot mint a phantom control. The
 * markers are read from the RAW source, which is where they live.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '));
}

function collectSites(): NameSite[] {
  const sites: NameSite[] = [];
  for (const file of readdirSync(panesDir).filter((f) => f.endsWith('.tsx'))) {
    const raw = readFileSync(join(panesDir, file), 'utf8');
    const source = stripComments(raw);
    const lines = raw.split('\n');
    for (const match of source.matchAll(NAME_RE)) {
      const line = source.slice(0, match.index).split('\n').length;
      const [raw, quoted, bracketed] = match;
      if (quoted !== undefined) {
        sites.push({ file, line, raw, literal: quoted, pattern: null, group: null });
        continue;
      }
      if (bracketed !== undefined) {
        const segments = bracketed.split(',').map((s) => s.trim());
        if (segments.every((s) => /^'[^']*'$/.test(s))) {
          const literal = segments.map((s) => s.slice(1, -1)).join('.');
          sites.push({ file, line, raw, literal, pattern: null, group: null });
        } else {
          // One segment is an expression, so the site renders a FAMILY of
          // names. Wildcard that segment and require the family to exist.
          const source_ = segments
            .map((s) => (/^'[^']*'$/.test(s) ? s.slice(1, -1).replace(/\./g, '\\.') : '[^.]+'))
            .join('\\.');
          sites.push({
            file,
            line,
            raw,
            literal: null,
            pattern: new RegExp(`^${source_}$`),
            group: null,
          });
        }
        continue;
      }
      // `name={c.name}` — nothing about the shape is knowable from the source,
      // so the site must declare which index group it renders.
      const preamble = lines.slice(Math.max(0, line - 1 - MARKER_LOOKBACK), line - 1).join('\n');
      sites.push({
        file,
        line,
        raw,
        literal: null,
        pattern: null,
        group: MARKER_RE.exec(preamble)?.[1] ?? null,
      });
    }
  }
  return sites;
}

const SITES = collectSites();
const FORM_BACKED = SETTINGS_INDEX.filter((e) => !e.stateBacked);

function covers(site: NameSite, entry: SettingEntry): boolean {
  if (!entry.formName) return false;
  if (site.literal !== null) return entry.formName === site.literal;
  if (site.pattern) return site.pattern.test(entry.formName);
  return site.group !== null && entry.dynamicGroup === site.group;
}

describe('the index found the panes', () => {
  it('finds name sites at all, so a broken scan cannot pass vacuously', () => {
    expect(SITES.length).toBeGreaterThan(100);
    expect(new Set(SITES.map((s) => s.file)).size).toBeGreaterThan(5);
  });

  it.each(SITES.map((s) => [`${s.file}:${s.line} ${s.raw}`, s] as const))(
    '%s has an index entry',
    (_label, site) => {
      if (site.literal === null && site.pattern === null) {
        expect(
          site.group,
          `${site.file}:${site.line} renders an opaque name and declares no settings-index-group marker`,
        ).not.toBeNull();
      }
      expect(SETTINGS_INDEX.filter((e) => covers(site, e)).length).toBeGreaterThan(0);
    },
  );
});

describe('the panes render the index', () => {
  it.each(FORM_BACKED.map((e) => [`${e.category}/${e.section} ${e.label}`, e] as const))(
    '%s is rendered by a pane',
    (_label, entry) => {
      expect(
        entry.formName,
        `${entry.label} has no form name and is not marked stateBacked`,
      ).not.toBeNull();
      expect(
        SITES.filter((s) => covers(s, entry)).length,
        `${entry.formName} appears in no pane`,
      ).toBeGreaterThan(0);
    },
  );

  it('exempts only entries that really are state-backed', () => {
    // The exemption is the one hole in this test, so it is kept honest: a
    // state-backed entry must not ALSO claim a form name.
    for (const entry of SETTINGS_INDEX.filter((e) => e.stateBacked)) {
      expect(entry.formName, `${entry.label} is stateBacked and yet names a field`).toBeNull();
    }
  });

  it('keeps the state-backed exemption a minority of the table', () => {
    const stateBacked = SETTINGS_INDEX.length - FORM_BACKED.length;
    expect(stateBacked).toBeGreaterThan(0);
    expect(stateBacked).toBeLessThan(FORM_BACKED.length);
  });
});

describe('the index is internally coherent', () => {
  it('gives every entry with a null key a reason', () => {
    for (const entry of SETTINGS_INDEX) {
      if (entry.key === null) {
        expect(entry.keyUnresolved, `${entry.label} has no key and no reason`).toBeTruthy();
      } else {
        expect(entry.keyUnresolved, `${entry.label} has a key and a reason`).toBeUndefined();
      }
    }
  });

  it('never repeats a form name', () => {
    const names = FORM_BACKED.map((e) => e.formName);
    expect(names.length).toBe(new Set(names).size);
  });
});
