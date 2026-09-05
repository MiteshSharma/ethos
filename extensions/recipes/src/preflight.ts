// Preflight — stage 2 of the install pipeline (plan/phases/recipes-gallery.md §3).
//
// PURE. Every fact about the machine arrives as a `RecipeWorldSnapshot`; this
// module reads no registry, no config and no filesystem. The service layer
// (R2, `apps/web-api/src/services/recipes.service.ts`) gathers the snapshot and
// owns every write — nothing here can install anything, which is what makes
// "nothing is written before stage 5" checkable rather than aspirational.
//
// Each check produces AT MOST one blocking row per unsatisfied requirement, and
// every row carries an `action` a user can actually perform.

import type { RecipeBundle } from './schema';
import {
  hasRecipeSoulSection,
  renderTemplatePreview,
  resolveInputs,
  unresolvedPlaceholders,
} from './template';

/**
 * A snapshot of the world, as the service layer sees it. Everything is scoped
 * to the personality the recipe would install — `cronJobNames` and
 * `deliveryTargets` are that personality's, not the whole machine's.
 */
export interface RecipeWorldSnapshot {
  /**
   * Personalities that already exist, with enough to tell "same recipe" from
   * "collision" (create mode) or "already attached" (attach mode). `builtin`
   * marks a read-only one an attach cannot write to.
   */
  personalities: Array<{ id: string; soulMd: string; toolset: string[]; builtin?: boolean }>;
  /** Registered tool names that pass `isAvailable()` — `toolRegistry.getAvailable()`. */
  availableTools: string[];
  /** MCP server names registered in `mcp.json`. */
  mcpServers: string[];
  /** Preset ids offered by `mcp.catalog`. */
  mcpCatalogIds: string[];
  /** Loaded plugins. `safetyFindings` are surfaced verbatim as warnings (D4). */
  plugins: Array<{ id: string; safetyFindings?: string[] }>;
  /** Host CLI names found on PATH. */
  hostBinaries: string[];
  /**
   * Credential facts for each `requires.secrets[]` entry, keyed by `toolName`.
   *
   * The service derives an entry from the TOOL's own `settingsSchema` (the
   * provider roster and the secret kind) and the key store (`keys.list`); this
   * module only compares. A requirement with NO entry is one this deployment
   * could not check — it becomes a warning, never a row the user has no way to
   * clear.
   */
  secretStatus?: Record<string, RecipeSecretStatus>;
  /** Names of cron jobs that already exist for this personality. */
  cronJobNames: string[];
  /** What `cron.deliveryTargets({ personalityId })` resolves for this personality (§1). */
  deliveryTargets: Array<{ platform: string; botKey: string; chatId: string; label: string }>;
  /** Gateway liveness — a scheduled job fires and delivers only while it runs. */
  gatewayRunning: boolean;
  /**
   * Platforms whose bot this deployment can create from the recipe page —
   * `['telegram']` where the channel-setup wiring is present, empty otherwise.
   *
   * A bundle DECLARES `requires.channels[].inlineSetup`; this says whether the
   * running server can honour it. Both must hold before "Deliver to" stops
   * being a blocker, because a setup panel the server cannot act on is the same
   * dead end in a nicer shirt. Absent ⇒ none, which is today's behaviour.
   */
  inlineSetupPlatforms?: string[];
  /**
   * Next fire time per RESOLVED cron expression, when the caller can compute
   * one. This package has no scheduler (it depends on `@ethosagent/types`
   * only); R2 fills this from `croner`. Absent ⇒ `nextRun: null`.
   */
  nextRunBySchedule?: Record<string, string>;
}

/** One provider whose key would satisfy a credential requirement. */
export interface RecipeSecretOption {
  /** The provider a binding names — e.g. `exa`. */
  provider: string;
  /** Human label — 'Exa'. Read off the tool's own `settingsSchema`. */
  label: string;
  /**
   * The secret NAME the tool resolves under this provider when nothing binds
   * it — `apiKey`. Derived from the key store's own ref, never spelled here.
   */
  defaultSecretName: string;
  /** Where the user gets one. */
  getKeyUrl?: string;
}

/** A named secret already in the vault. A NAME and a provider — never a value. */
export interface RecipeSecretRef {
  provider: string;
  name: string;
}

/**
 * Which named secret a recipe install will bind the tool to.
 *
 * `secret` is a NAME (`work`, `apiKey`), never a value. The install writes it
 * onto the personality's tool settings as `providers/<provider>/<secret>`,
 * which is what the tool resolves at run time.
 */
export interface RecipeSecretBinding {
  provider: string;
  secret: string;
}

/** What would satisfy a declared credential, and what the vault already holds. */
export interface RecipeSecretStatus {
  /** Category of named secret the tool's `secret-binding` field accepts. */
  secretKind: string;
  /** Every provider this deployment can store a key for. Never empty when known. */
  options: RecipeSecretOption[];
  /** Names — never values — of the keys already stored under those providers. */
  existing: RecipeSecretRef[];
}

/**
 * Is this requirement already met — for the binding the install would WRITE,
 * not merely for some key of the right kind sitting somewhere in the vault.
 *
 * With a binding, the answer is about that exact `providers/<p>/<name>`: a
 * recipe that binds `providers/exa/work` is not satisfied by an untouched
 * `providers/tavily/apiKey`. With no binding, the tool falls back to each
 * provider's default-named secret, so any one of those being present is enough
 * — which is what a fresh machine with `EXA_API_KEY` exported looks like.
 */
export function secretRequirementSatisfied(
  status: RecipeSecretStatus,
  binding: RecipeSecretBinding | undefined,
): boolean {
  const has = (provider: string, name: string) =>
    status.existing.some((ref) => ref.provider === provider && ref.name === name);
  if (binding) return has(binding.provider, binding.secret);
  return status.options.some((option) => has(option.provider, option.defaultSecretName));
}

export interface PreflightBlocker {
  code: string;
  message: string;
  /** Concrete, performable. "Add the 'google-calendar' MCP server", not "missing". */
  action: string;
  /** In-app route that fixes it, when one exists. */
  href?: string;
}

export interface PreflightNeedsInput {
  key: string;
  label: string;
  kind: string;
  help: string;
  suggested?: string;
  /**
   * `kind: 'credential'` only — the providers that would clear this row. The
   * user picks one of their existing keys (or adds one through the vault's own
   * write path); the VALUE never travels through a recipe input, a preflight
   * report or an install call.
   */
  credentialOptions?: RecipeSecretOption[];
  /** `kind: 'credential'` only — what the secret picker filters the vault by. */
  secretKind?: string;
}

export interface PreflightWarning {
  code: string;
  message: string;
}

/**
 * Stage 2's output. The plan's §3 shape minus `characterSheet`: rendering it
 * needs `renderCharacterSheet` from `@ethosagent/personalities`, and this
 * package deliberately depends on `@ethosagent/types` only. R2 renders the
 * sheet from `willCreate` and returns it in the same RPC payload.
 */
export interface PreflightReport {
  blocking: PreflightBlocker[];
  needsInput: PreflightNeedsInput[];
  warnings: PreflightWarning[];
  willCreate: {
    personality: { id: string; isNew: boolean };
    cronJobs: Array<{ name: string; schedule: string; nextRun: string | null; exists: boolean }>;
    mcpAttachments: string[];
  };
}

export interface PreflightRequest {
  bundle: RecipeBundle;
  snapshot: RecipeWorldSnapshot;
  /** Values the user has filled in so far. Defaults are merged underneath. */
  inputs?: Record<string, string>;
  /**
   * `personalityIdOverride` from `recipes.preflight` (§4). In create mode the
   * collision escape hatch; in attach mode the TARGET — required, and a
   * `PERSONALITY_REQUIRED` row until it arrives.
   */
  personalityId?: string;
  /**
   * Which named secret, per `requires.secrets[].toolName`, the user picked —
   * the binding the install would write. Names only; a value never appears
   * here, on `recipes.preflight`, or on `recipes.install`.
   */
  secretBindings?: Record<string, RecipeSecretBinding>;
}

/**
 * The `ethos mcp add` invocation that registers a server, built from the fields
 * the bundle already declares.
 *
 * Preflight cannot offer a button for this. `McpService.addServer` refuses
 * stdio transport from the web API deliberately (a stdio server is an arbitrary
 * local command), so for a stdio dependency the terminal is the only route and
 * the warning has to carry the command itself. `--args` consumes every
 * remaining token, so it goes last.
 */
function mcpAddCommand(server: RecipeBundle['requires']['mcpServers'][number]): string {
  const parts = [`ethos mcp add ${server.name}`];
  for (const key of server.envKeys ?? []) parts.push(`--env ${key}=<value>`);
  if (server.url) parts.push(`--url ${server.url}`);
  if (server.command) parts.push(`--command ${server.command}`);
  if (server.args && server.args.length > 0) parts.push(`--args ${server.args.join(' ')}`);
  return parts.join(' ');
}

function sameToolset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/**
 * Read-only. Never throws: a fact the caller could not determine belongs in the
 * snapshot as its "absent" value, and every unmet requirement is a row.
 */
export function preflightRecipe(req: PreflightRequest): PreflightReport {
  const { bundle, snapshot } = req;
  const blocking: PreflightBlocker[] = [];
  const warnings: PreflightWarning[] = [];

  const { values, missing } = resolveInputs(bundle, req.inputs);
  const needsInput: PreflightNeedsInput[] = missing.map((input) => ({
    key: input.key,
    label: input.label,
    kind: input.kind,
    help: input.help,
    ...(input.placeholder ? { suggested: input.placeholder } : {}),
  }));

  // --- personality id ------------------------------------------------------
  const p = bundle.personality;
  const personalityId =
    p.mode === 'create' ? (req.personalityId ?? p.id) : (req.personalityId ?? '');
  const existing = snapshot.personalities.find((entry) => entry.id === personalityId);
  if (p.mode === 'attach') {
    // The target is a CHOICE, not a bundle field — so "no choice yet" is a row
    // the user clears by picking, and a choice naming nothing is refused
    // before the first write rather than at it.
    if (!req.personalityId) {
      blocking.push({
        code: 'PERSONALITY_REQUIRED',
        message: 'Pick the personality this recipe attaches to.',
        action: 'Choose one of your personalities above.',
      });
    } else if (!existing) {
      blocking.push({
        code: 'PERSONALITY_NOT_FOUND',
        message: `No personality with the id '${personalityId}' exists.`,
        action: 'Pick an existing personality, or create one first.',
        href: '/personalities',
      });
    } else if (existing.builtin) {
      blocking.push({
        code: 'PERSONALITY_READ_ONLY',
        message: `'${personalityId}' is built-in, and its files cannot be changed.`,
        action: 'Duplicate it on the Personalities page and attach to the copy.',
        href: '/personalities',
      });
    } else if (hasRecipeSoulSection(existing.soulMd, bundle.id)) {
      // Said out loud, not blocked: the install is idempotent — tools, reach
      // and schedules are re-checked, and only the SOUL append is skipped.
      warnings.push({
        code: 'ALREADY_ATTACHED',
        message: `'${personalityId}' already carries this recipe's section. Installing again adds nothing to its SOUL.md.`,
      });
    }
  } else if (existing) {
    const wouldWrite = renderTemplatePreview(p.soulMd, values);
    const alreadyInstalled =
      existing.soulMd === wouldWrite && sameToolset(existing.toolset, p.toolset);
    if (!alreadyInstalled) {
      blocking.push({
        code: 'PERSONALITY_ID_TAKEN',
        message: `A different personality already uses the id '${personalityId}'.`,
        action: `Install under a different id, or delete '${personalityId}' first.`,
        href: '/personalities',
      });
    }
  }

  // --- tools ---------------------------------------------------------------
  for (const tool of bundle.requires.tools) {
    if (snapshot.availableTools.includes(tool)) continue;
    blocking.push({
      code: 'TOOL_UNAVAILABLE',
      message: `The '${tool}' tool is not available in this deployment.`,
      action: `Configure '${tool}' (or the provider it needs) before installing this recipe.`,
    });
  }

  // --- credentials ---------------------------------------------------------
  //
  // The check `TOOL_UNAVAILABLE` structurally cannot make. `web_search`
  // returns `isAvailable(): true` unconditionally and deliberately — the key
  // may live in Named Secrets, unreachable at filter time — so a keyless
  // deployment installs the recipe and discovers the gap at 6:20am, when the
  // briefing arrives with no headlines. This row moves that discovery to
  // before the install, and it clears the moment a key is set.
  //
  // NEEDS-INPUT, not blocking: it is a question with an answer the user can
  // give right here, which is the same shape as the Telegram chat target.
  for (const secret of bundle.requires.secrets ?? []) {
    const status = snapshot.secretStatus?.[secret.toolName];
    if (!status || status.options.length === 0) {
      // Undeterminable, so say that rather than emitting a row nothing can
      // clear — §3's rule for an unreachable check, and D14's lesson about a
      // requirement with no performable action.
      warnings.push({
        code: 'SECRET_STATUS_UNKNOWN',
        message: `Could not check whether a credential for '${secret.toolName}' is configured on this machine. ${secret.why}`,
      });
      continue;
    }
    // Against the BINDING the install would write, not against "some key of
    // this kind exists somewhere" — otherwise a recipe bound to a key named
    // `work` would read as satisfied by an unrelated `apiKey` and fail at run
    // time, which is the exact failure this row exists to prevent.
    if (secretRequirementSatisfied(status, req.secretBindings?.[secret.toolName])) continue;
    needsInput.push({
      key: `secret:${secret.toolName}`,
      label: secret.label,
      kind: 'credential',
      help: `${secret.why} Any one of: ${status.options.map((o) => o.label).join(', ')}.`,
      credentialOptions: status.options,
      secretKind: status.secretKind,
    });
  }

  // --- MCP servers ---------------------------------------------------------
  const mcpAttachments: string[] = [];
  for (const server of bundle.requires.mcpServers) {
    if (snapshot.mcpServers.includes(server.name)) {
      mcpAttachments.push(server.name);
      continue;
    }
    const preset = server.catalogId ? snapshot.mcpCatalogIds.includes(server.catalogId) : false;
    if (preset && server.auth === 'none') {
      // Auto-registrable at apply time — no credential decision to make.
      mcpAttachments.push(server.name);
      continue;
    }
    if (preset) {
      // A catalog preset that needs credentials is a postInstall step, not a
      // block — but say so, or the user reads the empty blocking list as "done".
      warnings.push({
        code: 'MCP_SERVER_NEEDS_SETUP',
        message: `'${server.name}' is a known preset but is not registered yet; it needs its ${server.auth} credentials. The post-install checklist covers it.`,
      });
      continue;
    }
    if (server.optional) {
      // D13 — an optional dependency the machine does not have is a smaller
      // recipe, not a refused one. Still said out loud: an empty blocking list
      // otherwise reads as "everything this recipe promises will work".
      warnings.push({
        code: 'MCP_SERVER_OPTIONAL_MISSING',
        message: `Optional — the '${server.name}' MCP server is not registered, so this recipe installs and runs without it. ${server.why}${
          server.transport === 'stdio' ? ' The web UI cannot add a stdio server.' : ''
        } To add it later, run: ${mcpAddCommand(server)}`,
      });
      continue;
    }
    blocking.push({
      code: 'MCP_SERVER_MISSING',
      message: `The '${server.name}' MCP server is not registered. ${server.why}`,
      action: `Add the '${server.name}' MCP server on the MCP page, then re-check.`,
      href: '/mcp',
    });
  }

  // --- plugins -------------------------------------------------------------
  for (const plugin of bundle.requires.plugins) {
    const loaded = snapshot.plugins.find((p) => p.id === plugin.id);
    if (!loaded) {
      blocking.push({
        code: 'PLUGIN_MISSING',
        message: `The '${plugin.id}' plugin is not loaded. ${plugin.why}`,
        action: `Install '${plugin.packageName}' on the Plugins page.`,
        href: '/plugins',
      });
      continue;
    }
    // D4 — yellow findings never block and are never swallowed.
    for (const finding of loaded.safetyFindings ?? []) {
      warnings.push({
        code: 'PLUGIN_SAFETY_FINDING',
        message: `${plugin.id}: ${finding}`,
      });
    }
  }

  // --- host binaries -------------------------------------------------------
  for (const binary of bundle.requires.hostBinaries ?? []) {
    if (snapshot.hostBinaries.includes(binary.name)) continue;
    blocking.push({
      code: 'HOST_BINARY_MISSING',
      message: `'${binary.name}' was not found on PATH. ${binary.why}`,
      action: binary.installHint,
    });
  }

  // --- delivery ------------------------------------------------------------
  //
  // A channel-delivering recipe needs a chat, and there are exactly two ways to
  // have one: a bot already speaks for this personality (the picker), or the
  // recipe can set one up right here (`inlineSetup`, honoured by the server).
  //
  // Only when NEITHER holds is this a BLOCKER. The distinction is the whole
  // point: "bind a bot to this agent in Communications" is unperformable while
  // the agent does not exist yet, so emitting it whenever the target set is
  // empty made the row permanent. With inline setup available the requirement
  // is an INPUT — the `chatTarget` row `resolveInputs` already produced — and
  // it clears the moment the token and the chat arrive.
  const channelJobs = bundle.cronJobs.filter((j) => j.deliverTo === 'channel');
  if (channelJobs.length > 0 && snapshot.deliveryTargets.length === 0) {
    const channel = bundle.requires.channels.find((c) => c.deliversCron);
    const platform = channel?.platform ?? 'a messaging';
    const inline =
      channel?.inlineSetup === true &&
      (snapshot.inlineSetupPlatforms ?? []).includes(channel.platform);
    if (!inline) {
      blocking.push({
        code: 'NO_DELIVERY_TARGET',
        message: `No ${platform} chat can receive this recipe's scheduled output.`,
        action: `Add a ${platform} bot bound to '${personalityId}' in Communications.`,
        href: '/communications',
      });
    }
  }

  if (bundle.cronJobs.length > 0 && !snapshot.gatewayRunning) {
    warnings.push({
      code: 'GATEWAY_NOT_RUNNING',
      message:
        'The gateway is not running. Scheduled jobs are created but will not fire or deliver until it starts.',
    });
  }

  return {
    blocking,
    needsInput,
    warnings,
    willCreate: {
      // An attach never creates: the target either exists or is refused above.
      personality: { id: personalityId, isNew: p.mode === 'create' && existing === undefined },
      cronJobs: bundle.cronJobs.map((job) => {
        // Preview only — an unfilled schedule keeps its placeholder rather than
        // rendering a wrong time; `needsInput` already names what is missing.
        const schedule =
          unresolvedPlaceholders(job.schedule, values).length === 0
            ? renderTemplatePreview(job.schedule, values)
            : job.schedule;
        return {
          name: job.name,
          schedule,
          nextRun: snapshot.nextRunBySchedule?.[schedule] ?? null,
          exists: snapshot.cronJobNames.includes(job.name),
        };
      }),
      mcpAttachments,
    },
  };
}

/**
 * Tool names a bundle asks for that the deployment does not know about.
 *
 * Separate from `preflightRecipe` because it answers a different question at a
 * different time: preflight asks "can THIS machine run this recipe today",
 * this asks "is this bundle still consistent with the tools that exist in the
 * repo at all" — the check that rots fastest, since a renamed tool silently
 * breaks every recipe that used it.
 */
export function unknownToolNames(bundle: RecipeBundle, known: Iterable<string>): string[] {
  const knownSet = new Set(known);
  const p = bundle.personality;
  const referenced = new Set([
    ...bundle.requires.tools,
    ...p.toolset,
    ...(p.mode === 'both' ? p.attach.toolset : []),
  ]);
  return [...referenced].filter((name) => !knownSet.has(name)).sort();
}
