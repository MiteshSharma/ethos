// The recipe bundle schema (plan/phases/recipes-gallery.md §2).
//
// A recipe is declarative DATA, not code (D2): a validated bundle that the
// installer applies. Everything here is pure — this package depends on
// `@ethosagent/types` and nothing else, so the schema, the templater and
// preflight are all provable without a filesystem, a registry or an app.
//
// `RecipeBundle` is derived from the Zod schema rather than declared beside it:
// one source, no drift between "what parses" and "what typechecks".

import type { ModelTierConfig } from '@ethosagent/types';
import { z } from 'zod';

/** `{{input.<key>}}` — the ONLY templating form a bundle may use (D7). */
export const INPUT_PLACEHOLDER_PATTERN = /\{\{input\.([A-Za-z0-9_-]+)\}\}/g;

/** Mirrors `ModelTierConfig` from `@ethosagent/types`; the annotation is the tie. */
const ModelTierSchema: z.ZodType<ModelTierConfig> = z.object({
  trivial: z.string().optional(),
  default: z.string().optional(),
  deep: z.string().optional(),
  dreaming: z.string().optional(),
});

const KebabId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case (lowercase, hyphen-separated)');

/**
 * Per-personality network reach. Mirrors `PersonalityConfig['safety']['network']`
 * (`packages/types/src/personality.ts`) — this is not a new capability, just the
 * one a recipe has to be able to state.
 */
const RecipeNetworkPolicySchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  allow_private_urls: z.boolean().optional(),
});

/**
 * What a bundle installs with when it declares no `safety.network` of its own
 * (D15, user-directed).
 *
 * Absent is NOT "no policy". `web_extract` declares
 * `capabilities.network.allowedHosts: ['*']`, which hands the decision to the
 * PERSONALITY's policy, and an absent one resolves to an EMPTY host set
 * (`packages/core/src/capability-resolver.ts`) — so every fetch is denied with
 * `HOST_NOT_ALLOWED`. A recipe-installed agent therefore gets the open public
 * internet by default; the non-overridable floor (cloud-metadata + private
 * ranges blocked, `allow_private_urls` false, http/https only) still holds.
 *
 * A function, not a shared const, so no two personalities alias one array.
 */
export function defaultRecipeSafety(): { network: { allow: string[] } } {
  return { network: { allow: ['*'] } };
}

/**
 * The create-side fields — exactly what `PersonalityCreateInput` accepts
 * (§0.6), camel-cased. A SUBSET is fine; a superset is not — a bundle that
 * needs a field the personality contract does not have is a wrong bundle, not
 * a schema gap. Maps to `PersonalityCreateInput` as: mcpServers →
 * `mcp_servers`, fsReach → `fs_reach`; every other key is already identical.
 */
const RecipeCreateFields = z.object({
  id: KebabId,
  name: z.string().min(1),
  description: z.string().min(1),
  /** May contain `{{input.*}}`. */
  soulMd: z.string().min(1),
  model: z.union([z.string(), ModelTierSchema]).optional(),
  provider: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  toolset: z.array(z.string()),
  /** Must equal `requires.mcpServers[].name` as a set. */
  mcpServers: z.array(z.string()).optional(),
  /** Must equal `requires.plugins[].id` as a set. */
  plugins: z.array(z.string()).optional(),
  fsReach: z
    .object({
      read: z.array(z.string()).optional(),
      write: z.array(z.string()).optional(),
      workdir: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .optional(),
  /**
   * Declared network reach. ABSENT means the installer applies
   * `defaultRecipeSafety()` — a bundle that declares its own WINS, so a
   * locked-down recipe can narrow it to the hosts it actually reads.
   */
  safety: z.object({ network: RecipeNetworkPolicySchema }).optional(),
});

/**
 * The attach-side fields — what a recipe adds ONTO an existing personality.
 * The target is chosen at install time (`personalityId`), so nothing here
 * names, models or network-scopes an agent: identity, routing and `safety`
 * belong to the personality that already exists, and an attach never changes
 * them. `.strict()` makes that a schema error rather than a silently stripped
 * field.
 *
 * What it does carry is ADDITIVE: a marked SOUL section, tools to union into
 * the toolset, reach entries to append, and the MCP/plugin allowlists the
 * recipe's requirements demand.
 */
const RecipeAttachFields = z
  .object({
    /**
     * Markdown appended to the target's SOUL.md, wrapped by the installer in
     * `<!-- recipe:<bundle.id>:start -->` / `:end -->` marker lines so a second
     * install can detect it and an undo can find it. May contain `{{input.*}}`.
     */
    soulSection: z.string().min(1),
    /** Tools ADDED to the target's toolset (union). Same rule as `requires.tools`. */
    toolset: z.array(z.string()),
    /** Must equal `requires.mcpServers[].name` as a set. */
    mcpServers: z.array(z.string()).optional(),
    /** Must equal `requires.plugins[].id` as a set. */
    plugins: z.array(z.string()).optional(),
    /** Appended (deduped) to the target's `fs_reach`. No `workdir`: that is the target's. */
    fsReach: z
      .object({
        read: z.array(z.string()).optional(),
        write: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** `mode: 'create'` — the recipe writes a new personality. */
const RecipeCreatePersonalitySchema = RecipeCreateFields.extend({ mode: z.literal('create') });

/** `mode: 'attach'` — the recipe installs onto a personality chosen at install time. */
const RecipeAttachPersonalitySchema = RecipeAttachFields.extend({
  mode: z.literal('attach'),
}).strict();

/**
 * `mode: 'both'` — the recipe is offered either way, and the user picks at
 * install time (`installMode`, default `create`). The create side is the top
 * level; the attach side is the `attach` sub-object. `projectPersonality`
 * turns it into one of the two views above, so nothing downstream grows a
 * third code path.
 */
const RecipeBothPersonalitySchema = RecipeCreateFields.extend({
  mode: z.literal('both'),
  attach: RecipeAttachFields,
});

const RecipePersonalitySchema = z.discriminatedUnion('mode', [
  RecipeCreatePersonalitySchema,
  RecipeAttachPersonalitySchema,
  RecipeBothPersonalitySchema,
]);

const RecipeMcpServerSchema = z.object({
  name: z.string().min(1),
  /** Matches an `mcp.catalog` preset id when one exists. */
  catalogId: z.string().optional(),
  transport: z.enum(['stdio', 'streamable-http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  envKeys: z.array(z.string()).optional(),
  auth: z.enum(['none', 'env', 'oauth']),
  /** One line, shown in preflight. */
  why: z.string().min(1),
  /**
   * Absent or false ⇒ the recipe does not work without this server, so an
   * unregistered one blocks the install. True ⇒ the recipe runs without it and
   * preflight warns instead of blocking (D13). The server stays listed in
   * `personality.mcpServers` either way: an allowlist entry naming a server
   * that is not registered is inert.
   */
  optional: z.boolean().optional(),
});

const RecipePluginSchema = z.object({
  id: z.string().min(1),
  packageName: z.string().min(1),
  why: z.string().min(1),
});

const RecipeChannelSchema = z.object({
  platform: z.string().min(1),
  why: z.string().min(1),
  deliversCron: z.boolean(),
  /**
   * Collect this platform's bot credential ON THE RECIPE PAGE, and let the
   * install create the bot and bind it to the personality it just created.
   *
   * Without this the requirement is unsatisfiable, and it is worth spelling out
   * why: a bot binds to a PERSONALITY, and the personality does not exist until
   * the recipe installs. "Bind a bot to this agent in Communications, then
   * re-check" therefore asks the user to do something that cannot be done yet —
   * a permanent blocker on the one row the recipe most needs cleared. Inline
   * setup inverts the order: the token is an INPUT the user can answer here,
   * and the installer does the binding once the personality exists.
   *
   * Only `telegram` is implemented (see the refinement below); a bundle that
   * claims it for another platform fails its own schema rather than rendering a
   * setup panel with nothing behind it.
   */
  inlineSetup: z.boolean().optional(),
});

/**
 * A credential the recipe's tools need before they can do anything.
 *
 * Preflight's `TOOL_UNAVAILABLE` check can never catch this: `web_search`
 * returns `isAvailable(): true` unconditionally and deliberately — the key may
 * live in Named Secrets, which is unreachable at filter time — so the tool
 * looks available, installs fine, and fails at execute time with "no key
 * configured". This declares the prerequisite so it is answered BEFORE install.
 *
 * The alternatives are deliberately NOT listed here. `web_search` already
 * publishes its provider roster in its own `settingsSchema`, and a second copy
 * in the recipe layer goes stale the day a provider is added or removed. The
 * service resolves the roster from the tool and the key store; a bundle names
 * only the tool.
 *
 * The VALUE never travels through this package. A key is written through
 * `keys.set`, the store that already owns credentials — the same posture as the
 * Telegram bot token (D14), which is likewise never a `requires.inputs` entry.
 */
const RecipeSecretSchema = z.object({
  /** The tool whose `settingsSchema` + key-store entries satisfy this. */
  toolName: z.string().min(1),
  /** The preflight row's label — 'Web search API key'. */
  label: z.string().min(1),
  /** One line: what the key is for, and what the recipe loses without it. */
  why: z.string().min(1),
});

const RecipeHostBinarySchema = z.object({
  name: z.string().min(1),
  why: z.string().min(1),
  installHint: z.string().min(1),
});

export const RECIPE_INPUT_KINDS = [
  'text',
  'secret',
  'path',
  'choice',
  'cron',
  'chatTarget',
] as const;

const RecipeInputSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]+$/, 'must match {{input.<key>}}'),
  label: z.string().min(1),
  kind: z.enum(RECIPE_INPUT_KINDS),
  required: z.boolean(),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  options: z.array(z.string()).optional(),
  help: z.string().min(1),
});

const RecipeCronJobSchema = z.object({
  name: z.string().min(1),
  /** May contain `{{input.*}}`. */
  schedule: z.string().min(1),
  /** May contain `{{input.*}}`. */
  prompt: z.string().min(1),
  missedRunPolicy: z.enum(['run-once', 'skip']).optional(),
  /** Which §1 `deliverTo` arm this job wants. */
  deliverTo: z.enum(['channel', 'inApp', 'none']),
});

const RecipePostInstallSchema = z.object({
  kind: z.enum(['oauth', 'token', 'restart', 'manual']),
  label: z.string().min(1),
  detail: z.string().min(1),
  /** In-app route that fixes it, when one exists. */
  href: z.string().optional(),
});

const RecipeBundleShape = z.object({
  /** Stable kebab id. Never reused for different content. */
  id: KebabId,
  /** Bumped whenever any field below changes — optimistic concurrency on the preview (§4). */
  version: z.number().int().positive(),
  title: z.string().min(1),
  /** One line, gallery row. */
  summary: z.string().min(1),
  /** Provenance for humans. Not read at runtime. */
  sourceDoc: z.string().optional(),
  tags: z.array(z.string()),
  personality: RecipePersonalitySchema,
  requires: z.object({
    mcpServers: z.array(RecipeMcpServerSchema),
    plugins: z.array(RecipePluginSchema),
    channels: z.array(RecipeChannelSchema),
    /** Registered tool names that must exist AND pass `isAvailable()`. */
    tools: z.array(z.string()),
    /** Credentials the granted tools need. Checked against the key store. */
    secrets: z.array(RecipeSecretSchema).optional(),
    hostBinaries: z.array(RecipeHostBinarySchema).optional(),
    inputs: z.array(RecipeInputSchema),
  }),
  cronJobs: z.array(RecipeCronJobSchema),
  /** Pre-filled into the composer after install. Never auto-sent. */
  starterPrompt: z.string().min(1),
  examplePrompts: z.array(z.string()),
  /** From the usecase doc's "Limitations / notes". Shown before install. */
  notes: z.array(z.string()),
  /** What the installer cannot do. Rendered as the post-install checklist. */
  postInstall: z.array(RecipePostInstallSchema),
});

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/** Every `{{input.<key>}}` in a bundle, across every templated field. */
function referencedInputKeys(bundle: z.infer<typeof RecipeBundleShape>): string[] {
  const p = bundle.personality;
  const fsReach = p.fsReach;
  const workdir = p.mode === 'attach' ? undefined : p.fsReach?.workdir;
  // A `both` bundle carries two templated halves; both are scanned.
  const attach = p.mode === 'both' ? p.attach : undefined;
  const texts = [
    p.mode === 'attach' ? p.soulSection : p.soulMd,
    ...(fsReach?.read ?? []),
    ...(fsReach?.write ?? []),
    ...(workdir === undefined ? [] : typeof workdir === 'string' ? [workdir] : workdir),
    ...(attach
      ? [attach.soulSection, ...(attach.fsReach?.read ?? []), ...(attach.fsReach?.write ?? [])]
      : []),
    ...bundle.cronJobs.flatMap((j) => [j.schedule, j.prompt]),
  ];
  const keys = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(INPUT_PLACEHOLDER_PATTERN)) {
      const key = match[1];
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

/**
 * The bundle schema. The refinements below are authoring invariants — every one
 * of them describes a bundle that would install into something incoherent, so
 * they fail at `pnpm test` (the table test) rather than at install time.
 */
export const RecipeBundleSchema = RecipeBundleShape.superRefine((bundle, ctx) => {
  // Every half that carries allowlists is held to the same set-equality: the
  // top level always, and the `attach` sub-object of a `both` bundle too.
  const halves: Array<[path: string[], half: { mcpServers?: string[]; plugins?: string[] }]> = [
    [['personality'], bundle.personality],
  ];
  if (bundle.personality.mode === 'both') {
    halves.push([['personality', 'attach'], bundle.personality.attach]);
  }
  const requiredMcp = bundle.requires.mcpServers.map((s) => s.name);
  const requiredPlugins = bundle.requires.plugins.map((p) => p.id);
  for (const [path, half] of halves) {
    const declaredMcp = half.mcpServers ?? [];
    if (!sameSet(declaredMcp, requiredMcp)) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, 'mcpServers'],
        message: `${path.join('.')}.mcpServers [${declaredMcp.join(', ')}] must equal requires.mcpServers[].name [${requiredMcp.join(', ')}]`,
      });
    }
    const declaredPlugins = half.plugins ?? [];
    if (!sameSet(declaredPlugins, requiredPlugins)) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, 'plugins'],
        message: `${path.join('.')}.plugins [${declaredPlugins.join(', ')}] must equal requires.plugins[].id [${requiredPlugins.join(', ')}]`,
      });
    }
  }

  const inputKeys = bundle.requires.inputs.map((i) => i.key);
  const duplicates = inputKeys.filter((k, i) => inputKeys.indexOf(k) !== i);
  if (duplicates.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['requires', 'inputs'],
      message: `duplicate input key(s): ${[...new Set(duplicates)].join(', ')}`,
    });
  }

  // A placeholder naming an input that does not exist can never resolve, and
  // an unresolved placeholder is a hard error at apply time (D7). Catch it here.
  const unknown = referencedInputKeys(bundle).filter((k) => !inputKeys.includes(k));
  if (unknown.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['requires', 'inputs'],
      message: `{{input.*}} references undeclared input(s): ${unknown.join(', ')}`,
    });
  }

  // §2: `deliverTo: 'channel'` makes the chatTarget input required.
  const wantsChannel = bundle.cronJobs.some((j) => j.deliverTo === 'channel');
  const hasChatTarget = bundle.requires.inputs.some(
    (i) => i.kind === 'chatTarget' && i.required === true,
  );
  if (wantsChannel && !hasChatTarget) {
    ctx.addIssue({
      code: 'custom',
      path: ['requires', 'inputs'],
      message: "a cron job with deliverTo: 'channel' needs a required input of kind 'chatTarget'",
    });
  }

  // A credential requirement for a tool the recipe does not grant is a
  // requirement nothing in the recipe can consume — an authoring slip, and one
  // that would put an unclearable row in front of the user.
  for (const [i, secret] of (bundle.requires.secrets ?? []).entries()) {
    if (bundle.requires.tools.includes(secret.toolName)) continue;
    ctx.addIssue({
      code: 'custom',
      path: ['requires', 'secrets', i, 'toolName'],
      message: `requires.secrets names '${secret.toolName}', which is not in requires.tools`,
    });
  }

  // Inline setup is a real code path per platform (a token probe, a
  // `getUpdates` discovery, a bot-add call), not a flag a bundle can turn on
  // for a platform nobody wired. Today that is Telegram.
  for (const [i, channel] of bundle.requires.channels.entries()) {
    if (channel.inlineSetup && channel.platform !== 'telegram') {
      ctx.addIssue({
        code: 'custom',
        path: ['requires', 'channels', i, 'inlineSetup'],
        message: `inlineSetup is implemented for telegram only, not '${channel.platform}'`,
      });
    }
  }
});

export type RecipeBundle = z.infer<typeof RecipeBundleSchema>;
export type RecipeInput = RecipeBundle['requires']['inputs'][number];
export type RecipeCronJob = RecipeBundle['cronJobs'][number];
export type RecipePersonality = RecipeBundle['personality'];
export type RecipeCreatePersonality = z.infer<typeof RecipeCreatePersonalitySchema>;
export type RecipeAttachPersonality = z.infer<typeof RecipeAttachPersonalitySchema>;
export type RecipeBothPersonality = z.infer<typeof RecipeBothPersonalitySchema>;
/** A bundle whose `personality` is statically the create variant — how the create-mode data files are typed. */
export type RecipeCreateBundle = Omit<RecipeBundle, 'personality'> & {
  personality: RecipeCreatePersonality;
};
/** The attach counterpart. */
export type RecipeAttachBundle = Omit<RecipeBundle, 'personality'> & {
  personality: RecipeAttachPersonality;
};
/** The both counterpart. */
export type RecipeBothBundle = Omit<RecipeBundle, 'personality'> & {
  personality: RecipeBothPersonality;
};

// ---------------------------------------------------------------------------
// Install mode — the two views of a bundle
// ---------------------------------------------------------------------------

/** How an install writes: a new personality, or onto an existing one. */
export type RecipeInstallMode = 'create' | 'attach';

/**
 * The mode an install runs in. A `create` or `attach` bundle IS its mode —
 * the request cannot change it. A `both` bundle takes the request, and
 * defaults to `create`.
 */
export function resolveInstallMode(
  bundle: Pick<RecipeBundle, 'personality'>,
  requested?: RecipeInstallMode,
): RecipeInstallMode {
  const mode = bundle.personality.mode;
  return mode === 'both' ? (requested ?? 'create') : mode;
}

/**
 * The bundle's personality as ONE view — the create variant or the attach
 * variant — so preflight, the templater, the installer and the UI keep their
 * two code paths. A `both` personality projects either way; a single-mode one
 * is itself, and asking it for the other mode is a caller bug.
 */
export function projectPersonality(
  bundle: Pick<RecipeBundle, 'personality'>,
  mode: 'create',
): RecipeCreatePersonality;
export function projectPersonality(
  bundle: Pick<RecipeBundle, 'personality'>,
  mode: 'attach',
): RecipeAttachPersonality;
export function projectPersonality(
  bundle: Pick<RecipeBundle, 'personality'>,
  mode: RecipeInstallMode,
): RecipeCreatePersonality | RecipeAttachPersonality;
export function projectPersonality(
  bundle: Pick<RecipeBundle, 'personality'>,
  mode: RecipeInstallMode,
): RecipeCreatePersonality | RecipeAttachPersonality {
  const p = bundle.personality;
  if (p.mode === 'both') {
    if (mode === 'attach') return { mode: 'attach', ...p.attach };
    const { attach: _attach, mode: _mode, ...create } = p;
    return { mode: 'create', ...create };
  }
  if (p.mode !== mode) {
    throw new Error(`recipe personality is ${p.mode}-only; cannot project it as ${mode}`);
  }
  return p;
}

/** The whole bundle with its personality projected — what the pipeline consumes. */
export function projectBundle(bundle: RecipeBundle, mode: RecipeInstallMode): RecipeBundle {
  return { ...bundle, personality: projectPersonality(bundle, mode) };
}
export type RecipeSecretRequirement = NonNullable<RecipeBundle['requires']['secrets']>[number];
export type RecipePostInstall = RecipeBundle['postInstall'][number];
