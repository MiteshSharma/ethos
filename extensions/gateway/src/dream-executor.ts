import type { AgentLoop } from '@ethosagent/core';
import type { PersonalityConfig, Storage } from '@ethosagent/types';
import { assertSafeId } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Dream state — internal, not exported from types
// ---------------------------------------------------------------------------

interface DreamState {
  lastDreamAt: string; // ISO date string
  runsToday: number;
  windowStart: string; // ISO date string
}

// ---------------------------------------------------------------------------
// Default dream prompt
// ---------------------------------------------------------------------------

const DEFAULT_DREAM_PROMPT =
  'Review recent session history. Consolidate key facts into MEMORY.md. ' +
  'Update USER.md with any new user preferences observed. ' +
  'Be concise — this is background maintenance, not a conversation.';

// ---------------------------------------------------------------------------
// DreamExecutor — idle-triggered background maintenance turns
// ---------------------------------------------------------------------------

export class DreamExecutor {
  private readonly lastUserTurnAt = new Map<string, number>();
  private readonly inFlight = new Map<string, AbortController>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly storage: Storage,
    private readonly getLoop: (personalityId: string) => AgentLoop | undefined,
    private readonly getConfig: (personalityId: string) => PersonalityConfig | undefined,
  ) {}

  /** Call on every inbound user message to update the activity timestamp. */
  recordUserTurn(personalityId: string): void {
    assertSafeId(personalityId, 'personalityId');
    this.lastUserTurnAt.set(personalityId, Date.now());
    // Cancel in-flight dream — user activity takes priority
    const inflight = this.inFlight.get(personalityId);
    if (inflight) {
      inflight.abort();
    }
  }

  /** Start the idle-check interval (every 5 minutes). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 5 * 60_000);
    this.timer.unref?.();
  }

  /** Stop the idle-check interval and clean up. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const abort of this.inFlight.values()) {
      abort.abort();
    }
    this.inFlight.clear();
  }

  /**
   * Whether any dream turn is currently running — the unscoped view of
   * `inFlight`, which the tick loop only ever consults one personality at a
   * time. Exists for the idle-watcher's busy predicate: a dream is a real
   * LLM turn, so stopping the process mid-dream truncates it.
   */
  hasActiveDreams(): boolean {
    return this.inFlight.size > 0;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [personalityId, lastTurn] of this.lastUserTurnAt) {
        const config = this.getConfig(personalityId);
        if (!config?.dreaming?.enable) continue;
        if (this.inFlight.has(personalityId)) continue;

        const idleMs = (config.dreaming.idleMinutes ?? 60) * 60_000;
        if (Date.now() - lastTurn < idleMs) continue;

        // Check eligibility
        const eligible = await this.checkEligibility(personalityId, config.dreaming.maxPerDay ?? 1);
        if (!eligible) {
          // Reset so this crossing doesn't re-fire every tick
          this.lastUserTurnAt.set(personalityId, Date.now());
          continue;
        }

        // Execute dream run
        await this.executeDream(personalityId, config);
        // Reset timer — dream counts as activity
        this.lastUserTurnAt.set(personalityId, Date.now());
      }
    } finally {
      this.ticking = false;
    }
  }

  private async checkEligibility(personalityId: string, maxPerDay: number): Promise<boolean> {
    if (maxPerDay <= 0) return false;
    assertSafeId(personalityId, 'personalityId');
    const path = `personalities/${personalityId}/dream-state.json`;
    const raw = await this.storage.read(path);
    if (!raw) return true;

    try {
      const state: DreamState = JSON.parse(raw);
      const windowStart = new Date(state.windowStart).getTime();
      const now = Date.now();

      if (now - windowStart > 24 * 60 * 60_000) return true;
      return state.runsToday < maxPerDay;
    } catch {
      return true; // corrupt state → allow
    }
  }

  private async executeDream(personalityId: string, config: PersonalityConfig): Promise<void> {
    const loop = this.getLoop(personalityId);
    if (!loop) return;

    const prompt = config.dreaming?.prompt ?? DEFAULT_DREAM_PROMPT;
    const sessionKey = `dream:${personalityId}:${Date.now()}`;

    const abort = new AbortController();
    this.inFlight.set(personalityId, abort);

    let success = false;
    try {
      // Dream turns run on the `dreaming` model tier — a personality that
      // declares `model.dreaming` gets its cheaper maintenance model here.
      // Falls back to `model.default` / the global model when it doesn't.
      for await (const event of loop.run(prompt, {
        personalityId,
        sessionKey,
        abortSignal: abort.signal,
        tierOverride: 'dreaming',
      })) {
        if (event.type === 'done') {
          success = true;
          break;
        }
        if (event.type === 'error') break;
      }
    } finally {
      this.inFlight.delete(personalityId);
    }

    if (success) {
      await this.persistState(personalityId);
    }
  }

  private async persistState(personalityId: string): Promise<void> {
    const path = `personalities/${personalityId}/dream-state.json`;
    const raw = await this.storage.read(path);

    let runsToday = 1;
    let windowStart = new Date().toISOString();

    if (raw) {
      try {
        const prev: DreamState = JSON.parse(raw);
        const prevWindow = new Date(prev.windowStart).getTime();
        if (Date.now() - prevWindow <= 24 * 60 * 60_000) {
          runsToday = prev.runsToday + 1;
          windowStart = prev.windowStart;
        }
      } catch {
        // corrupt state — start fresh
      }
    }

    await this.storage.writeAtomic(
      path,
      JSON.stringify({ lastDreamAt: new Date().toISOString(), runsToday, windowStart }, null, 2),
    );
  }
}
