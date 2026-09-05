// Every system cron job the config can ask for must have a handler registered.
//
// The two halves live in different packages — the roster in
// `@ethosagent/wiring`'s `systemJobSpecs`, the handlers in this app's
// `buildSystemTaskHandlers` — and cron only discovers a mismatch when the job
// fires, by throwing "System task handler … not registered" at 4am into a
// `lastError` nobody is watching. This is that check, at test time.

import type { EthosConfig } from '@ethosagent/config';
import { systemJobSpecs } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { buildSystemTaskHandlers } from '../wiring';

const config: EthosConfig = {
  provider: 'anthropic',
  model: 'm',
  apiKey: 'sk',
  personality: 'researcher',
  // Everything switched on, so every spec in the roster is exercised.
  nightlyPass: { enabled: true },
  weeklyDigest: { enabled: true },
  evolverCronEnabled: true,
};

// `channel-digest` is contributed by the gateway/boot commands
// (`channelDigestSystemTask`), not by this shared table: it needs the live
// Gateway — `sendVia`, the per-bot loops, the transcript store — which
// `buildSystemTaskHandlers` has no handle on. It is the one documented
// exception, so the check below still fails for anything else added to a
// roster without a handler.
const HOST_CONTRIBUTED = new Set(['channel-digest']);

describe('buildSystemTaskHandlers', () => {
  it('registers a handler for every system job spec, on every surface', () => {
    const handlers = buildSystemTaskHandlers(config);
    for (const surface of ['serve', 'gateway', 'boot'] as const) {
      for (const spec of systemJobSpecs(config, surface)) {
        if (HOST_CONTRIBUTED.has(spec.systemTask)) continue;
        expect(
          handlers[spec.systemTask],
          `no handler for "${spec.systemTask}" (${surface})`,
        ).toBeTypeOf('function');
      }
    }
  });

  it('registers the scheduled backup handler', () => {
    expect(buildSystemTaskHandlers(config).backup).toBeTypeOf('function');
  });
});
