import { describe, expect, it } from 'vitest';
import { VoiceService } from '../voice.service';

// What a realtime call is priced at, what caps it, and which entries a
// personality may name.
//
// The cap is the interesting one. It is parsed into
// `EthosConfig.voice.realtime.sessionBudgetUsd` and it used to reach this class
// by exactly ONE route — web-api's live-config read — which is optional. A
// service built without that read reported no cap, and "no cap" is
// indistinguishable downstream from "uncapped on purpose". These tests pin the
// second route.

const ROSTER = {
  live: { provider: 'openai-realtime', costPerMinuteUsd: 0.06 },
  gemini: { provider: 'gemini-live' },
} as const;

function service(opts: {
  realtimeSessionBudgetUsd?: number;
  liveBudgetUsd?: number | null;
  hasConfigGetter?: boolean;
}): VoiceService {
  return new VoiceService({
    realtimeRoster: { ...ROSTER },
    realtimeDefault: 'live',
    ...(opts.realtimeSessionBudgetUsd !== undefined
      ? { realtimeSessionBudgetUsd: opts.realtimeSessionBudgetUsd }
      : {}),
    ...(opts.hasConfigGetter
      ? {
          configGetter: async () => ({
            voiceRealtimeSessionBudgetUsd: opts.liveBudgetUsd ?? null,
          }),
        }
      : {}),
  });
}

describe('realtime session cost', () => {
  it('applies the typed cap on a service with no live-config read', async () => {
    // The regression this closes: same construction, no `configGetter`, and the
    // call used to come back uncapped however the operator had configured it.
    const cost = await service({ realtimeSessionBudgetUsd: 2.5 }).realtimeSessionCost();

    expect(cost.sessionBudgetUsd).toBe(2.5);
  });

  it('is uncapped only when nothing configured a cap', async () => {
    const cost = await service({}).realtimeSessionCost();

    expect(cost.sessionBudgetUsd).toBeUndefined();
  });

  it('lets a live number win over the boot snapshot', async () => {
    // An operator who just lowered the cap in Settings means the next call.
    const cost = await service({
      realtimeSessionBudgetUsd: 2.5,
      hasConfigGetter: true,
      liveBudgetUsd: 0.5,
    }).realtimeSessionCost();

    expect(cost.sessionBudgetUsd).toBe(0.5);
  });

  it('keeps the snapshot when the live read has no cap to report', async () => {
    // A live absence is a read that found nothing — a failed read, a deployment
    // with no config repo — not an instruction to stop capping. Being wrong in
    // the capped direction is the right way to be wrong about money.
    const cost = await service({
      realtimeSessionBudgetUsd: 2.5,
      hasConfigGetter: true,
      liveBudgetUsd: null,
    }).realtimeSessionCost();

    expect(cost.sessionBudgetUsd).toBe(2.5);
  });

  it('names the provider the selected entry will actually run', async () => {
    const cost = await service({}).realtimeSessionCost();

    expect(cost.providerId).toBe('openai-realtime');
    expect(cost.costPerMinuteUsd).toBe(0.06);
  });
});

describe('realtime entries', () => {
  it('lists the roster and the label the deployment default names', async () => {
    const entries = await service({}).listRealtimeEntries();

    expect(entries.roster).toEqual({
      live: { providerId: 'openai-realtime' },
      gemini: { providerId: 'gemini-live' },
    });
    expect(entries.defaultEntryName).toBe('live');
  });

  it('reports an empty roster rather than inventing a default entry', async () => {
    // There is no `auxiliary.*` entry beneath this tier, so a synthetic Default
    // would be a selection that resolves to nothing.
    const entries = await new VoiceService({}).listRealtimeEntries();

    expect(entries).toEqual({ roster: {}, defaultEntryName: null });
  });
});
