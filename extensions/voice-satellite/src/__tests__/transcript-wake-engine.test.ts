import { describe, expect, it } from 'vitest';
import {
  boundedLevenshtein,
  createTranscriptWakeEngine,
  normalizeUtterance,
  transcriptWakeEngineFactory,
} from '../engines/transcript-wake-engine';
import type { WakeRoute } from '../wake-engine';

function route(over: Partial<WakeRoute> & Pick<WakeRoute, 'id' | 'phrase'>): WakeRoute {
  return {
    personalityId: over.personalityId ?? 'engineer',
    privileged: over.privileged ?? false,
    enabled: over.enabled ?? true,
    ...over,
  };
}

const ENGINEER = route({ id: 'r-eng', phrase: 'hey engineer', personalityId: 'engineer' });

async function engineWith(routes: WakeRoute[], sensitivity = 0.5) {
  const engine = createTranscriptWakeEngine();
  await engine.init(routes, { sensitivity, confirmationFrames: 2 });
  return engine;
}

describe('normalizeUtterance', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeUtterance('  Hey,   ENGINEER!! ')).toBe('hey engineer');
  });
});

describe('boundedLevenshtein', () => {
  it('abandons past the bound instead of computing the true distance', () => {
    expect(boundedLevenshtein('engineer', 'engineer', 2)).toBe(0);
    expect(boundedLevenshtein('enginer', 'engineer', 2)).toBe(1);
    expect(boundedLevenshtein('engineer', 'wildly different', 2)).toBe(3);
  });
});

describe('transcript wake engine', () => {
  it('matches an exact phrase at the head of an utterance', async () => {
    const engine = await engineWith([ENGINEER]);
    const match = engine.matchText('hey engineer did CI pass');
    expect(match?.routeId).toBe('r-eng');
    expect(match?.phrase).toBe('hey engineer');
    expect(match?.confidence).toBe(1);
  });

  it('ignores case and punctuation', async () => {
    const engine = await engineWith([ENGINEER]);
    expect(engine.matchText('Hey, Engineer -- did CI pass?')?.routeId).toBe('r-eng');
  });

  it('tolerates a one-character transcription slip', async () => {
    const engine = await engineWith([ENGINEER]);
    const match = engine.matchText('hey enginer did CI pass');
    expect(match?.routeId).toBe('r-eng');
    expect(match?.confidence).toBeLessThan(1);
    expect(match?.confidence).toBeGreaterThan(0.8);
  });

  it('does not match "hey engine room" against "hey engineer"', async () => {
    const engine = await engineWith([ENGINEER]);
    expect(engine.matchText('hey engine room is on fire')).toBeNull();
  });

  it('requires the phrase at the HEAD of the utterance, not anywhere in it', async () => {
    const engine = await engineWith([ENGINEER]);
    expect(engine.matchText('so I said hey engineer to nobody')).toBeNull();
  });

  it('prefers the longest matching phrase', async () => {
    const engine = await engineWith([
      route({ id: 'r-swing', phrase: 'hey swing', personalityId: 'swing' }),
      route({ id: 'r-swing-trader', phrase: 'hey swing trader', personalityId: 'swing-trader' }),
    ]);
    expect(engine.matchText('hey swing trader how are my positions')?.routeId).toBe(
      'r-swing-trader',
    );
    expect(engine.matchText('hey swing by later')?.routeId).toBe('r-swing');
  });

  it('never matches a disabled route', async () => {
    const engine = await engineWith([route({ ...ENGINEER, enabled: false })]);
    expect(engine.matchText('hey engineer did CI pass')).toBeNull();
  });

  it('keeps its own copy of the routes, so host mutation cannot enable one', async () => {
    const mutable = route({ ...ENGINEER, enabled: false });
    const engine = await engineWith([mutable]);
    mutable.enabled = true;
    expect(engine.matchText('hey engineer did CI pass')).toBeNull();
  });

  it('carries a privileged route through without inferring the flag', async () => {
    const privileged = route({ id: 'r-root', phrase: 'hey root', personalityId: 'ops' });
    const engine = await engineWith([privileged]);
    // The engine matches what the gateway pushed and nothing else — it never
    // invents a route or upgrades one.
    expect(engine.matchText('hey root restart the box')?.routeId).toBe('r-root');
    expect(engine.matchText('hey rooted restart the box')).toBeNull();
  });

  it('widens the tolerance as sensitivity rises', async () => {
    const strict = await engineWith([ENGINEER], 0.5);
    const loose = await engineWith([ENGINEER], 1);
    // Two edits: "enjinear" vs "engineer".
    expect(strict.matchText('hey enjinear did CI pass')).toBeNull();
    expect(loose.matchText('hey enjinear did CI pass')?.routeId).toBe('r-eng');
  });

  it('demands an exact match at sensitivity 0', async () => {
    const engine = await engineWith([ENGINEER], 0);
    expect(engine.matchText('hey engineer did CI pass')?.routeId).toBe('r-eng');
    expect(engine.matchText('hey enginer did CI pass')).toBeNull();
  });

  it('never spots on raw PCM — push is not its input', async () => {
    const engine = await engineWith([ENGINEER]);
    expect(engine.push({ samples: new Int16Array(320), sampleRate: 16000 })).toBeNull();
  });

  it('probes available, because it has nothing to load', async () => {
    const probe = await transcriptWakeEngineFactory.probe();
    expect(probe.ok).toBe(true);
    expect(probe.engine).toBe('transcript');
  });
});
