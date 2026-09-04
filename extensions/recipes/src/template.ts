// The `{{input.<key>}}` templater (plan/phases/recipes-gallery.md §2, D7).
//
// One templating form, resolved by the installer BEFORE anything is written.
// No conditionals, no expressions, no model involvement. An unresolved
// placeholder throws: rendering it literally into a SOUL.md, or silently
// substituting an empty string, both ship a broken personality.

import {
  defaultRecipeSafety,
  INPUT_PLACEHOLDER_PATTERN,
  type RecipeBundle,
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

/**
 * Resolve every templated field. Throws `RecipeTemplateError` on the first
 * unresolved placeholder, so a half-substituted bundle never reaches a write.
 */
export function renderRecipe(bundle: RecipeBundle, values: Record<string, string>): ResolvedRecipe {
  const { personality } = bundle;
  const fsReach = personality.fsReach;
  const workdir = fsReach?.workdir;
  return {
    personality: {
      ...personality,
      // D15 — a bundle that declares no network policy installs with
      // `allow: ['*']` rather than with nothing. Nothing is not neutral: it
      // resolves every `allowedHosts: ['*']` tool to an empty host set and
      // denies every fetch. A bundle that declares its own wins.
      safety: personality.safety ?? defaultRecipeSafety(),
      soulMd: renderTemplate(personality.soulMd, values, 'personality.soulMd'),
      ...(fsReach
        ? {
            fsReach: {
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
    },
    cronJobs: bundle.cronJobs.map((job, i) => ({
      ...job,
      schedule: renderTemplate(job.schedule, values, `cronJobs[${i}].schedule`),
      prompt: renderTemplate(job.prompt, values, `cronJobs[${i}].prompt`),
    })),
  };
}
