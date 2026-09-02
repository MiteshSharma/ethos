// Config live-reload foundation — plan/phases/gateway-live-reload.md Phase 0.
//
// WHAT THIS IS. `loadAndDiffConfig` re-reads `~/.ethos/config.yaml` through
// the SAME strict loader `boot.ts` boots from, and diffs it field-by-field
// against the last-applied snapshot. It mutates NOTHING — Phase 0 ships the
// differ and the honest log line, and nothing else. The reconcilers that act
// on `diff.bots` / `diff.channelFilter` / `diff.webhooks` are Phases A–C.
//
// WHY IT IS STILL WORTH SHIPPING ALONE (plan §4). Today an operator who edits
// `config.yaml` under a running `ethos boot` gets silence: the edit neither
// applies nor says it did not. Every §0 row 7-10 case — model, provider,
// storage backend, listening port, cron schedule — becomes a named warning
// instead of invisible staleness.
//
// NOT `fs.watch`, NOT `chokidar` (plan §1, §6). Neither exists anywhere in
// this codebase; the personality registry already proves poll-on-a-known-seam
// beats an event listener racing a half-written YAML file. The caller polls.

import { deriveBotKey, type EthosConfig, loadConfigStrict } from '@ethosagent/config';
import type {
  ClarifyResponse,
  InboundMessage,
  Logger,
  PlatformAdapter,
  SecretsResolver,
  Storage,
} from '@ethosagent/types';
import {
  buildPlatformWebhookMounts,
  discordBotKey,
  emailBotKey,
  type PlatformWebhookMounts,
  whatsAppBotKey,
} from './commands/gateway';
import { hasFlag, resolveWebHost, resolveWebPort } from './commands/serve-helpers';

/**
 * A configured bot's identity, as `${platform}:${botKey}`.
 *
 * DEVIATION from the plan's illustrative `bots: { added: BotConfig[] }`: there
 * is no single `BotConfig` type in this codebase. A bot is a `TelegramBotConfig`,
 * a `SlackAppConfig`, a `WhatsAppConfig`, or one of the two legacy scalar
 * shapes (`discordToken`, the `email*` field group) — five unrelated types. The
 * diff therefore carries IDENTITIES, not entries, and the caller reads the
 * entry out of the `config` returned alongside the diff. That is strictly less
 * machinery and loses nothing: the two are always returned together.
 *
 * The key halves come from the same derivations the gateway wiring uses
 * (`deriveBotKey`, `whatsAppBotKey`, `discordBotKey`, `emailBotKey`), so a key
 * here names the same bot the runtime routes by.
 */
export type ConfigBotId = string;

export interface ConfigSectionDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface ConfigDiff {
  /** Channel bots, keyed by {@link ConfigBotId}. §0 row 2 — Phase A. */
  bots: ConfigSectionDiff;
  /**
   * `channel_filter`, diffed as a whole object (plan §1 — small enough not to
   * need field-level diffing). §0 rows 3-4 — Phase B.
   *
   * DEVIATION: the plan writes `ChannelFilterConfig | null`, which cannot
   * distinguish "unchanged" from "changed to absent" — both would be `null`.
   * One level of wrapping fixes that: `null` means unchanged, and a non-null
   * `{ next }` carries the new value (`undefined` when the block was removed).
   */
  channelFilter: { next: EthosConfig['channelFilter'] } | null;
  /** `webhooks`, keyed by hookId. §0 row 5 — Phase C. */
  webhooks: ConfigSectionDiff;
  /**
   * `web.port` / `web.host` — the config half of §0 row 9, Phase D. `null`
   * means unchanged; non-null carries the new raw config values.
   *
   * Raw, not resolved: a CLI flag or `ETHOS_WEB_*` env var outranks
   * `config.yaml` (see `resolveWebPort` / `resolveWebHost`), so whether this
   * change moves the LIVE bind is a question only the caller — which holds
   * `argv` and `process.env` — can answer. {@link planWebRebind} is that
   * answer.
   */
  web: { next: { port?: number; host?: string } } | null;
  /**
   * Top-level keys that changed but have no live reconciler. Every entry here
   * has already been warned about through the injected logger by the time the
   * diff is returned — see {@link UNSUPPORTED_KEYS}.
   */
  unsupported: string[];
}

/**
 * The keys with no live reconciler, and the exact warning each one emits.
 * Covers plan §0 rows 7-8 (model/provider, storage backend) and row 10
 * (idleWatcher + every cron schedule toggle, which §4 leaves explicitly
 * unassigned to a phase — until it is assigned, "restart required" is the
 * honest answer).
 *
 * `web.port` / `web.host` USED TO BE HERE and are not any more: Phase D
 * rebinds that one server live (see {@link planWebRebind} /
 * {@link rebindWebServer}), so "restart required to apply" would now be a lie.
 *
 * The other listening ports (ACP 3001, health 3002, webhook 3003, platform
 * webhook 3006) are env vars and a CLI flag, not config keys, so a config diff
 * can never see them change and Phase D cannot reach them. `web.port` /
 * `web.host` are the only two this file can observe.
 */
const UNSUPPORTED_KEYS: ReadonlyArray<{
  key: string;
  read: (c: EthosConfig) => unknown;
  warning: string;
}> = [
  { key: 'model', read: (c) => c.model, warning: 'model changed — restart required to apply' },
  {
    key: 'provider',
    read: (c) => c.provider,
    warning: 'provider changed — restart required to apply',
  },
  {
    key: 'storage',
    read: (c) => c.storage,
    warning: 'storage backend changed — restart required to apply',
  },
  {
    key: 'memory',
    read: (c) => c.memory,
    warning: 'memory backend changed — restart required to apply',
  },
  {
    key: 'idleWatcher',
    read: (c) => c.idleWatcher,
    warning: 'idleWatcher config changed — restart required to apply',
  },
  {
    key: 'cron',
    read: (c) => c.cron,
    warning: 'cron trigger/arming config changed — restart required to apply',
  },
  {
    key: 'nightlyPass',
    read: (c) => c.nightlyPass,
    warning: 'nightlyPass schedule changed — restart required to apply',
  },
  {
    key: 'weeklyDigest',
    read: (c) => c.weeklyDigest,
    warning: 'weeklyDigest schedule changed — restart required to apply',
  },
  {
    key: 'evolverCronEnabled',
    read: (c) => c.evolverCronEnabled,
    warning: 'evolverCronEnabled changed — restart required to apply',
  },
  {
    key: 'evolverSchedule',
    read: (c) => c.evolverSchedule,
    warning: 'evolverSchedule changed — restart required to apply',
  },
];

/**
 * Order-independent structural fingerprint. `JSON.stringify` with a
 * key-sorting replacer, so two configs that parsed the same fields in a
 * different order compare equal instead of reporting a phantom change.
 */
function fingerprint(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
          )
        : v,
    ) ?? 'undefined'
  );
}

/** Every configured bot, as identity → fingerprint of its config entry. */
function enumerateBots(config: EthosConfig): Map<ConfigBotId, string> {
  const out = new Map<ConfigBotId, string>();
  for (const bot of config.telegram?.bots ?? []) {
    out.set(`telegram:${deriveBotKey(bot)}`, fingerprint(bot));
  }
  for (const app of config.slack?.apps ?? []) {
    out.set(`slack:${deriveBotKey(app)}`, fingerprint(app));
  }
  for (const wa of config.whatsapp ?? []) {
    out.set(`whatsapp:${whatsAppBotKey(wa)}`, fingerprint(wa));
  }
  // Legacy scalar shapes. Both derive their botKey from a credential, so a
  // credential edit surfaces as removed + added — which is right: it is a
  // different bot, not the same bot reconfigured.
  if (config.discordToken) {
    out.set(`discord:${discordBotKey(config.discordToken)}`, fingerprint(config.discordToken));
  }
  if (config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost) {
    out.set(
      `email:${emailBotKey(config.emailUser, config.emailImapHost)}`,
      fingerprint({
        imapHost: config.emailImapHost,
        imapPort: config.emailImapPort,
        user: config.emailUser,
        password: config.emailPassword,
        smtpHost: config.emailSmtpHost,
        smtpPort: config.emailSmtpPort,
      }),
    );
  }
  return out;
}

/** Every webhook route, as hookId → fingerprint of its config entry. */
function enumerateWebhooks(config: EthosConfig): Map<string, string> {
  return new Map(
    Object.entries(config.webhooks ?? {}).map(([hookId, hook]) => [hookId, fingerprint(hook)]),
  );
}

function diffKeyed(previous: Map<string, string>, next: Map<string, string>): ConfigSectionDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [key, fp] of next) {
    const before = previous.get(key);
    if (before === undefined) added.push(key);
    else if (before !== fp) changed.push(key);
  }
  for (const key of previous.keys()) if (!next.has(key)) removed.push(key);
  return { added, removed, changed };
}

function isEmptySection(section: ConfigSectionDiff): boolean {
  return section.added.length === 0 && section.removed.length === 0 && section.changed.length === 0;
}

function diffConfig(previous: EthosConfig, next: EthosConfig): ConfigDiff {
  const unsupported = UNSUPPORTED_KEYS.filter(
    (k) => fingerprint(k.read(previous)) !== fingerprint(k.read(next)),
  ).map((k) => k.key);
  const channelFilterChanged =
    fingerprint(previous.channelFilter) !== fingerprint(next.channelFilter);
  const webChanged = previous.web?.port !== next.web?.port || previous.web?.host !== next.web?.host;
  return {
    bots: diffKeyed(enumerateBots(previous), enumerateBots(next)),
    channelFilter: channelFilterChanged ? { next: next.channelFilter } : null,
    webhooks: diffKeyed(enumerateWebhooks(previous), enumerateWebhooks(next)),
    web: webChanged ? { next: { port: next.web?.port, host: next.web?.host } } : null,
    unsupported,
  };
}

/**
 * Re-read `~/.ethos/config.yaml` and diff it against the last-applied
 * snapshot.
 *
 * Returns `null` — and leaves the caller's snapshot untouched — whenever the
 * config cannot be loaded: absent, mid-write, a parse error, a plaintext
 * secret the strict loader refuses. A live process must never die on a
 * half-written editor save, and it must never adopt a partial config as its
 * new baseline.
 *
 * `previous === null` means "no baseline yet": the config is loaded and
 * returned with an empty diff, so the first call establishes the snapshot
 * without reporting every key as changed.
 *
 * DEVIATION from the plan's `loadAndDiffConfig(previous)` signature: the
 * strict loader needs a `Storage` and (optionally) a `SecretsResolver`, and
 * the "unsupported → log and skip" deliverable needs a `Logger`. All three are
 * injected rather than reached for, per the project's injection-at-
 * construction rule. Warnings are emitted HERE rather than by the caller so
 * there is no "did the caller remember to log?" footgun.
 */
export async function loadAndDiffConfig(
  previous: EthosConfig | null,
  deps: { storage: Storage; secrets?: SecretsResolver; logger: Logger },
): Promise<{ config: EthosConfig; diff: ConfigDiff } | null> {
  const { storage, secrets, logger } = deps;
  let loaded: Awaited<ReturnType<typeof loadConfigStrict>>;
  try {
    loaded = await loadConfigStrict(storage, secrets);
  } catch (err) {
    logger.warn('[config-reload] config.yaml could not be read — keeping the running config', {
      component: 'config-reload',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!loaded) return null;
  if (loaded.parseErrors.length > 0) {
    logger.warn('[config-reload] config.yaml has parse errors — keeping the running config', {
      component: 'config-reload',
      errors: loaded.parseErrors.join('; '),
    });
    return null;
  }

  const config = loaded.config;
  const diff: ConfigDiff =
    previous === null
      ? {
          bots: emptySection(),
          channelFilter: null,
          webhooks: emptySection(),
          web: null,
          unsupported: [],
        }
      : diffConfig(previous, config);

  for (const entry of UNSUPPORTED_KEYS) {
    if (diff.unsupported.includes(entry.key)) {
      logger.warn(`[config-reload] ${entry.warning}`, {
        component: 'config-reload',
        key: entry.key,
      });
    }
  }

  // Supported sections with no reconciler yet. Debug, not warn: unlike the
  // unsupported keys these WILL apply live once their phase lands, so this is
  // a "not yet" note for whoever is watching the logs, not an operator alarm.
  if (!isEmptySection(diff.bots)) {
    // Reconciled by the caller (Phase A, `ethos boot`). Debug, not warn: this
    // is a "what changed" note for whoever is watching the logs — the
    // reconciler logs its own per-bot outcome, including a refusal.
    logger.debug('[config-reload] bots changed', {
      component: 'config-reload',
      ...diff.bots,
    });
  }
  if (diff.channelFilter !== null) {
    logger.debug('[config-reload] channel_filter changed — no reconciler wired yet (Phase B)', {
      component: 'config-reload',
    });
  }
  if (!isEmptySection(diff.webhooks)) {
    logger.debug('[config-reload] webhooks changed — no reconciler wired yet (Phase C)', {
      component: 'config-reload',
      ...diff.webhooks,
    });
  }
  if (diff.web !== null) {
    // Debug, not warn: the caller decides whether this moves the live bind
    // (CLI/env precedence) and logs the outcome by name either way.
    logger.debug('[config-reload] web bind config changed', {
      component: 'config-reload',
      port: diff.web.next.port,
      host: diff.web.next.host,
    });
  }

  return { config, diff };
}

function emptySection(): ConfigSectionDiff {
  return { added: [], removed: [], changed: [] };
}

// ---------------------------------------------------------------------------
// Phase A — what a `bots` diff may hot-apply
// ---------------------------------------------------------------------------
//
// These two are pure, and live here rather than inside `runBoot` so the
// refusal rule that keeps Phase A safe without Phase B is directly testable.

/**
 * A config holding exactly the one bot named by `${platform}:${botKey}`, so
 * the SAME builders the cold-boot path uses (`buildGatewayBots`,
 * `buildGatewayAdapters`) produce exactly one bot and one adapter. Nothing
 * re-implements adapter construction; a second construction path is how "the
 * hot-added bot behaves subtly differently" happens.
 *
 * Returns undefined when the identity names no entry in `source`.
 */
function clearBotBlocks(source: EthosConfig): EthosConfig {
  return {
    ...source,
    telegram: undefined,
    slack: undefined,
    whatsapp: undefined,
    discordToken: undefined,
    emailImapHost: undefined,
    emailUser: undefined,
    emailPassword: undefined,
    emailSmtpHost: undefined,
    // A `webhooks` entry is a first-class bot to `buildGatewayBots` too, so
    // clearing the block is what keeps a slice down to exactly one bot.
    webhooks: undefined,
  };
}

export function sliceConfigForBot(source: EthosConfig, id: string): EthosConfig | undefined {
  const colon = id.indexOf(':');
  if (colon <= 0) return undefined;
  const platform = id.slice(0, colon);
  const botKey = id.slice(colon + 1);
  const empty = clearBotBlocks(source);
  if (platform === 'telegram') {
    const bot = source.telegram?.bots.find((b) => deriveBotKey(b) === botKey);
    return bot ? { ...empty, telegram: { ...source.telegram, bots: [bot] } } : undefined;
  }
  if (platform === 'slack') {
    const app = source.slack?.apps.find((a) => deriveBotKey(a) === botKey);
    return app ? { ...empty, slack: { ...source.slack, apps: [app] } } : undefined;
  }
  if (platform === 'whatsapp') {
    const wa = source.whatsapp?.find((w) => whatsAppBotKey(w) === botKey);
    return wa ? { ...empty, whatsapp: [wa] } : undefined;
  }
  if (platform === 'discord') {
    const token = source.discordToken;
    return token && discordBotKey(token) === botKey ? { ...empty, discordToken: token } : undefined;
  }
  if (platform === 'email') {
    const { emailImapHost, emailUser, emailPassword, emailSmtpHost } = source;
    if (!emailImapHost || !emailUser || !emailPassword || !emailSmtpHost) return undefined;
    if (emailBotKey(emailUser, emailImapHost) !== botKey) return undefined;
    return { ...empty, emailImapHost, emailUser, emailPassword, emailSmtpHost };
  }
  return undefined;
}

/**
 * Why this bot may NOT be added to a running gateway, or `null` if it may.
 *
 * Phase A ships without Phase B (live `channel_filter`), and that is exactly
 * what bounds this rule.
 *
 * THE FILTER STATE THAT DECIDES IS THE INSTALLED ONE, NOT THE PARSED FILE.
 * `Gateway.channelFilter` is assigned once at construction and nothing
 * replaces it while the process runs — installing a filter live IS Phase B.
 * So an operator who adds a bot AND its `channel_filter.<platform>` block in
 * the same edit has written a filter that is not in force: accepting the bot
 * because the FILE now names one would put it live under access control that
 * was never installed, which is the whole reason the cold-boot gate is fatal.
 * `hasInstalledFilter` therefore asks the running gateway
 * (`Gateway.hasChannelFilterFor`), and an addition whose filter arrived in the
 * same edit is refused with a reason that says a restart is required.
 *
 * The cold-boot gate's `process.exit(1)` stays exactly as it is: right before
 * anything is live, wrong afterwards, where one misconfigured NEW bot must not
 * kill bots already running correctly. This refusal is that gate's runtime
 * half — per-bot and non-fatal.
 *
 * Webhook mode is NOT a refusal (Phase C). `addBotLive` runs
 * {@link startAndMountPlatformWebhook} for the hot-added adapter, which
 * preserves the start()-then-mount ordering per adapter rather than per boot,
 * so a `use_webhook` bot gets a live route instead of deliveries that 404.
 */
export function hotAddRefusalReason(
  source: EthosConfig,
  id: string,
  hasInstalledFilter: (platform: string) => boolean,
): string | null {
  const colon = id.indexOf(':');
  if (colon <= 0) return 'malformed bot identity';
  const platform = id.slice(0, colon);
  const slice = sliceConfigForBot(source, id);
  if (!slice) return 'no matching entry in the reloaded config';
  if (hasInstalledFilter(platform)) return null;
  return source.channelFilter?.[platform]
    ? `channel_filter.${platform} is in config.yaml but is NOT installed in the running gateway — a new channel_filter entry requires a restart to take effect, so this bot cannot go live yet`
    : `no channel_filter.${platform} entry — add one and restart; a new channel_filter entry cannot be installed live`;
}

// ---------------------------------------------------------------------------
// What is RUNNING, as opposed to what was last loaded
// ---------------------------------------------------------------------------
//
// The reconciler used to advance one whole-config `lastAppliedConfig` snapshot
// the moment the file parsed — before a single bot had been added. A build that
// failed, an adapter that refused to start, a route that could not mount was
// recorded as applied anyway; and because the poll's mtime gate skips an
// unchanged file, the process then stayed permanently out of step with
// `config.yaml` until someone edited it again or restarted.
//
// So membership is tracked per UNIT, and a unit is marked applied only once its
// own reconcile has returned. Anything that failed simply stays in the next
// {@link planReconcile} result and is retried on the following poll — which is
// also why {@link shouldReloadConfig} lets a pending unit through the mtime
// gate.

export interface AppliedConfigState {
  /** Bot identity → fingerprint of the config entry that is actually live. */
  bots: Map<ConfigBotId, string>;
  /** hookId → fingerprint of the webhook entry that is actually served. */
  webhooks: Map<string, string>;
  /**
   * `${kind}:${id}` → the one-unit config slice that unit is RUNNING.
   *
   * The rollback source, and the reason it is per unit rather than one
   * whole-file `previousConfig`. Version B parses and bot X fails to apply;
   * version C is then saved and X's replacement also fails. Rolling back from
   * "the previously parsed file" rebuilds X from B — a configuration that was
   * never live — while the ledger above still says A. Recorded here by
   * {@link markApplied} only after a unit's own reconcile returned, so the
   * ledger and the rollback source cannot diverge.
   */
  slices: Map<string, EthosConfig>;
}

/** The applied state of a process that has just cold-booted `config`. */
export function appliedStateOf(config: EthosConfig): AppliedConfigState {
  const applied: AppliedConfigState = {
    bots: enumerateBots(config),
    webhooks: enumerateWebhooks(config),
    slices: new Map(),
  };
  for (const id of applied.bots.keys()) recordSlice(applied, config, 'bot', id);
  for (const hookId of applied.webhooks.keys()) recordSlice(applied, config, 'webhook', hookId);
  return applied;
}

function recordSlice(
  applied: AppliedConfigState,
  source: EthosConfig,
  kind: 'bot' | 'webhook',
  id: string,
): void {
  const slice = kind === 'bot' ? sliceConfigForBot(source, id) : sliceConfigForWebhook(source, id);
  if (slice) applied.slices.set(`${kind}:${id}`, slice);
  else applied.slices.delete(`${kind}:${id}`);
}

/**
 * The configuration one unit is actually RUNNING — what a failed replacement
 * is rebuilt from. `undefined` when the unit is not live.
 *
 * A slice is a whole `EthosConfig` carrying exactly this one bot or route (see
 * {@link sliceConfigForBot}), so it feeds back into `prepareBotLive` /
 * `prepareWebhookLive` as an ordinary `source` with no second code path.
 */
export function appliedSliceFor(
  applied: AppliedConfigState,
  kind: 'bot' | 'webhook',
  id: string,
): EthosConfig | undefined {
  return applied.slices.get(`${kind}:${id}`);
}

/** What still has to happen for `next` to be the live configuration. */
export function planReconcile(
  applied: AppliedConfigState,
  next: EthosConfig,
): { bots: ConfigSectionDiff; webhooks: ConfigSectionDiff } {
  return {
    bots: diffKeyed(applied.bots, enumerateBots(next)),
    webhooks: diffKeyed(applied.webhooks, enumerateWebhooks(next)),
  };
}

/**
 * Record that `id` is now live at the version `source` describes — fingerprint
 * AND the slice it is running, together, so a later rollback rebuilds THIS
 * version rather than whatever the file happened to say last.
 */
export function markApplied(
  applied: AppliedConfigState,
  source: EthosConfig,
  kind: 'bot' | 'webhook',
  id: string,
): void {
  const map = kind === 'bot' ? applied.bots : applied.webhooks;
  const fingerprints = kind === 'bot' ? enumerateBots(source) : enumerateWebhooks(source);
  const fp = fingerprints.get(id);
  if (fp === undefined) map.delete(id);
  else map.set(id, fp);
  recordSlice(applied, source, kind, id);
}

/** Record that `id` is no longer live. */
export function markRetired(
  applied: AppliedConfigState,
  kind: 'bot' | 'webhook',
  id: string,
): void {
  (kind === 'bot' ? applied.bots : applied.webhooks).delete(id);
  applied.slices.delete(`${kind}:${id}`);
}

/** True while any unit of `next` has not been applied — i.e. a retry is owed. */
export function reconcilePending(applied: AppliedConfigState, next: EthosConfig): boolean {
  const plan = planReconcile(applied, next);
  return !isEmptySection(plan.bots) || !isEmptySection(plan.webhooks);
}

/**
 * Whether this poll should run a reconcile at all.
 *
 * The mtime gate exists because `loadConfigStrict` resolves every
 * `${secrets:ref}` in the file — a network call per reference for an AWS-backed
 * resolver — so re-parsing an unchanged file every tick is pure waste. But a
 * unit that failed to apply is owed a retry that no file edit is going to
 * trigger, so `pending` outranks the gate. An unknown mtime is not a gate at
 * all: it cannot prove the file is unchanged.
 */
export function shouldReloadConfig(opts: {
  mtimeMs: number | null;
  lastMtimeMs: number | null;
  pending: boolean;
}): boolean {
  if (opts.pending) return true;
  if (opts.mtimeMs === null) return true;
  return opts.mtimeMs !== opts.lastMtimeMs;
}

// ---------------------------------------------------------------------------
// Transactional hot-add, and the retire-only-after-the-replacement-is-built swap
// ---------------------------------------------------------------------------

/**
 * The four steps a hot-add is made of, plus the two undos.
 *
 * Split this way because the ORDER and the ROLLBACK are the contract, and they
 * are what {@link commitHotAdd} owns; what each step actually does (gateway
 * routing table, notification routers, `adapter.start()`, webhook mount) is the
 * caller's business and is not importable under vitest.
 */
export interface HotAddSteps {
  /** Put the bot (and its adapter, if it has one) in the routing table. */
  register(): void;
  /** App-level registrations. Returns the undo for exactly what it did. */
  wire(): Promise<() => Promise<void>>;
  /** Start the adapter and mount its native webhook route. */
  start(): Promise<void>;
  /** Undo `start`'s mounts. Must tolerate never having been mounted. */
  unmount(): void;
  /** Undo `register` — deregister the bot and stop its adapter. */
  deregister(): Promise<void>;
  /** A rollback step that itself failed. Never swallowed silently. */
  onRollbackError(err: unknown): void;
}

/**
 * Register, wire and start one bot as a transaction: either the bot is fully
 * live when this resolves, or NOTHING of it is registered when it throws.
 *
 * The previous shape mutated the gateway first and only logged if the start
 * failed, which left a bot — and sometimes an adapter — registered but
 * unusable, with no teardown handle. The next reconcile then hit the
 * duplicate-botKey guard instead of repairing the state, so a transient start
 * failure was permanent.
 *
 * Rollback runs in reverse order and each step is guarded on its own: a failing
 * undo is reported through `onRollbackError` and does not stop the remaining
 * undos, and the ORIGINAL error is what propagates — it is the one that says
 * why the bot is not running.
 *
 * Returns `wire`'s undo, for the caller to hold against a later removal.
 * Deliberately NOT a composed "undo everything" teardown: a swap registers the
 * replacement under the same botKey before the retiring instance's wiring is
 * torn down, and a composed teardown run at that moment would deregister the
 * bot that had just taken its place. The transport half is retired by the
 * caller's own retire path, which is the only one that knows which instance is
 * current.
 */
export async function commitHotAdd(steps: HotAddSteps): Promise<() => Promise<void>> {
  steps.register();
  let undoWiring: (() => Promise<void>) | undefined;
  try {
    undoWiring = await steps.wire();
    await steps.start();
  } catch (err) {
    try {
      steps.unmount();
    } catch (rollbackErr) {
      steps.onRollbackError(rollbackErr);
    }
    if (undoWiring) {
      try {
        await undoWiring();
      } catch (rollbackErr) {
        steps.onRollbackError(rollbackErr);
      }
    }
    try {
      await steps.deregister();
    } catch (rollbackErr) {
      steps.onRollbackError(rollbackErr);
    }
    throw err;
  }
  return undoWiring;
}

/**
 * Replace a live bot with a rebuilt one without turning a rejected edit into an
 * outage.
 *
 * A `changed` entry cannot be updated in place — an adapter that is already
 * connected has no partial-update path — so it is a retire-and-add. The order
 * is what matters:
 *
 * 1. `prepare` builds and validates the replacement while the old bot is still
 *    serving. Every refusal (no `channel_filter` entry, a slice that builds the
 *    wrong number of bots, a credential the builder rejects) lands here, and
 *    lands as a no-op.
 * 2. Only then is the old instance retired.
 * 3. If the replacement still fails to commit, `rebuildPrevious` builds a FRESH
 *    instance from the APPLIED slice — the configuration this unit was
 *    actually running, per {@link appliedSliceFor}, never "the file as it
 *    parsed last time" — and it goes through the SAME `commit`.
 *
 * WHY THE ROLLBACK REBUILDS RATHER THAN RESTARTS. The obvious rollback is to
 * re-register the adapter object that was just retired and call `start()` on it
 * again — and it is wrong. `retire` ran `stop()`, and `PlatformAdapter` makes no
 * promise that `start()` works afterwards: real transports destroy their client,
 * their socket, their listeners, or their auth state in `stop()`. Some
 * implementations happen to survive it, which is worse than none surviving it,
 * because the rollback then works everywhere it is tested and fails on the one
 * adapter nobody restarted. Requiring restartability instead would be a new
 * cross-package contract. So the rollback goes down the one path that is already
 * exercised on every hot-add: build a new bot and adapter from the previous
 * config slice, and commit it as a transaction.
 *
 * WHY NOT START THE REPLACEMENT FIRST and swap routing afterwards, which would
 * remove the gap entirely: a `changed` entry keeps its botKey by definition,
 * and for Telegram and WhatsApp that means the replacement holds the SAME
 * credential as the live adapter. Telegram answers a second concurrent
 * `getUpdates` on one token with 409 Conflict, and a second Baileys session on
 * one credential logs the first one out — so a parallel start would break the
 * bot that is currently working. Retire-then-start with a rebuild is the
 * strongest ordering the platforms actually permit.
 *
 * The caller must NOT mark the unit applied when this throws: the retry that
 * the applied-state ledger then owes is the real backstop, and it rebuilds the
 * bot from scratch on the next poll even if the rollback also failed.
 */
export async function swapBotLive<TPrepared>(steps: {
  prepare: () => Promise<TPrepared>;
  retire: () => Promise<void>;
  commit: (prepared: TPrepared) => Promise<void>;
  /** Build a FRESH instance from the APPLIED slice — never the retired
   *  object, and never the previously parsed file. Its result goes through the
   *  same `commit` as any other. */
  rebuildPrevious: () => Promise<TPrepared>;
  onRestoreFailed: (err: unknown) => void;
}): Promise<void> {
  const prepared = await steps.prepare();
  await steps.retire();
  try {
    await steps.commit(prepared);
  } catch (err) {
    try {
      await steps.commit(await steps.rebuildPrevious());
    } catch (restoreErr) {
      steps.onRestoreFailed(restoreErr);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// One wiring registry, cold-booted and hot-added bots alike
// ---------------------------------------------------------------------------

/** Undo one bot's app-level registrations. Held per bot, run exactly once. */
export type BotWiringTeardown = () => Promise<void>;

/**
 * Put the replacement's teardown handle in `botKey`'s slot and run the outgoing
 * one — in that order, exactly once.
 *
 * ORDER. The replacement is already registered by the time this is called, so
 * the outgoing teardown has to run AFTER its handle has been displaced: every
 * undo is identity-based (splice THIS router, delete THIS correlator), so
 * running it late cannot touch what replaced it, while running it early would
 * leave the slot holding a handle that had already fired.
 *
 * EXACTLY ONCE is the other half. The defect this closes was a registry that
 * only ever held HOT-ADDED bots' handles, so replacing a bot that had been
 * present at cold boot found nothing to run: its notification routers, clarify
 * correlator, approval surface, messaging bindings and personality refreshers
 * stayed registered while a second set was added beside them, and every further
 * edit added another. Cold-booted bots now register through the same path and
 * land in the same registry, so there is one shape of bot, not two.
 */
export async function replaceBotWiring(
  registry: Map<string, BotWiringTeardown>,
  botKey: string,
  next: BotWiringTeardown,
): Promise<void> {
  const outgoing = registry.get(botKey);
  registry.set(botKey, next);
  await outgoing?.();
}

/**
 * Retire one bot for good: TRANSPORT first, and only once that returned is the
 * app-level wiring dropped from the registry and undone.
 *
 * THE ORDER IS THE WHOLE POINT. `Gateway.removeAdapter` does not always retire
 * the bot it is handed: one still busy after the abort grace is QUARANTINED —
 * nothing is deleted, its routing entry, lanes and loop wiring all stay, no new
 * inbound is admitted for it, and the call REJECTS so a later reconcile poll
 * retries the teardown. Undoing the wiring first therefore dismantled the
 * approval flow, clarify correlator, notification routers, messaging bindings
 * and personality refreshers of a bot that was still running a turn on them —
 * and since the handle had already been deleted, the retry had nothing left to
 * restore it from.
 *
 * A deferred retirement propagates out of here with the registry untouched, so
 * the bot stays exactly what quarantine claims it is — fully wired, routing
 * intact, admitting nothing new — until a later retire succeeds.
 *
 * The lookup, the delete and the run are one step with no await between the
 * first two, so a retry overlapping a slow teardown cannot run the same handle
 * a second time.
 */
export async function retireBotFully(
  registry: Map<string, BotWiringTeardown>,
  botKey: string,
  retireTransport: () => Promise<void>,
): Promise<void> {
  await retireTransport();
  const teardown = registry.get(botKey);
  registry.delete(botKey);
  await teardown?.();
}

// ---------------------------------------------------------------------------
// The idle watcher's live view of per-bot background work
// ---------------------------------------------------------------------------

/** The two per-bot background handles the idle watcher samples. */
export interface BotBackgroundHandles {
  jobStore?: { countActive(): Promise<number> };
  backgroundExecutor?: { activeCount(): number };
}

/**
 * One busy-source entry that folds the gateway's LIVE bot list on every sample.
 *
 * `buildGatewayBusySources` folds `deps.bots` once, at construction, and the
 * idle watcher's `sources` are readonly — so an array captured at cold boot
 * reports the stores of bots that have since been retired and misses the ones
 * that replaced them. That is not a cosmetic staleness: a REPLACED bot keeps its
 * botKey, so a scheme that split the sample into "static at cold boot" and
 * "added since" by key put the replacement in neither half, and the process
 * could declare itself idle and suspend with that bot's job genuinely running.
 *
 * There is no static half any more. One entry, `gateway.listBots()` folded per
 * sample, covering every bot however it got there.
 */
export function createLiveBotBusySource(
  listBots: () => readonly BotBackgroundHandles[],
): Required<BotBackgroundHandles> {
  return {
    jobStore: {
      countActive: async () => {
        const counts = await Promise.all(
          listBots()
            .map((b) => b.jobStore)
            .filter((store) => store !== undefined)
            .map((store) => store.countActive()),
        );
        return counts.reduce((total, n) => total + n, 0);
      },
    },
    backgroundExecutor: {
      activeCount: () =>
        listBots()
          .map((b) => b.backgroundExecutor)
          .filter((executor) => executor !== undefined)
          .reduce((total, executor) => total + executor.activeCount(), 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Clarify correlators, keyed by the bot they belong to
// ---------------------------------------------------------------------------

export type ClarifyCorrelator = (msg: InboundMessage) => Promise<ClarifyResponse | null>;

export interface ClarifyCorrelatorRegistry {
  /** Register (or replace) one bot's correlator. */
  set(botKey: string, correlate: ClarifyCorrelator): void;
  /**
   * Drop a removed bot's correlator. `only` makes it a delete-if-still-mine:
   * a swap registers the replacement under the same botKey before the retiring
   * instance's teardown runs, and that teardown must not delete the correlator
   * that has already replaced its own.
   */
  delete(botKey: string, only?: ClarifyCorrelator): void;
  /** Registered correlators. */
  size(): number;
  /** The single stable closure the gateway is handed. */
  correlate: ClarifyCorrelator;
}

/**
 * `registerGatewayClarifySurfaces` returns ONE correlator closed over the
 * adapters it was handed, so every bot's surface has to be registered
 * alongside the others rather than replacing them. Appending them to a plain
 * array — the previous shape — meant a removed bot's closure was never
 * dropped: reloads accumulated correlators over dead adapters, and a re-added
 * bot could be answered by the stale one that ran before it.
 *
 * Keying by botKey fixes both: a removal deletes its entry, and a re-add
 * replaces it. There is no separate cold-boot slot, because there is no
 * separate cold-boot registration: `ethos boot` calls
 * `registerGatewayClarifySurfaces` once per bot with that bot's own adapter,
 * so a cold-booted bot's correlator is dropped on removal exactly like a
 * hot-added one's. (Per-bot slicing does not duplicate any surface — each
 * builder filters the adapter list by its own platform prefix first.)
 */
export function createClarifyCorrelatorRegistry(): ClarifyCorrelatorRegistry {
  const perBot = new Map<string, ClarifyCorrelator>();
  return {
    set(botKey, correlate) {
      perBot.set(botKey, correlate);
    },
    delete(botKey, only) {
      if (only !== undefined && perBot.get(botKey) !== only) return;
      perBot.delete(botKey);
    },
    size() {
      return perBot.size;
    },
    correlate: async (msg) => {
      for (const correlate of perBot.values()) {
        const resp = await correlate(msg);
        if (resp) return resp;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Phase C — webhook routes (plan §0 rows 5 and 6)
// ---------------------------------------------------------------------------
//
// Two unrelated servers, one shared idea: the ROUTE TABLE is the live thing,
// not the `http.Server`. Both listeners resolve a request against a table they
// were handed a reference to — `createWebhookServer` reads `webhooks[hookId]`
// per request, `createPlatformWebhookServer` reads `opts.telegram` /
// `opts.slack` per request — so mutating that table in place changes what is
// served, with no rebind and no dropped connection. Rebinding a server is
// Phase D's problem and is deliberately not touched here.

/**
 * A config holding exactly the one `webhooks.<hookId>` entry, so
 * `buildGatewayBots` produces exactly the one `webhook:<hookId>` bot that
 * route needs. The sibling of {@link sliceConfigForBot}, for the same reason:
 * a hot-added route must be built by the SAME builder the cold-boot path uses.
 *
 * Returns undefined when the config holds no such hookId.
 */
export function sliceConfigForWebhook(
  source: EthosConfig,
  hookId: string,
): EthosConfig | undefined {
  const hook = source.webhooks?.[hookId];
  if (!hook) return undefined;
  return { ...clearBotBlocks(source), webhooks: { [hookId]: hook } };
}

/**
 * Which live mount keys one adapter owns in a {@link PlatformWebhookMounts}
 * table: a Telegram bot is keyed by its botKey, a Slack app by the FULL route
 * its own receiver answers on.
 *
 * The Slack route is read off the adapter rather than recomputed from the
 * botKey for the same reason `buildPlatformWebhookMounts` reads it there — a
 * path derived twice is a path that can drift, and the drift shows up as a
 * production 404 rather than a type error.
 */
export function platformWebhookKeysFor(adapter: PlatformAdapter): {
  telegram?: string;
  slack?: string;
} {
  const colon = adapter.id.indexOf(':');
  if (colon <= 0) return {};
  const platform = adapter.id.slice(0, colon);
  const botKey = adapter.id.slice(colon + 1);
  if (platform === 'telegram') return { telegram: botKey };
  if (platform === 'slack') {
    const route = (adapter as { webhookRoute?: string }).webhookRoute;
    return route ? { slack: route } : {};
  }
  return {};
}

/**
 * Start ONE adapter, then mount THAT adapter's native webhook route — in that
 * order, as one atomic sequence per hot-added bot.
 *
 * THE ORDER IS THE WHOLE FUNCTION (plan §3, and `boot.ts`'s own cold-boot
 * comment). `TelegramAdapter.webhook` is `undefined` until `start()` has
 * registered the webhook with Telegram and built grammy's callback; mounting
 * first finds nothing to mount, warns, and leaves a bot whose every delivery
 * 404s forever. The cold-boot path gets this right by placing the whole
 * `buildPlatformWebhookMounts` call after `Promise.all(adapters.map(start))`,
 * which is a per-BOOT guarantee; a hot-add needs it per-ADAPTER, and that is
 * why this exists as a function instead of two statements at the call site.
 *
 * `slice` is the one-bot config from {@link sliceConfigForBot}, so the mount
 * decision (`use_webhook` / `mode.http`) is read from the same config entry
 * the adapter was built from. A bot NOT in webhook mode mounts nothing and
 * returns empty lists — that is the normal case, not an error.
 */
export async function startAndMountPlatformWebhook(
  adapter: PlatformAdapter,
  slice: EthosConfig,
  live: PlatformWebhookMounts,
  warn: (message: string) => void,
): Promise<{ telegram: string[]; slack: string[] }> {
  await adapter.start();
  const mounts = buildPlatformWebhookMounts(slice, [adapter], warn);
  for (const [botKey, handler] of mounts.telegram) live.telegram.set(botKey, handler);
  for (const [route, handler] of mounts.slack) live.slack.set(route, handler);
  return { telegram: [...mounts.telegram.keys()], slack: [...mounts.slack.keys()] };
}

/**
 * Drop one adapter's native webhook route from the live mount table.
 *
 * Works for a cold-booted bot as well as a hot-added one, because it needs
 * only the adapter — which `Gateway.listAdapters()` still answers with right
 * up until `removeAdapter` runs. Returns the routes actually unmounted.
 */
export function unmountPlatformWebhook(
  live: PlatformWebhookMounts,
  adapter: PlatformAdapter,
): string[] {
  const keys = platformWebhookKeysFor(adapter);
  const unmounted: string[] = [];
  if (keys.telegram !== undefined && live.telegram.delete(keys.telegram)) {
    unmounted.push(`/telegram/webhook/${keys.telegram}`);
  }
  if (keys.slack !== undefined && live.slack.delete(keys.slack)) unmounted.push(keys.slack);
  return unmounted;
}

/**
 * Close a listener that no longer serves any route, and answer with the handle
 * the caller should now hold (`undefined` once it is closed).
 *
 * Both webhook listeners are bound ON DEMAND — a deployment with no
 * `webhooks:` block and no webhook-mode bot binds no port at all, and the
 * operator's FIRST live route brings the listener up. The inverse was missing:
 * removing the last route left the port held by a server whose route table was
 * empty, so every request 404'd, the process's own no-route/no-bound-port rule
 * was broken, and an operator who removed a route to free the port found it
 * still taken. `close()` releases the listening handle immediately, so a later
 * addition can bind again.
 *
 * A no-op while any route remains, and a no-op when nothing is bound.
 */
export function closeIdleRouteListener<S>(opts: {
  server: S | undefined;
  routeCount: number;
  close: (server: S) => void;
}): S | undefined {
  if (opts.server === undefined || opts.routeCount > 0) return opts.server;
  opts.close(opts.server);
  return undefined;
}

// ---------------------------------------------------------------------------
// Reconcile scheduling, and the shutdown that has to outlive it
// ---------------------------------------------------------------------------

export interface ReloadRunner {
  /** Run a reconcile, unless one is in flight or shutdown has begun. */
  trigger(): void;
  /**
   * Refuse every further reconcile and resolve once the in-flight one has
   * finished. Idempotent.
   */
  stop(): Promise<void>;
}

/**
 * The poll's run/stop discipline, so shutdown cannot race a reconcile.
 *
 * Clearing the interval stops the NEXT reconcile; it does nothing about the
 * one already running, which can be halfway through adding a bot, replacing an
 * adapter, or rebinding the web server. Torn down concurrently, that leaves
 * exactly what shutdown exists to prevent: a freshly bound listener or a
 * freshly started adapter that cleanup has already walked past, still alive
 * after the process says it is down.
 *
 * So `stop()` latches the refusal FIRST — a reconcile that has not started
 * never will — and only then awaits the active one. `reload` is expected never
 * to reject; anything it throws is handed to `onError` so a caller awaiting
 * `stop()` during shutdown is never handed a rejection.
 */
export function createReloadRunner(
  reload: () => Promise<void>,
  onError: (err: unknown) => void,
): ReloadRunner {
  let active: Promise<void> | undefined;
  let stopped = false;
  return {
    trigger() {
      if (stopped || active) return;
      const run = reload()
        .catch(onError)
        .finally(() => {
          if (active === run) active = undefined;
        });
      active = run;
    },
    async stop() {
      stopped = true;
      await active;
    },
  };
}

// ---------------------------------------------------------------------------
// Phase D — per-server port rebind (plan §0 row 9, §4's Phase D bullet)
// ---------------------------------------------------------------------------
//
// SCOPE, AND WHY IT IS ONE SERVER RATHER THAN FIVE. §0 row 9 names five
// listeners (ACP 3001, health 3002, webhook 3003, platform-webhook 3006, web
// 3000+fallback). Only the web bind is reachable from `config.yaml`: `acpPort`
// is the `--port` CLI flag, and the health / webhook / platform-webhook ports
// are `ETHOS_GATEWAY_HEALTH_PORT` / `ETHOS_WEBHOOK_PORT` /
// `ETHOS_PLATFORM_WEBHOOK_PORT` (see `runBoot`'s resolution block). A config
// differ cannot observe an env var change, so inventing config keys for those
// four would be new configuration surface, not this phase.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH. Everything. The close-and-relisten
// below is handed a server, an address, and a listen function; it holds no
// reference to the `AgentLoop`, the session store, the job store, the mesh
// registration, or the gateway. That is the plan's §5.6 assertion made
// structural rather than merely tested: there is nothing here to call.
//
// A brief gap between close and listen is accepted (§6 non-goal: no
// zero-downtime multi-port renumbering scheme).

/** A web bind address, as requested — not necessarily as landed on. */
export interface WebBindTarget {
  host: string;
  port: number;
}

/**
 * The address the web server should be listening on for `config`, resolved
 * with the SAME precedence cold boot uses: CLI flag > env var > `config.yaml`
 * > default. Reusing `resolveWebHost`/`resolveWebPort` rather than reading
 * `config.web` directly is the whole point — a second resolution path is how
 * "the live bind disagrees with the one the process started on" happens.
 */
export function resolveWebBind(
  config: EthosConfig,
  args: string[],
  env: NodeJS.ProcessEnv,
): WebBindTarget {
  return {
    host: resolveWebHost(args, env, config),
    port: resolveWebPort(args, env, config),
  };
}

export type WebRebindDecision =
  | { action: 'rebind'; target: WebBindTarget }
  | { action: 'skip'; reason: string };

/**
 * Whether a reloaded config actually moves the live web bind.
 *
 * `current` is the address that was REQUESTED, not the one that was landed on:
 * the fallback ladder may have put the server on 3004 after asking for 3000,
 * and an operator who then writes `web.port: 3000` has changed nothing. Diffing
 * requested-against-requested is what keeps that a no-op instead of a pointless
 * bounce of the dashboard.
 *
 * A `--web-port` / `--web-host` flag or `ETHOS_WEB_PORT` / `ETHOS_WEB_HOST`
 * outranks `config.yaml`, so a config edit under one of those is inert. That is
 * reported as a named skip rather than silence — the same honesty rule §1 sets
 * for the unsupported keys.
 */
export function planWebRebind(
  current: WebBindTarget,
  config: EthosConfig,
  args: string[],
  env: NodeJS.ProcessEnv,
): WebRebindDecision {
  const target = resolveWebBind(config, args, env);
  if (target.host === current.host && target.port === current.port) {
    const pinned =
      hasFlag(args, ['--web-port']) ||
      hasFlag(args, ['--web-host']) ||
      env.ETHOS_WEB_PORT !== undefined ||
      env.ETHOS_WEB_HOST !== undefined;
    return {
      action: 'skip',
      reason: pinned
        ? '--web-port/--web-host or ETHOS_WEB_PORT/ETHOS_WEB_HOST outranks config.yaml'
        : 'the configured address is already the live one',
    };
  }
  return { action: 'rebind', target };
}

/**
 * The minimum a rebindable listener has to be. `@hono/node-server`'s
 * `ServerType` satisfies it, and so does a bare `http.Server` — which is what
 * lets a test drive this for real instead of against a mock.
 */
export interface RebindableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeAllConnections?: () => void;
}

export interface WebRebindOutcome<S extends RebindableServer> {
  server: S;
  /** The address asked for — feed this back in as the next `current`. */
  requested: WebBindTarget;
  /** The port actually landed on, which the fallback ladder may have moved. */
  port: number;
  /** True when `target` could not be bound and `current` was reclaimed. */
  fellBack: boolean;
}

function closeServer(server: RebindableServer): Promise<void> {
  // Idle keep-alive connections would otherwise hold the close callback — and
  // therefore the port — for as long as a browser keeps the dashboard open.
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Close one listener and re-listen it on a new address.
 *
 * CLOSE FIRST, ALWAYS. A host-only move (127.0.0.1 → 0.0.0.0 on the same port)
 * would collide with itself otherwise, and the collision would be reported as
 * "port in use" against a port nothing else holds.
 *
 * THE FAILURE MODE THAT MATTERS is a new port that is already taken. `listen`
 * is expected to be the caller's existing fallback ladder, which walks past an
 * occupied port on its own; this handles the case where even that gives up —
 * the range is exhausted, the host does not exist, the port is privileged. The
 * operator must not be left with NO web server because of a typo, so the
 * previous address (just vacated, so normally free) is reclaimed and the
 * failure is named through the injected logger.
 *
 * If the reclaim ALSO fails there is genuinely nothing left to bind: that is
 * logged at error level, saying in as many words that nothing is listening,
 * and the original error is rethrown for the caller's own guard to record.
 */
export async function rebindWebServer<S extends RebindableServer>(opts: {
  server: S;
  current: WebBindTarget;
  target: WebBindTarget;
  listen: (bind: WebBindTarget) => Promise<{ server: S; port: number }>;
  /** Re-attach anything bolted onto the old server (the voice + satellite
   *  WebSocket upgrade routes). Both `attach` implementations detach from the
   *  previous server first, so this is a move, not a duplicate registration. */
  onListening: (server: S) => void;
  logger: Logger;
}): Promise<WebRebindOutcome<S>> {
  const { server, current, target, listen, onListening, logger } = opts;
  const addr = (b: WebBindTarget) => `${b.host}:${b.port}`;
  await closeServer(server);
  try {
    const next = await listen(target);
    onListening(next.server);
    logger.info(`[config-reload] web server rebound to ${target.host}:${next.port}`, {
      component: 'config-reload',
      host: target.host,
      port: next.port,
    });
    return { server: next.server, requested: target, port: next.port, fellBack: false };
  } catch (err) {
    logger.warn(
      `[config-reload] web server could not bind ${addr(target)} — reverting to ${addr(current)}`,
      {
        component: 'config-reload',
        host: target.host,
        port: target.port,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    try {
      const back = await listen(current);
      onListening(back.server);
      return { server: back.server, requested: current, port: back.port, fellBack: true };
    } catch (reclaimErr) {
      logger.error(
        `[config-reload] web server is NOT listening — ${addr(target)} could not be bound and ${addr(current)} could not be reclaimed`,
        {
          component: 'config-reload',
          error: reclaimErr instanceof Error ? reclaimErr.message : String(reclaimErr),
        },
      );
      throw err;
    }
  }
}
