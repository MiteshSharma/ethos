import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { nextRunForSchedule } from '@ethosagent/cron';
import { renderCharacterSheet } from '@ethosagent/personalities';
import {
  appendRecipeSoulSection,
  defaultRecipeSafety,
  hasRecipeSoulSection,
  type PreflightBlocker,
  preflightRecipe,
  projectBundle,
  RECIPES,
  type RecipeAttachPersonality,
  type RecipeBundle,
  RecipeBundleSchema,
  type RecipeCronJob,
  type RecipeInstallMode,
  type RecipeSecretBinding,
  type RecipeSecretOption,
  type RecipeSecretRef,
  RecipeTemplateError,
  type RecipeWorldSnapshot,
  renderRecipe,
  renderTemplatePreview,
  resolveInputs,
  resolveInstallMode,
  unresolvedPlaceholders,
} from '@ethosagent/recipes';
import {
  EthosError,
  type PersonalityConfig,
  type Storage,
  type ToolRegistry,
} from '@ethosagent/types';
import type {
  CronDeliverTo,
  RecipeBundleWire,
  RecipeChannelSetup,
  RecipeDiscoverChatsOutput,
  RecipeInstallReport,
  RecipeListItem,
  RecipePreflight,
} from '@ethosagent/web-contracts';
import { NamedSecretProviderSchema } from '@ethosagent/web-contracts';
import type { CronService } from './cron.service';
import type { KeysService } from './keys.service';
import type { McpService } from './mcp.service';
import type { PersonalitiesService } from './personalities.service';
import type { PluginsService } from './plugins.service';
import { type ChannelSetupWorld, usernameFrom } from './recipe-channel-setup';
import type { ToolSettingsService } from './tool-settings.service';

// Recipes — the install pipeline's orchestration half
// (plan/phases/recipes-gallery.md §3, §4).
//
// `@ethosagent/recipes` owns the bundle schema, the `{{input.*}}` templater and
// preflight, all of them PURE over an injected world snapshot. This file is the
// other half: it gathers that snapshot from the registries, renders the
// character sheet, and runs stage 5's apply/compensate against
// `PersonalitiesService`, `CronService` and `McpService`.
//
// The cross-store awkwardness lives HERE, deliberately, in one file at the app
// layer. Say it plainly, because the alternative is a lie: there is no
// cross-store transaction. Personalities are files, cron jobs are the
// scheduler's store, MCP attachments are a personality-local yaml. "One
// transaction" means COMPENSATING ROLLBACK, and compensation can itself fail.
// When it does, the report names each orphaned object with the page that
// deletes it. That is the honest ceiling, and it is why preflight does so much
// work: the cheapest rollback is the one that was never needed.

/**
 * Only the service methods the pipeline actually calls. Narrowed with `Pick`
 * rather than hand-written ports: there is no second abstraction to keep in
 * sync, and a test can satisfy the shape without constructing an `McpManager`.
 */
export interface RecipesServiceOptions {
  personalities: Pick<
    PersonalitiesService,
    'list' | 'exists' | 'get' | 'config' | 'create' | 'update' | 'delete'
  >;
  cron: Pick<CronService, 'list' | 'create' | 'delete' | 'deliveryTargets'>;
  mcp: Pick<McpService, 'list' | 'catalog' | 'addServer' | 'attachPersonalities' | 'delete'>;
  /** Loaded plugins + their safety findings. Absent → no plugin facts, so a
   *  plugin-requiring recipe blocks rather than silently passing. */
  plugins?: Pick<PluginsService, 'list'>;
  /** Same source as `tools.catalog` — `getAvailable()`. Absent → no tool is
   *  available, which blocks every recipe rather than pretending. */
  toolRegistry?: Pick<ToolRegistry, 'getAvailable'>;
  /**
   * The key store, for `requires.secrets` (a recipe whose tools need a
   * credential). Absent ⇒ the requirement cannot be CHECKED, so preflight warns
   * that it could not be determined rather than emitting a row nothing on the
   * page can clear. Reads only — the value is written by the user through
   * `keys.set`, never by this service.
   */
  keys?: Pick<KeysService, 'list'>;
  /**
   * Per-personality tool settings — where a credential ANSWER is recorded.
   * `web_search` resolves `providers/<provider>/<name>` from this binding and
   * falls back to `providers/<provider>/apiKey` without one, so a key the user
   * stored under any other name is unreachable until the install writes it.
   * Absent ⇒ a binding cannot be honoured, and the install refuses rather than
   * creating an agent whose searches silently return nothing.
   */
  toolSettings?: Pick<ToolSettingsService, 'getForPersonality' | 'setForPersonality'>;
  /**
   * Inline channel setup — creates and binds the bot a recipe's schedules
   * deliver through. Absent ⇒ `snapshot.inlineSetupPlatforms` is empty, so
   * preflight keeps emitting the `NO_DELIVERY_TARGET` blocker and a
   * `channelSetup` on install is refused. A setup panel the server cannot act
   * on is the same dead end in a nicer shirt.
   */
  channelSetup?: ChannelSetupWorld;
  /** Reads `<dataDir>/gateway-health.json` for the liveness warning. */
  storage: Storage;
  dataDir: string;
  /** Injectable clock — `nextRun` is the only thing that reads it. */
  now?: () => Date;
}

/** A heartbeat older than this means the gateway is not running. Matches `/healthz`. */
const GATEWAY_HEARTBEAT_STALE_MS = 30_000;

export class RecipesService {
  constructor(private readonly opts: RecipesServiceOptions) {}

  /**
   * The curated catalog. No input: it is static, small and first-party (D11).
   *
   * `attachedTo` is the one non-static column, and it is DERIVED (D8): an
   * attach recipe is "installed" wherever a SOUL.md carries its marker, so the
   * row reads every personality's SOUL once per call. A create recipe's state
   * is derived client-side from its bundle's id, as before; a `both` recipe
   * gets both signals.
   */
  async list(): Promise<{ recipes: RecipeListItem[] }> {
    const attach = RECIPES.filter((r) => r.personality.mode !== 'create');
    const souls = attach.length === 0 ? [] : await this.personalitySouls();
    return {
      recipes: RECIPES.map((r) => ({
        id: r.id,
        version: r.version,
        title: r.title,
        summary: r.summary,
        tags: r.tags,
        sourceDoc: r.sourceDoc ?? null,
        // A `both` recipe exposes both signals: this, and the create-mode
        // "its personality exists", which the gallery derives from the bundle.
        attachedTo:
          r.personality.mode !== 'create'
            ? souls.filter((s) => hasRecipeSoulSection(s.soulMd, r.id)).map((s) => s.id)
            : null,
      })),
    };
  }

  /** Stage 1 — the whole bundle. The detail view shows the SOUL body, the
   *  toolset, the schedules and the notes BEFORE install: a user must be able
   *  to read what they are about to run. */
  get(id: string): { recipe: RecipeBundleWire } {
    return { recipe: toWire(resolveBundle(id)) };
  }

  /** Stages 2 + 3 — read-only, repeatable, stateless. No writes. */
  async preflight(input: {
    id: string;
    inputs?: Record<string, string>;
    personalityIdOverride?: string;
    installMode?: RecipeInstallMode;
    secretBindings?: Record<string, RecipeSecretBinding>;
  }): Promise<RecipePreflight> {
    // The effective mode is resolved ONCE, here, and the bundle is projected
    // to that one view; everything below is the create path or the attach
    // path, never a third.
    const bundle = resolveProjected(input.id, input.installMode);
    const personalityId = targetPersonalityId(bundle, input.personalityIdOverride);
    const { values } = resolveInputs(bundle, input.inputs);
    const snapshot = await this.snapshot(bundle, personalityId, values);
    const report = preflightRecipe({
      bundle,
      snapshot,
      ...(input.inputs ? { inputs: input.inputs } : {}),
      ...(input.secretBindings ? { secretBindings: input.secretBindings } : {}),
      ...(personalityId ? { personalityId } : {}),
    });
    report.blocking.push(...pathInputBlockers(bundle, values));
    return {
      ...report,
      characterSheet: await this.previewSheet(bundle, personalityId, snapshot, values),
      postInstall: bundle.postInstall,
    };
  }

  /**
   * The missing link in inline channel setup — READ-ONLY, and the only way a
   * chat id enters this system.
   *
   * Binding a bot says which PERSONALITY speaks through it, never which chat
   * hears it. So the user is told to message their brand-new bot, and this
   * asks Telegram who has: one `getUpdates`, no long poll, no `offset` (which
   * would acknowledge and destroy the very update the install re-reads to
   * authorize the pick). R0's invariant holds — the server resolves the id and
   * the user chooses from a list; nothing anywhere accepts a typed chat id.
   *
   * A 409 means the running gateway owns this token and is already polling it.
   * That is a fact, not a failure: the caller falls back to
   * `cron.deliveryTargets`, which reads the gateway's own pairing store.
   */
  async discoverChats(input: {
    platform: 'telegram';
    token: string;
  }): Promise<RecipeDiscoverChatsOutput> {
    const world = this.opts.channelSetup;
    if (!world?.platforms.includes(input.platform)) {
      throw new EthosError({
        code: 'RECIPE_CHANNEL_SETUP_FAILED',
        cause: `This deployment cannot set up a ${input.platform} bot from a recipe.`,
        action: 'Add the bot in Communications, then re-check the recipe.',
      });
    }

    // The token is probed first so a typo is reported as a typo rather than as
    // "nothing has messaged your bot". `label` is `@botname` — the confirmation
    // that they pasted the right credential, and the ONLY thing about the token
    // that ever travels back.
    const probe = await world.validateToken(input.platform, input.token);
    if (!probe.ok) {
      return {
        status: probe.retryable ? 'unreachable' : 'rejected',
        botLabel: null,
        chats: [],
        error: probe.error,
      };
    }

    const discovery = await world.discoverChats(input.platform, input.token);
    return { ...discovery, botLabel: probe.label };
  }

  /**
   * Stages 5 + 6 — the only method here that writes.
   *
   * Stages 1-4 refuse by THROWING: nothing was attempted, and an all-empty
   * report says less than the error does. An apply failure RETURNS a report
   * (`ok: false`) instead, because by then there is something to say — what was
   * rolled back, and what could not be.
   */
  async install(input: {
    id: string;
    version: number;
    inputs: Record<string, string>;
    personalityIdOverride?: string;
    installMode?: RecipeInstallMode;
    deliverTo?: CronDeliverTo;
    channelSetup?: RecipeChannelSetup;
    secretBindings?: Record<string, RecipeSecretBinding>;
  }): Promise<RecipeInstallReport> {
    const bundle = resolveProjected(input.id, input.installMode);
    if (bundle.version !== input.version) {
      throw new EthosError({
        code: 'RECIPE_STALE',
        cause: `You previewed '${bundle.id}' v${input.version}, but v${bundle.version} is shipped now.`,
        action: 'Re-open the recipe so you can read what changed, then install again.',
      });
    }

    const personalityId = targetPersonalityId(bundle, input.personalityIdOverride);
    const setupInput = input.channelSetup;
    if (setupInput && input.deliverTo?.kind === 'channel') {
      // Two answers to one question. `deliverTo` names an EXISTING bot's chat;
      // `channelSetup` asks us to make the bot. Picking one silently would
      // install a delivery target the user did not choose.
      throw new EthosError({
        code: 'RECIPE_BLOCKED',
        cause: 'This install both picked an existing chat and asked to set up a new bot.',
        action: 'Choose one — an existing delivery target, or a new bot.',
      });
    }

    // A channel target is picked structurally, from `cron.deliveryTargets` or
    // from `recipes.discoverChats`. The bundle's `chatTarget` input exists so
    // the form can show the choice and so a SOUL may mention it; it is TEXT and
    // is never parsed back into an address. Seeding it here lets a client send
    // only the structured answer without tripping the "still needed from you"
    // list it has, in fact, answered.
    const inputs = { ...input.inputs };
    const chatTargetKey = bundle.requires.inputs.find((i) => i.kind === 'chatTarget')?.key;
    if (chatTargetKey && !inputs[chatTargetKey]?.trim()) {
      if (input.deliverTo?.kind === 'channel') {
        const t = input.deliverTo;
        inputs[chatTargetKey] = `${t.platform}:${t.botKey}:${t.chatId}`;
      } else if (setupInput) {
        // No botKey yet — the bot does not exist. The chat id is the part that
        // is already true, and this string is display text either way.
        inputs[chatTargetKey] = `${setupInput.platform}:${setupInput.chatId}`;
      }
    }

    const { values } = resolveInputs(bundle, inputs);
    const snapshot = await this.snapshot(bundle, personalityId, values);
    // The SAME check the page ran, over the same bindings — so a binding naming
    // a secret that is not in the vault leaves its credential row unsatisfied
    // and is refused below, before the first write.
    const secretBindings = input.secretBindings;
    const report = preflightRecipe({
      bundle,
      snapshot,
      inputs,
      ...(secretBindings ? { secretBindings } : {}),
      ...(personalityId ? { personalityId } : {}),
    });
    report.blocking.push(...pathInputBlockers(bundle, values));
    // `personalityId` is undefined only for an attach with no target, which
    // preflight has just refused with `PERSONALITY_REQUIRED` — the guard is
    // one condition so the narrowing below is honest, not a second check.
    if (report.blocking.length > 0 || report.needsInput.length > 0 || !personalityId) {
      throw new EthosError({
        code: 'RECIPE_BLOCKED',
        cause: [
          ...report.blocking.map((b) => b.message),
          ...report.needsInput.map((n) => `'${n.label}' is still empty.`),
        ].join(' '),
        action: report.blocking[0]?.action ?? 'Fill in the remaining fields, then install again.',
        details: { blocking: report.blocking, needsInput: report.needsInput },
      });
    }
    if (
      bundle.cronJobs.some((j) => j.deliverTo === 'channel') &&
      input.deliverTo?.kind !== 'channel' &&
      !setupInput
    ) {
      throw new EthosError({
        code: 'RECIPE_BLOCKED',
        cause: `'${bundle.title}' delivers its scheduled output to a chat, but no chat was chosen.`,
        action: 'Pick a delivery target from the list this personality resolves.',
      });
    }

    // Every network check the channel setup needs happens HERE, before the
    // first write. A bad token or a chat that never messaged this bot is then a
    // refusal with nothing to roll back — the cheapest rollback is the one that
    // was never needed.
    const setup = setupInput ? await this.verifyChannelSetup(setupInput) : undefined;

    // Every `{{input.*}}` is substituted BEFORE the first write (D7). An
    // unresolved placeholder here is unreachable — `needsInput` above already
    // refused — but it is a hard error rather than a literal in a SOUL.md.
    let resolved: ReturnType<typeof renderRecipe>;
    try {
      resolved = renderRecipe(bundle, values);
    } catch (err) {
      if (err instanceof RecipeTemplateError) {
        throw new EthosError({
          code: 'RECIPE_BLOCKED',
          cause: err.message,
          action: 'Fill in every required field, then install again.',
        });
      }
      throw err;
    }

    return this.apply(bundle, resolved, personalityId, snapshot, input.deliverTo, setup, {
      ...(secretBindings ? { secretBindings } : {}),
    });
  }

  /**
   * Read-only pre-flight for the channel setup: is the token real, and did the
   * chat the client picked actually message THIS bot?
   *
   * The client's pick is re-read from Telegram rather than trusted, for the
   * same reason `CronService.create` recomputes the target set: a chat id that
   * arrives over the wire is a claim, not evidence.
   */
  private async verifyChannelSetup(setup: RecipeChannelSetup): Promise<ApplyChannelSetup> {
    const world = this.opts.channelSetup;
    if (!world?.platforms.includes(setup.platform)) {
      throw new EthosError({
        code: 'RECIPE_CHANNEL_SETUP_FAILED',
        cause: `This deployment cannot set up a ${setup.platform} bot from a recipe.`,
        action: 'Add the bot in Communications, bind it to this agent, then install again.',
      });
    }

    const probe = await world.validateToken(setup.platform, setup.token);
    if (!probe.ok) {
      throw new EthosError({
        code: 'RECIPE_CHANNEL_SETUP_FAILED',
        // `probe.error` is the platform's own one-liner ('Invalid token',
        // 'Telegram returned 502'). It never carries the credential.
        cause: `The ${setup.platform} bot token was not accepted: ${probe.error ?? 'unknown reason'}.`,
        action: probe.retryable
          ? `${setup.platform} could not be reached — nothing was created. Try again in a moment.`
          : 'Check the token with @BotFather and paste it again.',
      });
    }

    const discovery = await world.discoverChats(setup.platform, setup.token);
    if (discovery.status === 'gateway_owns_token') {
      // The running gateway is polling this token, so it — not us — is the
      // authority on which chats have talked to this bot. Record nothing;
      // `CronService.create` reads that authority and will accept or refuse.
      return { world, setup, botLabel: probe.label, record: false };
    }
    if (discovery.status !== 'ok') {
      throw new EthosError({
        code: 'RECIPE_CHANNEL_SETUP_FAILED',
        cause:
          discovery.status === 'waiting'
            ? `Nothing has messaged ${probe.label ?? 'this bot'} yet, so there is no chat to deliver to.`
            : `Could not read this bot's messages: ${discovery.error ?? 'unknown reason'}.`,
        action: `Open ${setup.platform}, send ${probe.label ?? 'your bot'} any message, then check again.`,
      });
    }
    if (!discovery.chats.some((chat) => chat.chatId === setup.chatId)) {
      throw new EthosError({
        code: 'RECIPE_CHANNEL_SETUP_FAILED',
        cause: `Chat "${setup.chatId}" has not messaged ${probe.label ?? 'this bot'}.`,
        action: `Send ${probe.label ?? 'your bot'} a message from that chat, check again, and pick it from the list.`,
      });
    }
    return { world, setup, botLabel: probe.label, record: true };
  }

  // -------------------------------------------------------------------------
  // Stage 5 — apply, with a compensating rollback in reverse order
  // -------------------------------------------------------------------------

  private async apply(
    bundle: RecipeBundle,
    resolved: ReturnType<typeof renderRecipe>,
    personalityId: string,
    snapshot: RecipeWorldSnapshot,
    deliverTo: CronDeliverTo | undefined,
    setup: ApplyChannelSetup | undefined,
    answers: { secretBindings?: Record<string, RecipeSecretBinding> },
  ): Promise<RecipeInstallReport> {
    const created: RecipeInstallReport['created'] = {
      personality: null,
      channelBot: null,
      cronJobs: [],
      mcpAttachments: [],
    };
    const skipped: RecipeInstallReport['skipped'] = [];
    /** LIFO. Each entry names the object it undoes and the page that shows it. */
    const undo: Array<{ what: string; href: string; run: () => Promise<void> }> = [];

    try {
      // 1 — the personality. Create mode: skipped when one this same bundle
      // would produce is already there; preflight refused any other collision.
      // Attach mode: ONE update onto the target, with an undo that restores the
      // exact previous values.
      const existing = snapshot.personalities.find((p) => p.id === personalityId);
      const p = resolved.personality;
      if (p.mode === 'attach') {
        const step = await this.attachTo(bundle, p, personalityId);
        if (step) {
          created.personality = personalityId;
          undo.push(step);
        } else {
          skipped.push({
            what: `SOUL section on '${personalityId}'`,
            because: 'it is already attached',
          });
        }
      } else if (existing) {
        skipped.push({
          what: `personality '${personalityId}'`,
          because: 'it already matches this recipe',
        });
      } else {
        await this.opts.personalities.create({
          id: personalityId,
          name: p.name,
          description: p.description,
          soulMd: p.soulMd,
          toolset: p.toolset,
          ...(p.model ? { model: p.model } : {}),
          ...(p.provider ? { provider: p.provider } : {}),
          ...(p.capabilities ? { capabilities: p.capabilities } : {}),
          ...(p.mcpServers ? { mcp_servers: p.mcpServers } : {}),
          ...(p.plugins ? { plugins: p.plugins } : {}),
          ...(p.fsReach ? { fs_reach: p.fsReach } : {}),
          // Always present — `renderRecipe` fills in the `allow: ['*']` default
          // for a bundle that declares none (D15). Writing nothing here is what
          // shipped an agent whose every `web_extract` call died on
          // HOST_NOT_ALLOWED.
          ...(p.safety ? { safety: p.safety } : {}),
        });
        created.personality = personalityId;
        undo.push({
          what: `personality '${personalityId}'`,
          href: '/personalities',
          run: () => this.opts.personalities.delete(personalityId),
        });
      }

      // 2 — the credential bindings the user answered the `needsInput`
      // credential rows with. Cannot run before step 1 (the binding is written
      // onto the personality's own `tools.yaml`), and must not be skipped: a
      // key stored under any name but the tool's default is INVISIBLE to the
      // tool without a binding, so an agent installed against
      // `providers/exa/work` would return no results and say nothing about it
      // — the exact failure the credential row exists to prevent.
      for (const step of await this.bindSecrets(bundle, personalityId, answers.secretBindings)) {
        undo.push(step);
      }

      // 3 — the bot the schedules deliver through, bound to the personality
      // that now exists. This stage is the whole point of inline setup: it
      // cannot run before step 1, because `botsAddTelegram` binds to an
      // existing personality, and it must run before step 4, because a cron
      // job's channel target names a configured bot's `botKey`.
      let channelDeliverTo = deliverTo;
      if (setup) {
        const { world, setup: config } = setup;
        const username = usernameFrom(setup.botLabel);
        const { botKey, created: madeBot } = await world.addBot({
          platform: config.platform,
          token: config.token,
          personalityId,
          ...(username ? { username } : {}),
        });
        const botName = setup.botLabel ?? botKey;
        if (madeBot) {
          created.channelBot = botName;
          undo.push({
            what: `${config.platform} bot '${botName}'`,
            href: '/communications',
            run: () => world.removeBot(config.platform, botKey),
          });
        } else {
          skipped.push({
            what: `${config.platform} bot '${botName}'`,
            because: 'this token is already configured on this machine',
          });
        }
        if (setup.record) {
          // The server watched this chat message this bot (`verifyChannelSetup`
          // re-read `getUpdates`). Telling the delivery-target resolver so is
          // what makes the chat a GENUINE target — `CronService.create` still
          // recomputes the set below and would refuse it otherwise. The guard
          // is not relaxed; it is given the evidence it was missing.
          await world.recordChat(config.platform, botKey, config.chatId);
          undo.push({
            what: `delivery target '${config.chatId}'`,
            href: '/cron',
            run: () => world.forgetChat(config.platform, botKey, config.chatId),
          });
        }
        channelDeliverTo = {
          kind: 'channel',
          platform: config.platform,
          botKey,
          chatId: config.chatId,
        };
      }

      // 4 — MCP. Register what is auto-registrable, then attach.
      const registered = new Set((await this.opts.mcp.list()).servers.map((s) => s.name));
      const catalogIds = new Set(catalogPresetIds(this.opts.mcp.catalog()));
      const attachedBefore = existing ? await this.attachedServers(personalityId) : null;
      for (const server of bundle.requires.mcpServers) {
        if (!registered.has(server.name)) {
          if (server.optional) {
            // D13 — the recipe runs without it. Preflight already warned, with
            // the `ethos mcp add` command; installing a smaller recipe beats
            // refusing one over a section the user said they could live without.
            skipped.push({
              what: `MCP server '${server.name}'`,
              because: 'it is optional and not registered on this machine',
            });
            continue;
          }
          // Only `auth: 'none'` catalog presets — anything needing a credential
          // is a decision the user makes on the MCP page, not one we make for
          // them. Preflight has already routed those to `postInstall`.
          if (!server.catalogId || !catalogIds.has(server.catalogId) || server.auth !== 'none') {
            throw new EthosError({
              code: 'RECIPE_BLOCKED',
              cause: `The '${server.name}' MCP server is not registered and cannot be registered automatically.`,
              action: `Add '${server.name}' on the MCP page, then install again.`,
            });
          }
          const result = await this.opts.mcp.addServer({
            name: server.name,
            transport: server.transport,
            ...(server.url ? { url: server.url } : {}),
            ...(server.command ? { command: server.command } : {}),
            ...(server.args ? { args: server.args } : {}),
            authType: 'none',
          });
          if (!result.ok) {
            throw new EthosError({
              code: 'RECIPE_BLOCKED',
              cause: `Could not register the '${server.name}' MCP server: ${result.detail}`,
              action: `Add '${server.name}' by hand on the MCP page, then install again.`,
            });
          }
          undo.push({
            what: `MCP server '${server.name}'`,
            href: '/mcp',
            run: async () => {
              await this.opts.mcp.delete({ name: server.name });
            },
          });
        }

        const attach = await this.opts.mcp.attachPersonalities({
          serverName: server.name,
          personalityIds: [personalityId],
        });
        const failure = attach.failed[0];
        if (failure) {
          throw new EthosError({
            code: 'RECIPE_BLOCKED',
            cause: `Could not attach '${server.name}' to '${personalityId}': ${failure.error}`,
            action: 'Attach the server from the MCP page, then install again.',
          });
        }
        if (attachedBefore?.includes(server.name)) {
          skipped.push({
            what: `MCP attachment '${server.name}'`,
            because: `'${personalityId}' is already attached to it`,
          });
        } else {
          created.mcpAttachments.push(server.name);
        }
        // Only a PRE-EXISTING personality needs its attachment undone on its
        // own: deleting a personality this apply created takes its `mcp.yaml`
        // with it.
        if (attachedBefore && !attachedBefore.includes(server.name)) {
          const restore = [...attachedBefore];
          undo.push({
            what: `MCP attachment '${server.name}'`,
            href: '/mcp',
            run: async () => {
              await this.opts.personalities.update(personalityId, { mcp_servers: restore });
            },
          });
        }
      }

      // 5 — the schedules.
      for (const job of resolved.cronJobs) {
        if (snapshot.cronJobNames.includes(job.name)) {
          skipped.push({
            what: `cron job '${job.name}'`,
            because: `'${personalityId}' already has a job with this name`,
          });
          continue;
        }
        const result = await this.opts.cron.create({
          name: job.name,
          schedule: job.schedule,
          prompt: job.prompt,
          personalityId,
          ...(job.missedRunPolicy ? { missedRunPolicy: job.missedRunPolicy } : {}),
          deliverTo: originFor(job, channelDeliverTo),
        });
        created.cronJobs.push(result.job.name);
        undo.push({
          what: `cron job '${job.name}'`,
          href: '/cron',
          run: () => this.opts.cron.delete(result.job.id),
        });
      }

      return {
        ok: true,
        created,
        skipped,
        rolledBack: [],
        orphaned: [],
        failure: null,
        remaining: bundle.postInstall,
        starterPrompt: bundle.starterPrompt,
      };
    } catch (err) {
      const rolledBack: RecipeInstallReport['rolledBack'] = [];
      const orphaned: RecipeInstallReport['orphaned'] = [];
      for (const step of undo.reverse()) {
        try {
          await step.run();
          rolledBack.push({ what: step.what, ok: true });
        } catch {
          // Compensation can itself fail. Name the object and the page that
          // deletes it rather than pretending the world is clean.
          rolledBack.push({ what: step.what, ok: false });
          orphaned.push({ what: step.what, href: step.href });
        }
      }
      return {
        ok: false,
        created: { personality: null, channelBot: null, cronJobs: [], mcpAttachments: [] },
        skipped,
        rolledBack,
        orphaned,
        failure: toFailure(err),
        remaining: bundle.postInstall,
        starterPrompt: bundle.starterPrompt,
      };
    }
  }

  /**
   * Attach mode's step 1: read the target, compute the additions, and write
   * them in ONE `personalities.update`. Returns the undo entry, or `null` when
   * the SOUL already carries this recipe's section — the toolset and reach
   * unions are then no-ops too, and the step reports as skipped.
   *
   * Reach is APPENDED, never replaced. When the target declares no read (or
   * write) list, the loop derives the defaults (own directory, skills,
   * workdir — `deriveFsReachPaths` in core); writing only the recipe's paths
   * would REPLACE those defaults and make the personality's own directory
   * unreachable. So an absent list is seeded with the same token-form defaults
   * the loop would have used, then the recipe's entries are appended.
   */
  private async attachTo(
    bundle: RecipeBundle,
    p: RecipeAttachPersonality,
    personalityId: string,
  ): Promise<{ what: string; href: string; run: () => Promise<void> } | null> {
    const { personality: target, soulMd } = await this.opts.personalities.get(personalityId);
    if (hasRecipeSoulSection(soulMd, bundle.id)) return null;

    const before = {
      soulMd,
      toolset: target.toolset ?? [],
      plugins: target.plugins,
      // `[]` is how "declared nothing" is written back: the renderer omits an
      // empty list, so the reload derives the defaults exactly as before.
      read: target.fs_reach?.read ?? [],
      write: target.fs_reach?.write ?? [],
    };
    const union = (base: readonly string[], extra: readonly string[]) => [
      ...base,
      ...extra.filter((entry) => !base.includes(entry)),
    ];
    const addsPlugins = p.plugins !== undefined && p.plugins.length > 0;
    await this.opts.personalities.update(personalityId, {
      soulMd: appendRecipeSoulSection(soulMd, bundle.id, p.soulSection),
      toolset: union(before.toolset, p.toolset),
      ...(addsPlugins ? { plugins: union(before.plugins ?? [], p.plugins ?? []) } : {}),
      ...(p.fsReach
        ? {
            fs_reach: {
              read: union(
                before.read.length > 0 ? before.read : DEFAULT_REACH.read,
                p.fsReach.read ?? [],
              ),
              write: union(
                before.write.length > 0 ? before.write : DEFAULT_REACH.write,
                p.fsReach.write ?? [],
              ),
            },
          }
        : {}),
    });
    return {
      what: `recipe section on '${personalityId}'`,
      href: `/p/${personalityId}/identity`,
      run: async () => {
        await this.opts.personalities.update(personalityId, {
          soulMd: before.soulMd,
          toolset: before.toolset,
          // An undeclared list is written back as `[]` — default-deny, the
          // same meaning the loader gives an absent one.
          ...(addsPlugins ? { plugins: before.plugins ?? [] } : {}),
          fs_reach: { read: before.read, write: before.write },
        });
      },
    };
  }

  /**
   * Write each answered credential onto the personality's tool settings, and
   * return the compensating restores for the apply's LIFO undo log.
   *
   * Picking a key is only half the answer. `web_search` resolves
   * `providers/<provider>/<name>` from THIS binding and falls back to
   * `providers/<provider>/apiKey` without one, so a key the user stored as
   * `work` is invisible to the agent until the binding exists. Skipping the
   * write would ship an agent that finds nothing and says nothing about why.
   *
   * The binding is a REFERENCE — a provider and a name. No value passes through
   * here; the value was written by `namedSecrets.create` and is read only by
   * the tool at run time.
   */
  private async bindSecrets(
    bundle: RecipeBundle,
    personalityId: string,
    bindings: Record<string, RecipeSecretBinding> | undefined,
  ): Promise<Array<{ what: string; href: string; run: () => Promise<void> }>> {
    const undo: Array<{ what: string; href: string; run: () => Promise<void> }> = [];
    if (!bindings) return undo;

    for (const secret of bundle.requires.secrets ?? []) {
      const binding = bindings[secret.toolName];
      if (!binding) continue;
      const schema = this.secretSchemaFor(secret.toolName);
      // Unreachable — preflight refused above unless the binding matched an
      // existing key under a provider this schema offers. Kept as a refusal
      // rather than a silent skip: a binding that is not written is the failure
      // mode this whole stage exists to close.
      if (!schema || !this.opts.toolSettings) {
        throw new EthosError({
          code: 'RECIPE_BLOCKED',
          cause: `This deployment cannot record which key '${secret.toolName}' should use.`,
          action: `Install without choosing a key, then set it on ${personalityId}'s Tools tab.`,
        });
      }
      // Read first, write merged: `setForPersonality` takes the WHOLE values
      // map, and the same read is what the undo entry restores.
      const before = await this.opts.toolSettings.getForPersonality(personalityId);
      const restore = before.values;
      await this.opts.toolSettings.setForPersonality(personalityId, {
        ...restore,
        [secret.toolName]: {
          ...restore[secret.toolName],
          [schema.providerKey]: binding.provider,
          [schema.secretKey]: binding.secret,
        },
      });
      undo.push({
        what: `${secret.toolName} key binding on '${personalityId}'`,
        href: `/p/${personalityId}`,
        run: async () => {
          await this.opts.toolSettings?.setForPersonality(personalityId, restore);
        },
      });
    }
    return undo;
  }

  // -------------------------------------------------------------------------
  // The snapshot — every fact preflight reads, gathered from the real world
  // -------------------------------------------------------------------------

  private async snapshot(
    bundle: RecipeBundle,
    /** Undefined for an attach with no target picked yet: nothing personality-scoped to gather. */
    personalityId: string | undefined,
    values: Record<string, string>,
  ): Promise<RecipeWorldSnapshot> {
    const [
      personalities,
      mcpServers,
      plugins,
      cronJobNames,
      deliveryTargets,
      gatewayRunning,
      secretStatus,
    ] = await Promise.all([
      personalityId ? this.candidatePersonality(personalityId) : [],
      this.opts.mcp.list().then((r) => r.servers.map((s) => s.name)),
      this.loadedPlugins(),
      personalityId ? this.personalityCronJobNames(personalityId) : [],
      personalityId ? this.opts.cron.deliveryTargets(personalityId).then((r) => r.targets) : [],
      this.gatewayRunning(),
      this.secretStatus(bundle),
    ]);

    return {
      personalities,
      availableTools: (this.opts.toolRegistry?.getAvailable() ?? []).map((t) => t.name),
      mcpServers,
      mcpCatalogIds: catalogPresetIds(this.opts.mcp.catalog()),
      plugins,
      hostBinaries: (bundle.requires.hostBinaries ?? [])
        .map((b) => b.name)
        .filter((name) => onPath(name)),
      cronJobNames,
      deliveryTargets,
      gatewayRunning,
      secretStatus,
      inlineSetupPlatforms: [...(this.opts.channelSetup?.platforms ?? [])],
      nextRunBySchedule: this.nextRuns(bundle, values),
    };
  }

  /**
   * Preflight consults exactly ONE entry — the id the recipe would write — so
   * reading every personality's SOUL.md to fill an array nothing looks at would
   * be waste. The id in question is the only one gathered.
   */
  private async candidatePersonality(id: string): Promise<RecipeWorldSnapshot['personalities']> {
    if (!(await this.opts.personalities.exists(id))) return [];
    const { personality, soulMd } = await this.opts.personalities.get(id);
    return [{ id, soulMd, toolset: personality.toolset ?? [], builtin: personality.builtin }];
  }

  /** Every personality's SOUL.md — what `list` derives an attach recipe's installed state from. */
  private async personalitySouls(): Promise<Array<{ id: string; soulMd: string }>> {
    const { items } = await this.opts.personalities.list();
    return Promise.all(
      items.map(async ({ id }) => ({ id, soulMd: (await this.opts.personalities.get(id)).soulMd })),
    );
  }

  /** Loaded only (D4). `scanFindings` travel verbatim — never summarised. */
  private async loadedPlugins(): Promise<RecipeWorldSnapshot['plugins']> {
    if (!this.opts.plugins) return [];
    const { plugins } = await this.opts.plugins.list();
    // `status: null` means this process never tried to activate the plugin —
    // it is on disk, nothing more is known (the loader is optional wiring).
    // Refusing on "unknown" would block every deployment with no loader wired,
    // so only a plugin that actually FAILED to load counts as absent.
    return plugins
      .filter((p) => p.status !== 'failed')
      .map((p) => ({
        id: p.id,
        ...(p.scanFindings && p.scanFindings.length > 0
          ? { safetyFindings: p.scanFindings.map((f) => `${f.rule}: ${f.message}`) }
          : {}),
      }));
  }

  /**
   * Which credential a `requires.secrets` entry accepts, and whether one is
   * already there.
   *
   * The provider roster comes from the TOOL — `web_search` publishes Exa /
   * Tavily / Brave in its own `settingsSchema`, which the personality tool-
   * settings UI already renders from — so the recipe layer holds no provider
   * list to go stale. Each provider is matched to a key-store row through the
   * `providers/<id>/…` ref convention the tool itself resolves against
   * (`extensions/tools-web/src/index.ts`), not through an id spelling this file
   * would have to guess.
   *
   * WHY `keys.list` READS AND `namedSecrets` WRITES. The row is the right
   * question: `keys.list` unions the vault with the env recognition table
   * (`MergedSecretsResolver`), so `EXA_API_KEY` counts, and the ref it reports
   * is `providers/<id>/apiKey` — exactly the one `web_search` falls back to
   * when no personality binding names another. It is also the only read that
   * sees the WHOLE vault: a key the user stored as `providers/exa/work`
   * surfaces under `custom`, which is what lets the page offer it for
   * selection. But `KeysService.set` REFUSES the catalog rows: they are
   * `reflectsNamedSecret`, owned by the named-secrets vault. So the page writes
   * a new key through `namedSecrets.create`, and only providers that vault
   * accepts are offered — an option the page could not act on is not an option.
   *
   * An entry is omitted (not "unsatisfied") whenever the deployment cannot
   * answer — no key store wired, the tool absent, or no provider/secret-binding
   * field on it. Preflight turns an omission into a warning, because a row the
   * page has no way to clear is the D14 bug in a different costume.
   *
   * Reads masked previews only: `keys.list` returns `set` and a redacted
   * preview, never a value, and only the NAME half of a ref is carried out.
   */
  private async secretStatus(bundle: RecipeBundle): Promise<RecipeWorldSnapshot['secretStatus']> {
    const required = bundle.requires.secrets ?? [];
    if (required.length === 0 || !this.opts.keys) return {};

    const { categories } = await this.opts.keys.list();
    const rows = categories.flatMap((c) =>
      c.entries.flatMap((e) => e.fields.map((f) => ({ e, f }))),
    );

    const status: NonNullable<RecipeWorldSnapshot['secretStatus']> = {};
    for (const secret of required) {
      const schema = this.secretSchemaFor(secret.toolName);
      if (!schema) continue;
      const options: RecipeSecretOption[] = [];
      const existing: RecipeSecretRef[] = [];
      for (const provider of schema.providers) {
        const prefix = `providers/${provider.id}/`;
        const under = rows.filter((row) => row.f.ref.startsWith(prefix));
        // Flat `<name>` only — `namedSecrets.create` rejects a name with a
        // slash, so a nested ref is not something the page could write.
        const names = under
          .map((row) => ({ row, name: row.f.ref.slice(prefix.length) }))
          .filter((r) => r.name.length > 0 && !r.name.includes('/'));
        // The tool's fallback ref is the one the CATALOG claims for this
        // provider (`providers/<id>/apiKey`); `keys.list` emits it set or
        // unset. Anything else under the prefix is a user-named key and
        // surfaces under `custom`, so it is never mistaken for the fallback.
        const fallback = names.find((r) => r.row.e.category !== 'custom') ?? names[0];
        if (!fallback) continue;
        options.push({
          provider: provider.id,
          label: provider.label,
          defaultSecretName: fallback.name,
          ...(fallback.row.e.getKeyUrl ? { getKeyUrl: fallback.row.e.getKeyUrl } : {}),
        });
        for (const { row, name } of names) {
          if (row.f.set) existing.push({ provider: provider.id, name });
        }
      }
      if (options.length > 0) {
        status[secret.toolName] = { secretKind: schema.secretKind, options, existing };
      }
    }
    return status;
  }

  /**
   * The tool's own contract for a credential requirement: which providers it
   * offers, which settings keys a binding is written under, and the category of
   * named secret it accepts. Read off `settingsSchema` — the same declaration
   * the personality tool-settings form renders — so the recipe layer holds no
   * provider list and no field names to go stale.
   *
   * `undefined` when the tool is absent or declares no such pair: with no way
   * to write a binding there is nothing the page could do, and preflight is
   * better off saying it could not check.
   */
  private secretSchemaFor(toolName: string): ToolSecretSchema | undefined {
    const tool = this.opts.toolRegistry?.getAvailable().find((t) => t.name === toolName);
    const fields = tool?.settingsSchema?.fields ?? [];
    const enumField = fields.find((f) => f.kind === 'enum');
    const bindingField = fields.find((f) => f.kind === 'secret-binding');
    // The `kind` re-tests are what narrow the union — `find` returns
    // `ToolSettingsField | undefined`, not the arm the predicate matched.
    if (enumField?.kind !== 'enum') return undefined;
    if (bindingField?.kind !== 'secret-binding') return undefined;
    const providers: Array<{ id: string; label: string }> = [];
    for (const option of enumField.options) {
      // Only providers the named-secrets vault can store a key for: a provider
      // the page cannot write is not one it can offer.
      const writable = NamedSecretProviderSchema.safeParse(option.value);
      if (writable.success)
        providers.push({ id: writable.data, label: option.label ?? option.value });
    }
    if (providers.length === 0) return undefined;
    return {
      providers,
      providerKey: enumField.key,
      secretKey: bindingField.key,
      secretKind: bindingField.secretKind,
    };
  }

  private async personalityCronJobNames(personalityId: string): Promise<string[]> {
    const { jobs } = await this.opts.cron.list();
    return jobs.filter((j) => j.personalityId === personalityId).map((j) => j.name);
  }

  /** The same heartbeat file `/healthz` reads, with the same staleness window. */
  private async gatewayRunning(): Promise<boolean> {
    try {
      const raw = await this.opts.storage.read(join(this.opts.dataDir, 'gateway-health.json'));
      if (!raw) return false;
      const parsed: unknown = JSON.parse(raw);
      const updatedAt =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { updatedAt?: unknown }).updatedAt
          : undefined;
      if (typeof updatedAt !== 'string') return false;
      const age = Date.now() - new Date(updatedAt).getTime();
      return Number.isFinite(age) && age <= GATEWAY_HEARTBEAT_STALE_MS;
    } catch {
      // Missing or unparseable — the gateway is not running.
      return false;
    }
  }

  /**
   * Keyed by the RESOLVED expression, because that is what preflight looks up:
   * the schedule is templated FIRST, then its next fire time is computed.
   */
  private nextRuns(bundle: RecipeBundle, values: Record<string, string>): Record<string, string> {
    const after = this.opts.now?.() ?? new Date();
    const out: Record<string, string> = {};
    for (const job of bundle.cronJobs) {
      const schedule = resolvedSchedule(job, values);
      if (schedule === null || out[schedule]) continue;
      const next = nextRunForSchedule(schedule, after);
      if (next) out[schedule] = next.toISOString();
    }
    return out;
  }

  /**
   * Stage 3 — the preview IS the character sheet (D5). Rendered from the
   * proposed config, with any still-unfilled `{{input.*}}` left standing so the
   * user sees what is missing rather than a wrong value.
   */
  private async previewSheet(
    bundle: RecipeBundle,
    personalityId: string | undefined,
    snapshot: RecipeWorldSnapshot,
    values: Record<string, string>,
  ): Promise<string> {
    const p = bundle.personality;
    if (p.mode === 'attach') {
      // The TARGET's own config with the additions applied — the sheet the
      // install would leave behind. Until a target is picked (or when the one
      // named does not exist) there is nothing to draw it from.
      const target = snapshot.personalities.find((entry) => entry.id === personalityId);
      if (!personalityId || !target) {
        return 'Pick the personality this recipe attaches to, and its character sheet appears here with the additions applied.';
      }
      const config = await this.opts.personalities.config(personalityId);
      const union = (base: readonly string[], extra: readonly string[]) => [
        ...base,
        ...extra.filter((entry) => !base.includes(entry)),
      ];
      const read = p.fsReach?.read?.map((v) => renderTemplatePreview(v, values)) ?? [];
      const write = p.fsReach?.write?.map((v) => renderTemplatePreview(v, values)) ?? [];
      const merged: PersonalityConfig = {
        ...config,
        toolset: union(config.toolset ?? [], p.toolset),
        ...(p.plugins && p.plugins.length > 0
          ? { plugins: union(config.plugins ?? [], p.plugins) }
          : {}),
        ...(p.fsReach
          ? {
              fs_reach: {
                ...config.fs_reach,
                read: union(config.fs_reach?.read ?? DEFAULT_REACH.read, read),
                write: union(config.fs_reach?.write ?? DEFAULT_REACH.write, write),
              },
            }
          : {}),
      };
      return renderCharacterSheet(
        merged,
        appendRecipeSoulSection(
          target.soulMd,
          bundle.id,
          renderTemplatePreview(p.soulSection, values),
        ),
      );
    }
    const config: PersonalityConfig = {
      id: personalityId ?? p.id,
      name: p.name,
      description: p.description,
      toolset: p.toolset,
      ...(p.capabilities ? { capabilities: p.capabilities } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.provider ? { provider: p.provider } : {}),
      ...(p.mcpServers ? { mcp_servers: p.mcpServers } : {}),
      ...(p.plugins ? { plugins: p.plugins } : {}),
      // The sheet's `## Boundary` section reads `safety.network`, so the preview
      // shows the reach the install will actually write — including the D15
      // default, which is the whole difference between an agent that can read a
      // weather API and one that cannot.
      safety: p.safety ?? defaultRecipeSafety(),
      ...(p.fsReach
        ? {
            fs_reach: {
              ...(p.fsReach.read
                ? { read: p.fsReach.read.map((v) => renderTemplatePreview(v, values)) }
                : {}),
              ...(p.fsReach.write
                ? { write: p.fsReach.write.map((v) => renderTemplatePreview(v, values)) }
                : {}),
              ...(p.fsReach.workdir
                ? {
                    workdir:
                      typeof p.fsReach.workdir === 'string'
                        ? renderTemplatePreview(p.fsReach.workdir, values)
                        : p.fsReach.workdir.map((v) => renderTemplatePreview(v, values)),
                  }
                : {}),
            },
          }
        : {}),
    };
    return renderCharacterSheet(config, renderTemplatePreview(p.soulMd, values));
  }

  private async attachedServers(personalityId: string): Promise<string[]> {
    const { personality } = await this.opts.personalities.get(personalityId);
    return personality.mcp_servers ?? [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A verified channel setup, carried from `install`'s read-only checks into
 * `apply`. The token rides along because `addBot` needs it — and it is read
 * exactly there, never logged and never returned.
 */
interface ApplyChannelSetup {
  world: ChannelSetupWorld;
  setup: RecipeChannelSetup;
  /** `@botname` from the live probe. The only thing about the token that surfaces. */
  botLabel: string | null;
  /** False on a 409: the gateway owns the token and already knows this chat. */
  record: boolean;
}

/**
 * A tool's credential contract, read off its own `settingsSchema`. The field
 * KEYS travel with it because the install writes the binding back through
 * `toolSettings.setForPersonality`, whose values map is keyed by them — the
 * recipe layer spells neither `provider` nor `secret`.
 */
interface ToolSecretSchema {
  /** Providers the tool offers that the named-secrets vault can store. */
  providers: Array<{ id: string; label: string }>;
  /** `settingsSchema` key the chosen provider is written under. */
  providerKey: string;
  /** `settingsSchema` key the chosen secret NAME is written under. */
  secretKey: string;
  /** Category of named secret the picker filters the vault by. */
  secretKind: string;
}

/**
 * The personality the install would write. Create mode: the bundle's own id
 * unless overridden. Attach mode: the override IS the target, and there is no
 * fallback — `undefined` until the user picks one.
 */
function targetPersonalityId(
  bundle: RecipeBundle,
  override: string | undefined,
): string | undefined {
  return bundle.personality.mode === 'create' ? (override ?? bundle.personality.id) : override;
}

/**
 * The token-form reach a personality that declares none resolves to — the
 * same lists `deriveFsReachPaths` (core) derives, spelled with the config
 * tokens the loader substitutes. Seeded into an attach's `fs_reach` when the
 * target declares no list, because a written list REPLACES the defaults.
 */
const DEFAULT_REACH = {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution tokens
  read: ['${ETHOS_HOME}/personalities/${self}/', '${ETHOS_HOME}/skills/', '${CWD}'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution tokens
  write: ['${ETHOS_HOME}/personalities/${self}/', '${CWD}'],
} as const;

/** Stage 1. A bundle that fails to parse in production is an authoring bug the
 *  table test should have caught; the RPC still refuses rather than installing
 *  a partial object. */
function resolveBundle(id: string): RecipeBundle {
  const found = RECIPES.find((r) => r.id === id);
  if (!found) {
    throw new EthosError({
      code: 'RECIPE_NOT_FOUND',
      cause: `No recipe with the id '${id}' is shipped.`,
      action: 'Call recipes.list to see the catalog.',
    });
  }
  const parsed = RecipeBundleSchema.safeParse(found);
  if (!parsed.success) {
    throw new EthosError({
      code: 'RECIPE_INVALID',
      cause: `The '${id}' recipe bundle is malformed: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      action: 'Report this — a shipped bundle failed its own schema.',
    });
  }
  return parsed.data;
}

/**
 * The bundle PROJECTED to the view an install runs as. `resolveInstallMode`
 * decides: a single-mode bundle ignores the request, a `both` bundle takes it
 * and defaults to create. Preflight and install consume this; `get` shows the
 * whole bundle.
 */
function resolveProjected(id: string, installMode: RecipeInstallMode | undefined): RecipeBundle {
  const bundle = resolveBundle(id);
  return projectBundle(bundle, resolveInstallMode(bundle, installMode));
}

function catalogPresetIds(catalog: {
  remote: Array<{ name: string }>;
  local: Array<{ name: string }>;
}): string[] {
  return [...catalog.remote.map((p) => p.name), ...catalog.local.map((p) => p.name)];
}

/**
 * A `kind: 'path'` input that the personality loader would refuse.
 *
 * A path input lands in `fs_reach`, and the loader accepts only absolute paths
 * (or its `${ETHOS_HOME}` / `${self}` / `${CWD}` tokens) with no `..`.
 * `PersonalitiesService.create` does not validate reach entries, so without
 * this the install would write a config.yaml the registry then refuses to
 * load. Caught here as a preflight row, before the first write, with the fix
 * named. `~` is not expanded anywhere downstream, so it is refused too.
 */
function pathInputBlockers(
  bundle: RecipeBundle,
  values: Record<string, string>,
): PreflightBlocker[] {
  const blockers: PreflightBlocker[] = [];
  for (const input of bundle.requires.inputs) {
    if (input.kind !== 'path') continue;
    const value = values[input.key];
    if (value === undefined) continue;
    if (value.startsWith('/') && !value.includes('..') && value !== '/') continue;
    blockers.push({
      code: 'PATH_NOT_ABSOLUTE',
      message: `'${input.label}' must be an absolute path: "${value}" is not.`,
      action: `Enter the full path starting with "/" (no ~ and no ..), e.g. ${input.placeholder ?? '/Users/you/folder/'}.`,
    });
  }
  return blockers;
}

/** The resolved cron expression, or `null` while an input it needs is empty. */
function resolvedSchedule(job: RecipeCronJob, values: Record<string, string>): string | null {
  if (unresolvedPlaceholders(job.schedule, values).length > 0) return null;
  return renderTemplatePreview(job.schedule, values);
}

/** Which `deliverTo` arm a job asked for, resolved against the picked target. */
function originFor(job: RecipeCronJob, deliverTo: CronDeliverTo | undefined): CronDeliverTo {
  if (job.deliverTo === 'inApp') return { kind: 'inApp' };
  if (job.deliverTo === 'none') return { kind: 'none' };
  // Guaranteed by the `install` guard above; the scheduler would otherwise get
  // a file-only job the user believes is going to their phone.
  if (deliverTo?.kind !== 'channel') {
    throw new EthosError({
      code: 'RECIPE_BLOCKED',
      cause: `The '${job.name}' job delivers to a chat, but no chat was chosen.`,
      action: 'Pick a delivery target and install again.',
    });
  }
  return deliverTo;
}

/** Preserve a service's own refusal — `CRON_TARGET_NOT_ALLOWED` above all. */
function toFailure(err: unknown): RecipeInstallReport['failure'] {
  if (err instanceof EthosError) {
    return { code: err.code, message: err.cause, action: err.action };
  }
  return {
    code: 'INTERNAL',
    message: err instanceof Error ? err.message : String(err),
    action: 'Check the server logs, then install again.',
  };
}

/**
 * PATH-walking binary check, the same shape `@ethosagent/skills`' `hasBinary`
 * uses (its copy is private). Not a `~/.ethos/` operation, so it does not go
 * through `Storage`; spawning `which` per binary on a debounced preflight would
 * be worse.
 */
function onPath(name: string): boolean {
  const path = process.env.PATH ?? '';
  if (!path) return false;
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
      : [''];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        if (statSync(join(dir, name + ext)).isFile()) return true;
      } catch {
        // not present — try the next candidate
      }
    }
  }
  return false;
}

function toWire(bundle: RecipeBundle): RecipeBundleWire {
  return bundle;
}
