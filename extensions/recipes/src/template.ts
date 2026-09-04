// The `{{input.<key>}}` templater (plan/phases/recipes-gallery.md §2, D7).
//
// One templating form, resolved by the installer BEFORE anything is written.
// No conditionals, no expressions, no model involvement. An unresolved
// placeholder throws: rendering it literally into a SOUL.md, or silently
// substituting an empty string, both ship a broken personality.

import {
  defaultRecipeSafety,
  INPUT_PLACEHOLDER_PATTERN,
  type RecipeAttachPersonality,
  type RecipeBundle,
  type RecipeCreatePersonality,
  type RecipeInput,
} from './schema';

export class RecipeTemplateError extends Error {
  /** Which bundle field failed, e.g. `cronJobs[0].prompt`. */
  readonly field: string;
  /** The input keys that could not be resolved. */
  readonly keys: string[];

  constructor(field: string, keys: string[]) {
    super(`Unresolved placeholder(s) in ${field}: ${keys.map((k) => `{{input.${k}}}`).join(', ')}`);
    this.name = 'RecipeTemplateError';
    this.field = field;
    this.keys = keys;
  }
}

/** Input keys referenced by a single string, in first-seen order. */
export function placeholderKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(INPUT_PLACEHOLDER_PATTERN)) {
    const key = match[1];
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** A value counts as supplied only when it is present and not blank. */
function isFilled(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/** Referenced keys with no usable value. Empty ⇒ `renderTemplate` will succeed. */
export function unresolvedPlaceholders(text: string, values: Record<string, string>): string[] {
  return placeholderKeys(text).filter((k) => !isFilled(values[k]));
}

/** Substitute `{{input.*}}`. Throws `RecipeTemplateError` on any unresolved key. */
export function renderTemplate(
  text: string,
  values: Record<string, string>,
  field: string,
): string {
  const missing = unresolvedPlaceholders(text, values);
  if (missing.length > 0) throw new RecipeTemplateError(field, missing);
  return text.replace(INPUT_PLACEHOLDER_PATTERN, (_match, key: string) => values[key] ?? '');
}

/**
 * Best-effort render for PREVIEW surfaces only: an unresolvable placeholder is
 * left standing so the user sees what is still missing. Never use before a write.
 */
export function renderTemplatePreview(text: string, values: Record<string, string>): string {
  return text.replace(INPUT_PLACEHOLDER_PATTERN, (match, key: string) => {
    const value = values[key];
    return isFilled(value) ? value : match;
  });
}

export interface ResolvedInputs {
  /** Declared defaults merged under the caller's values. */
  values: Record<string, string>;
  /** Required inputs still blank after defaults. */
  missing: RecipeInput[];
}

/** Merge declared defaults under the supplied values and report what is still needed. */
export function resolveInputs(
  bundle: RecipeBundle,
  provided: Record<string, string> = {},
): ResolvedInputs {
  const values: Record<string, string> = {};
  const missing: RecipeInput[] = [];
  for (const input of bundle.requires.inputs) {
    const supplied = provided[input.key];
    const value = isFilled(supplied) ? supplied : input.default;
    if (isFilled(value)) values[input.key] = value;
    else if (input.required) missing.push(input);
  }
  return { values, missing };
}

/** A bundle with every `{{input.*}}` substituted — what the installer writes. */
export interface ResolvedRecipe {
  personality: RecipeBundle['personality'];
  cronJobs: RecipeBundle['cronJobs'];
}

/** The `read` / `write` halves of a reach block, each entry substituted. */
function renderReachLists(
  fsReach: { read?: string[]; write?: string[] },
  values: Record<string, string>,
): { read?: string[]; write?: string[] } {
  return {
    ...(fsReach.read
      ? {
          read: fsReach.read.map((p, i) =>
            renderTemplate(p, values, `personality.fsReach.read[${i}]`),
          ),
        }
      : {}),
    ...(fsReach.write
      ? {
          write: fsReach.write.map((p, i) =>
            renderTemplate(p, values, `personality.fsReach.write[${i}]`),
          ),
        }
      : {}),
  };
}

type AttachFields = Omit<RecipeAttachPersonality, 'mode'>;
type CreateFields = Omit<RecipeCreatePersonality, 'mode'>;

function renderAttachFields<T extends AttachFields>(p: T, values: Record<string, string>): T {
  const fsReach = p.fsReach;
  return {
    ...p,
    soulSection: renderTemplate(p.soulSection, values, 'personality.soulSection'),
    ...(fsReach ? { fsReach: renderReachLists(fsReach, values) } : {}),
  };
}

function renderCreateFields<T extends CreateFields>(p: T, values: Record<string, string>): T {
  const fsReach = p.fsReach;
  const workdir = fsReach?.workdir;
  return {
    ...p,
    // D15 — a bundle that declares no network policy installs with
    // `allow: ['*']` rather than with nothing. Nothing is not neutral: it
    // resolves every `allowedHosts: ['*']` tool to an empty host set and
    // denies every fetch. A bundle that declares its own wins.
    safety: p.safety ?? defaultRecipeSafety(),
    soulMd: renderTemplate(p.soulMd, values, 'personality.soulMd'),
    ...(fsReach
      ? {
          fsReach: {
            ...renderReachLists(fsReach, values),
            ...(workdir === undefined
              ? {}
              : {
                  workdir:
                    typeof workdir === 'string'
                      ? renderTemplate(workdir, values, 'personality.fsReach.workdir')
                      : workdir.map((p, i) =>
                          renderTemplate(p, values, `personality.fsReach.workdir[${i}]`),
                        ),
                }),
          },
        }
      : {}),
  };
}

function renderPersonality(
  personality: RecipeBundle['personality'],
  values: Record<string, string>,
): RecipeBundle['personality'] {
  if (personality.mode === 'attach') return renderAttachFields(personality, values);
  if (personality.mode === 'both') {
    return {
      ...renderCreateFields(personality, values),
      attach: renderAttachFields(personality.attach, values),
    };
  }
  return renderCreateFields(personality, values);
}

/**
 * Resolve every templated field. Throws `RecipeTemplateError` on the first
 * unresolved placeholder, so a half-substituted bundle never reaches a write.
 */
export function renderRecipe(bundle: RecipeBundle, values: Record<string, string>): ResolvedRecipe {
  return {
    personality: renderPersonality(bundle.personality, values),
    cronJobs: bundle.cronJobs.map((job, i) => ({
      ...job,
      schedule: renderTemplate(job.schedule, values, `cronJobs[${i}].schedule`),
      prompt: renderTemplate(job.prompt, values, `cronJobs[${i}].prompt`),
    })),
  };
}

// ---------------------------------------------------------------------------
// Attach mode — the marked SOUL section
// ---------------------------------------------------------------------------

/**
 * The marker lines an attach install wraps its SOUL section in. HTML comments:
 * nothing in the prompt-assembly path strips them, the model ignores them, and
 * they make the section findable — for "already attached" in preflight, and
 * for a human editing the file later.
 */
export function recipeSoulMarkers(bundleId: string): { start: string; end: string } {
  return { start: `<!-- recipe:${bundleId}:start -->`, end: `<!-- recipe:${bundleId}:end -->` };
}

/** Whether a SOUL.md already carries this recipe's section. */
export function hasRecipeSoulSection(soulMd: string, bundleId: string): boolean {
  return soulMd.includes(recipeSoulMarkers(bundleId).start);
}

/** The target's SOUL.md with the rendered section appended between the markers. */
export function appendRecipeSoulSection(soulMd: string, bundleId: string, section: string): string {
  const { start, end } = recipeSoulMarkers(bundleId);
  const base = soulMd.length === 0 || soulMd.endsWith('\n') ? soulMd : `${soulMd}\n`;
  return `${base}\n${start}\n${section.trim()}\n${end}\n`;
}
