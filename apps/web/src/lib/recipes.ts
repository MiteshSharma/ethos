import type {
  CronDeliverTo,
  CronDeliveryTarget,
  RecipeBundleWire,
  RecipeInstallMode,
  RecipePreflight,
} from '@ethosagent/web-contracts';

// Pure helpers behind the Recipes UI (plan/phases/recipes-gallery.md §5).
// Nothing here touches React or the network, so the rules that actually decide
// whether the install button is live are testable on their own.

/**
 * The text form of a picked delivery target: `platform:botKey:chatId`.
 *
 * The structured `deliverTo` is what the server acts on; this string is what
 * the bundle's `chatTarget` INPUT holds, so the "still needed from you" row for
 * it disappears the moment a target is picked. Both are written — one is the
 * address, the other is the answer to a question the user has now answered.
 */
export function chatTargetValue(target: CronDeliveryTarget): string {
  return `${target.platform}:${target.botKey}:${target.chatId}`;
}

/**
 * A bot the user is setting up ON THE RECIPE PAGE, and the chat they picked
 * from what the server discovered.
 *
 * There is no `botKey` here on purpose: the bot does not exist yet, so nothing
 * client-side can know one. The install creates the bot, learns its key, and
 * builds the delivery target itself — which is also why the token travels on
 * `install` alone and never through the `inputs` record.
 */
export interface ChannelSetupDraft {
  platform: 'telegram';
  /** @BotFather credential. Sent once, on install. Never rendered, never stored. */
  token: string;
  chatId: string;
  /** `@briefer_bot` — from the server's live probe. */
  botLabel: string | null;
  /** The chat's own name, so the confirm step names it rather than a number. */
  chatLabel: string;
}

/** The `chatTarget` input's display text for an inline setup. Never parsed back. */
export function inlineChatTargetValue(draft: ChannelSetupDraft): string {
  return `${draft.platform}:${draft.botLabel ?? 'new bot'}:${draft.chatId}`;
}

/** The prefix preflight gives a `kind: 'credential'` row's key. */
const CREDENTIAL_KEY_PREFIX = 'secret:';

/**
 * `secret:web_search` → `web_search` — the tool a credential row is about.
 *
 * A credential row is not a bundle input, so it has no `key` of its own; the
 * one preflight mints (`extensions/recipes/src/preflight.ts`) names the tool,
 * and that is what the binding sent back to the server is keyed by.
 */
export function credentialToolName(row: { key: string }): string {
  return row.key.startsWith(CREDENTIAL_KEY_PREFIX)
    ? row.key.slice(CREDENTIAL_KEY_PREFIX.length)
    : row.key;
}

/**
 * The platform whose bot this recipe can set up inline, or `null`.
 *
 * Read off the bundle's own `requires.channels[]`: a recipe declares that its
 * delivery channel is answerable here, and the server independently declares
 * whether it can honour that (preflight suppresses the `NO_DELIVERY_TARGET`
 * blocker only when both agree).
 */
export function inlineSetupPlatform(bundle: RecipeBundleWire): 'telegram' | null {
  const channel = bundle.requires.channels.find((c) => c.deliversCron && c.inlineSetup);
  return channel?.platform === 'telegram' ? 'telegram' : null;
}

export function deliverToFromTarget(target: CronDeliveryTarget): CronDeliverTo {
  return {
    kind: 'channel',
    platform: target.platform,
    botKey: target.botKey,
    chatId: target.chatId,
  };
}

/** The bundle's `chatTarget` input key, when it declares one. */
export function chatTargetInputKey(bundle: RecipeBundleWire): string | undefined {
  return bundle.requires.inputs.find((input) => input.kind === 'chatTarget')?.key;
}

/** True when a scheduled job delivers into a real chat, so a target is required. */
export function needsDeliveryTarget(bundle: RecipeBundleWire): boolean {
  return bundle.cronJobs.some((job) => job.deliverTo === 'channel');
}

/** The form's starting values — every input that ships a default. */
export function defaultInputValues(bundle: RecipeBundleWire): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of bundle.requires.inputs) {
    if (input.default !== undefined) values[input.key] = input.default;
  }
  return values;
}

/**
 * Attach mode: prefill every still-empty `kind: 'path'` input with the chosen
 * personality's first working directory, normalised to end with `/` (reach is
 * a prefix match, and the input's own help says so). A value the user already
 * typed is never overwritten; with no workdir the field stays empty and
 * required, exactly as before.
 */
export function prefillPathInputs(
  bundle: RecipeBundleWire,
  values: Record<string, string>,
  workdir: string[] | null | undefined,
): Record<string, string> {
  const first = workdir?.[0];
  if (!first) return values;
  const root = first.endsWith('/') ? first : `${first}/`;
  const next = { ...values };
  for (const input of bundle.requires.inputs) {
    if (input.kind === 'path' && !next[input.key]?.trim()) next[input.key] = root;
  }
  return next;
}

/**
 * The mode an install runs in — the same rule the server applies
 * (`resolveInstallMode` in `@ethosagent/recipes`, which the browser cannot
 * import): a single-mode recipe IS its mode, a `both` recipe takes the choice
 * and defaults to create.
 */
export function resolveInstallMode(
  bundle: RecipeBundleWire,
  requested?: RecipeInstallMode,
): RecipeInstallMode {
  const mode = bundle.personality.mode;
  return mode === 'both' ? (requested ?? 'create') : mode;
}

/**
 * The bundle as ONE view — create or attach — so every surface below keeps
 * its two branches. A `both` recipe projects either way; anything else is
 * itself.
 */
export function projectBundle(bundle: RecipeBundleWire, mode: RecipeInstallMode): RecipeBundleWire {
  const p = bundle.personality;
  if (p.mode !== 'both') return bundle;
  if (mode === 'attach') return { ...bundle, personality: { mode: 'attach', ...p.attach } };
  const { attach: _attach, mode: _mode, ...create } = p;
  return { ...bundle, personality: { mode: 'create', ...create } };
}

/**
 * What to call the agent on this page: the bundle's own name in create mode;
 * in attach mode the chosen personality's, or a placeholder until one is.
 */
export function recipeAgentName(bundle: RecipeBundleWire, targetName?: string | null): string {
  if (bundle.personality.mode !== 'attach') return bundle.personality.name;
  return targetName ?? 'the personality you choose';
}

/**
 * Why the install cannot run yet, or `null` when it can.
 *
 * BLOCKING rows and unanswered inputs stop it. WARNINGS never do — a warning
 * is something the user should know (a plugin's safety finding, an optional
 * dependency that is absent, a stopped gateway), not a refusal.
 */
export function installBlockedReason(args: {
  preflight: RecipePreflight | undefined;
  needsTarget: boolean;
  /** An existing chat was picked, OR a new bot was set up here. Either satisfies it. */
  hasTarget: boolean;
}): string | null {
  const { preflight, needsTarget, hasTarget } = args;
  if (!preflight) return 'Checking prerequisites…';
  const blocking = preflight.blocking[0];
  if (blocking) return blocking.action;
  const missing = preflight.needsInput[0];
  // A credential is not "empty" — it is a key that lives in the vault, and the
  // sentence has to name the action rather than describe a blank field. The
  // action is usually a PICK: the key is often already there.
  if (missing?.kind === 'credential') return `Choose a ${missing.label} to continue.`;
  if (missing) return `${missing.label} is still empty.`;
  if (needsTarget && !hasTarget) return 'Pick the chat this recipe delivers to.';
  return null;
}

/** `6:20am` for a plain daily `M H * * *`; `null` for anything else. */
export function describeDailyTime(schedule: string): string | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') return null;
  if (!/^\d{1,2}$/.test(minute ?? '') || !/^\d{1,2}$/.test(hour ?? '')) return null;
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) return null;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

/**
 * The primary button names the OUTCOME — "Create Briefer and its 6:20am job",
 * never "Install". Reads the jobs off the preflight report, not off the
 * bundle, because those schedules have had `{{input.*}}` resolved already.
 */
export function installActionLabel(
  bundle: RecipeBundleWire,
  jobs: RecipePreflight['willCreate']['cronJobs'],
  targetName?: string | null,
): string {
  // An attach writes onto an agent that exists — "Attach to Writer", never
  // "Create Writer".
  const lead =
    bundle.personality.mode === 'attach'
      ? `Attach to ${recipeAgentName(bundle, targetName)}`
      : `Create ${bundle.personality.name}`;
  if (jobs.length === 0) return lead;
  const first = jobs[0];
  if (jobs.length === 1 && first) {
    const when = describeDailyTime(first.schedule);
    return `${lead} and its ${when ?? first.name} job`;
  }
  return `${lead} and its ${jobs.length} jobs`;
}

/** Why a chat is offered at all — the picker never shows a bare id. */
export function deliveryTargetReason(source: CronDeliveryTarget['source']): string {
  switch (source) {
    case 'owner':
      return 'your owner chat';
    case 'allowlist':
      return 'on your recipient allowlist';
    case 'paired':
      return 'paired with this bot';
    case 'observed':
      return 'this bot has been talked to here';
  }
}

export interface RequirementRow {
  /** What class of prerequisite this is — "Tools", "MCP servers", … */
  label: string;
  /** The named members, rendered in mono. */
  items: string[];
  /** `true` present, `false` missing. */
  ok: boolean;
}

/**
 * The declared requirements, each marked present or missing.
 *
 * Derived from preflight's CODES, never from its message text: a row's message
 * is prose for a human and matching against it would break the first time
 * someone rewords one. Per-class, therefore — the blocking rows underneath
 * name the individual item and the action that fixes it.
 */
export function requirementRows(
  bundle: RecipeBundleWire,
  preflight: RecipePreflight | undefined,
): RequirementRow[] {
  const codes = new Set((preflight?.blocking ?? []).map((row) => row.code));
  const rows: RequirementRow[] = [];
  const { requires } = bundle;

  if (requires.tools.length > 0) {
    rows.push({
      label: 'Tools',
      items: requires.tools,
      ok: !codes.has('TOOL_UNAVAILABLE'),
    });
  }
  for (const server of requires.mcpServers) {
    rows.push({
      label: 'MCP server',
      items: [server.name],
      // Structural: preflight lists exactly the servers it would attach.
      ok: (preflight?.willCreate.mcpAttachments ?? []).includes(server.name),
    });
  }
  if (requires.plugins.length > 0) {
    rows.push({
      label: 'Plugins',
      items: requires.plugins.map((plugin) => plugin.id),
      ok: !codes.has('PLUGIN_MISSING'),
    });
  }
  const binaries = requires.hostBinaries ?? [];
  if (binaries.length > 0) {
    rows.push({
      label: 'On PATH',
      items: binaries.map((binary) => binary.name),
      ok: !codes.has('HOST_BINARY_MISSING'),
    });
  }
  const secrets = requires.secrets ?? [];
  if (secrets.length > 0) {
    // Derived from the pending CREDENTIAL rows, the same way every other row
    // here derives from preflight rather than from the message text. A key that
    // is already in the vault shows as ready; one that is not is a row in
    // "Needs you" with the providers that would clear it.
    const pending = (preflight?.needsInput ?? []).some((row) => row.kind === 'credential');
    // An UNCHECKABLE credential is neither ready nor a question. The warning in
    // "Optional" says what could not be determined; a green row beside it would
    // contradict it.
    const unknown = (preflight?.warnings ?? []).some((w) => w.code === 'SECRET_STATUS_UNKNOWN');
    rows.push({
      label: 'Keys',
      items: secrets.map((secret) => secret.label),
      ok: preflight !== undefined && !pending && !unknown,
    });
  }
  const delivering = requires.channels.filter((channel) => channel.deliversCron);
  if (delivering.length > 0) {
    rows.push({
      label: 'Delivers on',
      items: delivering.map((channel) => channel.platform),
      ok: !codes.has('NO_DELIVERY_TARGET'),
    });
  }
  return rows;
}

/** Reads the structured `code` off an oRPC client error, if present. */
export function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * A stale preview. The user previewed one version and a different one is
 * shipped now, so the answer is to re-read what changed — never a silent retry
 * that installs something they have not seen.
 */
export function isStaleRecipeError(err: unknown): boolean {
  return errorCode(err) === 'RECIPE_STALE';
}

/**
 * The gallery card's one mono meta line — what this recipe wires up, in the
 * fewest words that are still true.
 *
 * Derived from the bundle, never authored: `cron → telegram · 1 MCP · 3
 * questions`. A recipe that wires nothing and asks nothing says so.
 */
export function recipeMetaLine(bundle: RecipeBundleWire): string {
  const destinations = new Set<string>();
  for (const job of bundle.cronJobs) {
    if (job.deliverTo === 'channel') {
      const channel = bundle.requires.channels.find((entry) => entry.deliversCron);
      destinations.add(channel ? `cron → ${channel.platform}` : 'cron → a chat');
    } else if (job.deliverTo === 'inApp') {
      destinations.add('cron → in-app');
    } else {
      destinations.add('cron → file');
    }
  }

  const parts = [...destinations];
  const { mcpServers, plugins, inputs } = bundle.requires;
  if (mcpServers.length > 0) parts.push(`${mcpServers.length} MCP`);
  if (plugins.length > 0) parts.push(`${plugins.length} plugin${plugins.length === 1 ? '' : 's'}`);
  const asks = inputs.filter((input) => input.required && input.default === undefined).length;
  if (asks > 0) parts.push(`${asks} question${asks === 1 ? '' : 's'}`);

  return parts.length > 0 ? parts.join(' · ') : 'no setup needed';
}

/** One line in a preflight group — glyph column, label, sub-line, mono value. */
export interface PreflightRow {
  key: string;
  glyph: string;
  /** Which `.recipe-glyph--*` modifier colors the glyph. */
  tone: 'ok' | 'no' | 'warn' | 'muted';
  label: string;
  detail?: string;
  /** An in-app route that fixes this row, when one exists. */
  href?: string;
  /** The right-hand mono word. */
  value: string;
}

export interface PreflightGroups {
  ready: PreflightRow[];
  needsYou: PreflightRow[];
  optional: PreflightRow[];
}

/**
 * Preflight, split the three ways the user actually reads it: what is already
 * true, what is still on them, and what the install runs without.
 *
 * A failing requirement is NOT drawn in `ready` with a cross — the blocking
 * row that explains it carries the same fact plus the action that fixes it,
 * and `requirementRows` derives its `ok` from those very codes. Drawing both
 * would say the same thing twice, once uselessly.
 */
export function preflightGroups(
  bundle: RecipeBundleWire,
  preflight: RecipePreflight | undefined,
): PreflightGroups {
  const ready: PreflightRow[] = requirementRows(bundle, preflight)
    .filter((row) => row.ok)
    .map((row) => ({
      key: `ready:${row.label}:${row.items.join(',')}`,
      glyph: '✓',
      tone: 'ok',
      label: row.label,
      detail: row.items.join(', '),
      value: 'ready',
    }));

  const needsYou: PreflightRow[] = [
    ...(preflight?.blocking ?? []).map((row) => ({
      key: `blocking:${row.code}:${row.message}`,
      glyph: '✗',
      tone: 'no' as const,
      label: row.message,
      detail: row.action,
      ...(row.href ? { href: row.href } : {}),
      value: 'blocked',
    })),
    ...(preflight?.needsInput ?? []).map((row) => ({
      key: `input:${row.key}`,
      glyph: '!',
      tone: 'warn' as const,
      label: row.label,
      detail: row.help,
      value: row.kind,
    })),
  ];

  const optional: PreflightRow[] = (preflight?.warnings ?? []).map((row) => ({
    key: `warning:${row.code}:${row.message}`,
    glyph: '○',
    tone: 'muted',
    label: row.message,
    value: 'optional',
  }));

  return { ready, needsYou, optional };
}

/** One line in the "what this creates" list on the recipe step. */
export interface CreatesRow {
  key: string;
  label: string;
  detail: string;
  value: string;
}

/**
 * What installing this bundle puts on the machine, read off the bundle itself.
 *
 * The recipe step runs before any answers are given, so this is the bundle's
 * own declaration — `{{input.*}}` placeholders and all. The resolved version,
 * with real schedules, is preflight's `willCreate` on the preview step.
 */
export function createsRows(bundle: RecipeBundleWire): CreatesRow[] {
  const { personality } = bundle;
  const rows: CreatesRow[] =
    personality.mode === 'create'
      ? [
          {
            key: 'personality',
            label: `An agent — ${personality.name}`,
            detail: personality.description,
            value: personality.id,
          },
        ]
      : personality.mode === 'both'
        ? [
            {
              key: 'personality',
              label: `Creates ${personality.name}, or attaches to a personality you choose`,
              detail: `${personality.description} Attaching adds a marked section to the chosen personality's SOUL.md; its name, model and network policy stay as they are.`,
              value: personality.id,
            },
          ]
        : [
            {
              key: 'personality',
              label: 'Attaches to a personality you choose',
              detail:
                'Adds a marked section to its SOUL.md. Its name, model and network policy stay as they are.',
              value: 'attach',
            },
          ];

  const { toolset } = personality;
  if (toolset.length > 0) {
    rows.push({
      key: 'toolset',
      label: `${toolset.length} tool${toolset.length === 1 ? '' : 's'}${
        personality.mode === 'attach' ? ' added' : ''
      }`,
      detail: toolset.join(', '),
      value: 'toolset',
    });
  }

  for (const server of bundle.requires.mcpServers) {
    rows.push({
      key: `mcp:${server.name}`,
      label: server.name,
      detail: server.why,
      value: server.auth === 'none' ? 'mcp' : server.auth,
    });
  }

  for (const plugin of bundle.requires.plugins) {
    rows.push({
      key: `plugin:${plugin.id}`,
      label: plugin.id,
      detail: plugin.why,
      value: 'plugin',
    });
  }

  for (const job of bundle.cronJobs) {
    rows.push({
      key: `cron:${job.name}`,
      label: `Scheduled — ${job.name}`,
      detail: job.prompt,
      value: job.schedule,
    });
  }

  return rows;
}
