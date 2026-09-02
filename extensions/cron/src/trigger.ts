import type { CronArmingBackend, CronEngine } from './index';

// ---------------------------------------------------------------------------
// CronTriggerSource — who calls `CronEngine.fire()`.
// See plan/completed/cron-scheduler-seam.md for the full design.
// ---------------------------------------------------------------------------

/**
 * Who calls `CronEngine.fire()`. Two implementations ship in this phase:
 * `LocalIntervalTrigger` (today's in-process interval, now `unref()`'d) and
 * `HttpFireTrigger` (no internal loop — an HTTP route calls `fire()` directly
 * when a request arrives).
 */
export interface CronTriggerSource {
  /** Run the engine's due-scan-and-run cycle once, right now. */
  fire(): Promise<void>;
  /** Start whatever internal loop this trigger uses. No-op for a trigger with
   *  no internal loop (e.g. `HttpFireTrigger`). */
  start(): void;
  /** Stop the internal loop started by `start()`. No-op where there is none. */
  stop(): void;
}

/**
 * Today's behavior: an in-process `setInterval` calling `engine.fire()`,
 * fired once immediately on `start()` (handles missed runs across a
 * restart). `unref()`'d so a lone pending tick never keeps the process
 * alive — the previous `CronScheduler.start()` timer was NOT `unref()`'d;
 * fixing that is part of this phase.
 */
export class LocalIntervalTrigger implements CronTriggerSource {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: CronEngine,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    void this.engine.fire(); // check immediately on start (handles missed runs)
    this.timer = setInterval(() => void this.engine.fire(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  fire(): Promise<void> {
    return this.engine.fire();
  }
}

/**
 * No internal loop — `fire()` is called directly by `POST /cron/fire`
 * (apps/web-api/src/routes/cron.ts) when a request arrives. `start()`/
 * `stop()` are no-ops so callers can treat every `CronTriggerSource`
 * uniformly regardless of which kind is configured.
 */
export class HttpFireTrigger implements CronTriggerSource {
  constructor(private readonly engine: CronEngine) {}

  fire(): Promise<void> {
    return this.engine.fire();
  }

  start(): void {
    // No internal loop — nothing to start.
  }

  stop(): void {
    // No internal loop — nothing to stop.
  }
}

// ---------------------------------------------------------------------------
// CronArmingBackend — who gets told when to call back.
// ---------------------------------------------------------------------------

/**
 * Arms nothing. The only `CronArmingBackend` there is — used by local mode
 * (the next interval tick always finds due work, no arming needed) and by a
 * dev rehearsal where an operator plays the arming backend's part by hand,
 * via `curl` or a tunnel, against `POST /cron/fire`. A real backend (e.g. a
 * Firecracker Wake Controller) is explicitly deferred — see
 * plan/completed/cron-scheduler-seam.md.
 */
export class NoopArmingBackend implements CronArmingBackend {
  arm(): void {
    // Intentionally inert.
  }
}

// ---------------------------------------------------------------------------
// Config-driven construction — one presence-gated field selects the mode
// (plan/phases/cron-fire-url-collapse.md).
// ---------------------------------------------------------------------------

/** Structural shape of the `cron:` top-level config section. Kept separate
 *  from `@ethosagent/config`'s `EthosConfig['cron']` type (duck-typed, not
 *  imported) so this package doesn't take a dependency on the config layer.
 *  Its counterpart is `CronTopLevelConfig` in `packages/config/src/index.ts`;
 *  the two shapes are kept in sync by hand. */
export interface CronDeploymentConfig {
  /** Where an external scheduler reaches this process's `POST /cron/fire`.
   *  Presence is the mode switch: set → external mode (no in-process
   *  interval); absent → local mode (today's `setInterval`).
   *
   *  Nothing in Ethos reads the value — it is recorded, not dialled. It stays
   *  a URL rather than collapsing to a boolean for two reasons. It is the
   *  exact address a real `CronArmingBackend` will need to call back on, so a
   *  boolean would have to be replaced by this field later, breaking every
   *  operator's config at that point. And it documents, in the file an
   *  operator actually reads, where the external scheduler is expected to
   *  reach this process — information a boolean destroys. */
  fireUrl?: string;
}

export interface BuildCronTriggersOptions {
  /** Tick interval for the in-process `LocalIntervalTrigger`, when one is
   *  built. Omit for `LocalIntervalTrigger`'s own 60s default. */
  localIntervalMs?: number;
  /** Does this process mount `POST /cron/fire`?
   *
   *  Default `false`, deliberately: it is the fail-safe direction. A call
   *  site that forgets the option keeps ticking locally — at worst a
   *  redundant tick, which `claimDueJob`'s compare-and-swap already makes
   *  safe against double execution. A default of `true` would instead hand a
   *  forgetful call site a silently dead scheduler. `serve` and `boot` pass
   *  `true`; `gateway` has no HTTP surface and passes `false`. */
  hasHttpSurface?: boolean;
}

export interface CronTriggers {
  /** The in-process interval. `null` only in external mode — `fireUrl` set
   *  AND this process actually mounts `POST /cron/fire`. */
  local: LocalIntervalTrigger | null;
  /** Always constructed: config no longer gates `POST /cron/fire`. Whether
   *  the route is reachable is decided by the host app mounting it and by the
   *  bearer key's `cron` scope. A process with no HTTP surface builds one and
   *  ignores it. */
  external: HttpFireTrigger;
  /** Always present — `NoopArmingBackend` is the only implementation, and it
   *  is inert. */
  arming: CronArmingBackend;
  /** Operator-facing notices for the app layer to print at boot. Empty in the
   *  normal local case. They are returned as data rather than logged here
   *  because library code in this repo must not write to the console — a rule
   *  this package has never broken, and this field is what keeps that true. */
  notices: string[];
}

/**
 * Build the trigger/backend combination for a deployment. One field decides
 * the mode — the presence of `cron.fireUrl`:
 *
 * - absent  → local mode. Today's in-process `LocalIntervalTrigger`.
 * - present → external mode. No in-process interval; something outside the
 *   process (an external scheduler, an operator's `curl`) drives
 *   `POST /cron/fire`.
 *
 * With one override. A process that does not mount `POST /cron/fire`
 * (`hasHttpSurface` false — the default) can never be fired externally, so it
 * keeps its local interval regardless of `fireUrl` and says so in `notices`
 * rather than going silently dark. Log and fall through, never throw at boot.
 *
 * An operator with no `cron:` section at all gets exactly today's behavior:
 * the local interval running, and `POST /cron/fire` available to a bearer key
 * carrying the `cron` scope wherever the host app mounts it.
 */
export function buildCronTriggers(
  engine: CronEngine,
  config: CronDeploymentConfig | undefined,
  opts?: BuildCronTriggersOptions,
): CronTriggers {
  const fireUrl = config?.fireUrl;
  const forceLocal = opts?.hasHttpSurface !== true;
  const notices: string[] = [];

  if (fireUrl && forceLocal) {
    notices.push(
      `cron: fireUrl is set (${fireUrl}) but this process has no HTTP surface to mount ` +
        'POST /cron/fire on, so the fire URL is ignored here and the in-process cron ' +
        'interval is running instead.',
    );
  }
  if (fireUrl && !forceLocal) {
    notices.push(
      `cron: external mode — fireUrl is set (${fireUrl}), so the in-process cron interval ` +
        'is not running. An external caller must drive POST /cron/fire with a bearer key ' +
        "carrying the 'cron' scope, or no scheduled job will ever run.",
    );
  }

  return {
    local: !fireUrl || forceLocal ? new LocalIntervalTrigger(engine, opts?.localIntervalMs) : null,
    external: new HttpFireTrigger(engine),
    arming: new NoopArmingBackend(),
    notices,
  };
}
