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

describe('buildSystemTaskHandlers', () => {
  it('registers a handler for every system job spec', () => {
    const handlers = buildSystemTaskHandlers(config);
    for (const spec of systemJobSpecs(config)) {
      expect(handlers[spec.systemTask], `no handler for "${spec.systemTask}"`).toBeTypeOf(
        'function',
      );
    }
  });

  it('registers the scheduled backup handler', () => {
    expect(buildSystemTaskHandlers(config).backup).toBeTypeOf('function');
  });
});
