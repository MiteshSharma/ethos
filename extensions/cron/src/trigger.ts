import type { CronArmingBackend, CronEngine } from './index';

// ---------------------------------------------------------------------------
// CronTriggerSource — who calls `CronEngine.fire()`.
// See plan/phases/cron-scheduler-seam.md for the full design.
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
 * Arms nothing. The only `CronArmingBackend` this phase ships — used by
 * local mode (the next interval tick always finds due work, no arming
 * needed) and by hybrid dev mode (an operator plays the arming backend's
 * part by hand, via `curl` or a tunnel, against `POST /cron/fire`). A real
 * backend (e.g. a Firecracker Wake Controller) is explicitly deferred — see
 * plan/phases/cron-scheduler-seam.md.
 */
export class NoopArmingBackend implements CronArmingBackend {
  arm(): void {
    // Intentionally inert.
  }
}

// ---------------------------------------------------------------------------
// Config-driven construction — the three deployment profiles fall out of
// four config keys with no code fork (plan §"Config surface").
// ---------------------------------------------------------------------------

/** Structural shape of the `cron:` top-level config section. Kept separate
 *  from `@ethosagent/config`'s `EthosConfig['cron']` type (duck-typed, not
 *  imported) so this package doesn't take a dependency on the config layer. */
export interface CronDeploymentConfig {
  trigger?: {
    local?: boolean;
    external?: boolean;
  };
  arming?: {
    backend?: string;
    fireUrl?: string | null;
  };
}

export interface CronTriggers {
  /** Present iff `cron.trigger.local` is true (default). */
  local: LocalIntervalTrigger | null;
  /** Present iff `cron.trigger.external` is true (default false). */
  external: HttpFireTrigger | null;
  /** Always present — `NoopArmingBackend` is the only implementation this
   *  phase ships, regardless of `cron.arming.backend`'s value. */
  arming: CronArmingBackend;
}

/**
 * Build the trigger/backend combination for a deployment from `cron.*`
 * config, per the three profiles in plan/phases/cron-scheduler-seam.md:
 *
 * - local/always-on   — `trigger.local: true`,  `trigger.external: false` (default)
 * - hybrid/dev         — `trigger.local: true`,  `trigger.external: true`
 * - external/scale-to-zero — `trigger.local: false`, `trigger.external: true`
 *
 * An operator with no `cron:` section at all gets exactly today's behavior:
 * only `LocalIntervalTrigger` running, nothing else constructed.
 */
export function buildCronTriggers(
  engine: CronEngine,
  config: CronDeploymentConfig | undefined,
  localIntervalMs = 60_000,
): CronTriggers {
  const local = config?.trigger?.local ?? true;
  const external = config?.trigger?.external ?? false;
  return {
    local: local ? new LocalIntervalTrigger(engine, localIntervalMs) : null,
    external: external ? new HttpFireTrigger(engine) : null,
    arming: new NoopArmingBackend(),
  };
}
