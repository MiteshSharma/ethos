import { describe, expect, it } from 'vitest';
import {
  deriveWakeRouteId,
  emptyWakeRouteDraft,
  implicitWakeRoutes,
  SATELLITES_EMPTY_COPY,
  validateWakeRoutes,
  WAKE_ROUTES_EMPTY_COPY,
  type WakeRouteDraft,
  type WakeRouteWire,
  wakeRouteDraftsFromServer,
  wakeRouteErrorRow,
  wakeRoutesToInput,
  wakeTestCandidates,
  wakeTestMatch,
} from '../wake-routes';

// The wake-route editor's decisions, without mounting the form — the apps/web
// suite has no DOM, so the same seam `voice-channels.test.ts` uses.

function draft(over: Partial<WakeRouteDraft> = {}): WakeRouteDraft {
  return {
    key: 'k1',
    id: 'r-eng',
    phrase: 'hey engineer',
    personalityId: 'engineer',
    privileged: false,
    enabled: true,
    ...over,
  };
}

describe('wake route hydrate / serialize', () => {
  it('round-trips a saved table unchanged', () => {
    const saved = [
      {
        id: 'r-eng',
        phrase: 'hey engineer',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
        implicit: false,
      },
      {
        id: 'r-root',
        phrase: 'hey root',
        personalityId: 'operator',
        privileged: true,
        enabled: false,
        implicit: false,
      },
    ];
    expect(wakeRoutesToInput(wakeRouteDraftsFromServer(saved))).toEqual(
      saved.map(({ implicit: _implicit, ...wire }) => wire),
    );
  });

  it('never hydrates a synthesized `hey <name>` route into an editable row', () => {
    // Hydrating one would have the next save try to write `auto:researcher`
    // into config.yaml, materializing a default that is supposed to follow the
    // personality registry.
    const drafts = wakeRouteDraftsFromServer([
      {
        id: 'r-eng',
        phrase: 'hey engineer',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
        implicit: false,
      },
      {
        id: 'auto:researcher',
        phrase: 'hey researcher',
        personalityId: 'researcher',
        privileged: false,
        enabled: true,
        implicit: true,
      },
    ]);
    expect(drafts.map((d) => d.id)).toEqual(['r-eng']);
  });

  it('gives every hydrated row a distinct key, because the id is not stable under editing', () => {
    const drafts = wakeRouteDraftsFromServer([
      {
        id: 'a',
        phrase: 'hey a',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
        implicit: false,
      },
      {
        id: 'b',
        phrase: 'hey b',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
        implicit: false,
      },
    ]);
    expect(new Set(drafts.map((d) => d.key)).size).toBe(2);
  });

  it('keeps a hand-written yaml key when the operator edits its phrase', () => {
    const rows = wakeRoutesToInput([draft({ id: 'engineer', phrase: 'yo engineer' })]);
    expect(rows[0]?.id).toBe('engineer');
    expect(rows[0]?.phrase).toBe('yo engineer');
  });

  it('derives an id for a row added in the editor, and trims the phrase', () => {
    const rows = wakeRoutesToInput([draft({ id: '', phrase: '  Hey Swing Trader!  ' })]);
    expect(rows[0]).toEqual({
      id: 'hey-swing-trader',
      phrase: 'Hey Swing Trader!',
      personalityId: 'engineer',
      privileged: false,
      enabled: true,
    });
  });

  it('never derives an id that collides with one already in the table', () => {
    const rows = wakeRoutesToInput([
      draft({ key: 'k1', id: 'hey-engineer', phrase: 'hey engineer' }),
      draft({ key: 'k2', id: '', phrase: 'hey engineer' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['hey-engineer', 'hey-engineer-2']);
  });

  it('falls back to a usable key when the phrase has no ascii to slug', () => {
    expect(deriveWakeRouteId('привет инженер', new Set())).toBe('route');
  });

  it('starts an added row enabled and unprivileged — privilege is never a default', () => {
    const fresh = emptyWakeRouteDraft();
    expect(fresh.enabled).toBe(true);
    expect(fresh.privileged).toBe(false);
    expect(fresh.id).toBe('');
  });
});

describe('implicitWakeRoutes', () => {
  it('separates the synthesized defaults out for the read-only readout', () => {
    const routes = [
      {
        id: 'r-eng',
        phrase: 'hey engineer',
        personalityId: 'engineer',
        privileged: false,
        enabled: true,
        implicit: false,
      },
      {
        id: 'auto:researcher',
        phrase: 'hey researcher',
        personalityId: 'researcher',
        privileged: false,
        enabled: true,
        implicit: true,
      },
    ];
    expect(implicitWakeRoutes(routes).map((r) => r.phrase)).toEqual(['hey researcher']);
  });
});

describe('validateWakeRoutes', () => {
  it('names the two failures the server cannot phrase better', () => {
    const errors = validateWakeRoutes([
      draft({ key: 'k1', phrase: '   ' }),
      draft({ key: 'k2', personalityId: '' }),
      draft({ key: 'k3' }),
    ]);
    expect(Object.keys(errors)).toEqual(['k1', 'k2']);
  });
});

describe('wakeRouteErrorRow', () => {
  it('attributes an unknown-personality rejection to the row that names it', () => {
    const drafts = [draft({ key: 'k1', id: 'r-eng' }), draft({ key: 'k2', id: 'r-ghost' })];
    const hit = wakeRouteErrorRow(
      'Wake route "r-ghost" names unknown personality "ghost".',
      drafts,
    );
    expect(hit?.key).toBe('k2');
  });

  it('attributes a rejection to a row that has not been saved yet, via its derived id', () => {
    const drafts = [draft({ key: 'k9', id: '', phrase: 'hey ghost', personalityId: 'ghost' })];
    const hit = wakeRouteErrorRow(
      'Wake route "hey-ghost" names unknown personality "ghost".',
      drafts,
    );
    expect(hit?.key).toBe('k9');
  });

  it('returns null when no row owns the message, so the caller shows it above the list', () => {
    expect(wakeRouteErrorRow('Config file is not writable.', [draft()])).toBeNull();
  });
});

describe('wakeTestMatch (DR2)', () => {
  const drafts = [
    draft({ key: 'k-eng', phrase: 'hey engineer', personalityId: 'engineer' }),
    draft({ key: 'k-swing', phrase: 'hey swing', personalityId: 'researcher' }),
    draft({ key: 'k-trader', phrase: 'hey swing trader', personalityId: 'reviewer' }),
  ];

  it('lights the row a spoken phrase would wake', () => {
    expect(wakeTestMatch(drafts, [], 'Hey, engineer — did CI pass?', 0.5)).toBe('k-eng');
  });

  it('prefers the longer, more specific route', () => {
    expect(wakeTestMatch(drafts, [], 'hey swing trader how are my positions', 0.5)).toBe(
      'k-trader',
    );
    expect(wakeTestMatch(drafts, [], 'hey swing by later', 0.5)).toBe('k-swing');
  });

  it('lights nothing when the phrase is only mentioned, not addressed', () => {
    expect(wakeTestMatch(drafts, [], 'so I said hey engineer to nobody', 0.5)).toBeNull();
  });

  it('skips a disabled row, exactly as the engine does', () => {
    const off = drafts.map((d) => (d.key === 'k-eng' ? { ...d, enabled: false } : d));
    expect(wakeTestMatch(off, [], 'hey engineer did CI pass', 0.5)).toBeNull();
  });

  it('lights an unsaved row — the whole point is proving a route before saving', () => {
    const unsaved = [draft({ key: 'k-new', id: '', phrase: 'hey jarvis', personalityId: 'coach' })];
    expect(wakeTestMatch(unsaved, [], 'hey jarvis turn on the lights', 0.5)).toBe('k-new');
  });
});

describe('wakeTestMatch against the effective table (DR2, implicit routes)', () => {
  // What `voice.wakeRoutes.get` returns for the synthesized half. The server
  // has already applied its own suppression rules to this list — notably, no
  // route is here for a privileged personality.
  function wire(over: Partial<WakeRouteWire> = {}): WakeRouteWire {
    return {
      id: 'auto:researcher',
      phrase: 'hey researcher',
      personalityId: 'researcher',
      privileged: false,
      enabled: true,
      implicit: true,
      ...over,
    };
  }

  const implicit = [
    wire(),
    wire({ id: 'auto:coach', phrase: 'hey coach', personalityId: 'coach' }),
  ];

  it('lights a synthesized `hey <name>` route — it answers in the room, so it answers here', () => {
    // The gap this closes: the phrase works with zero config, and the tester
    // used to stay dark for it because implicit rows are filtered out of the
    // editable drafts.
    const candidates = wakeTestCandidates([], implicit);
    const key = wakeTestMatch([], implicit, 'hey researcher, what did you find?', 0.5);
    expect(key).toBe('auto:researcher');
    expect(candidates.find((c) => c.key === key)?.personalityId).toBe('researcher');
  });

  it('still lights a configured row when both halves are present', () => {
    const configured = [draft({ key: 'k-eng', phrase: 'hey engineer', personalityId: 'engineer' })];
    expect(wakeTestMatch(configured, implicit, 'hey engineer did CI pass', 0.5)).toBe('k-eng');
  });

  it('never lights a configured row and its personality’s default at once', () => {
    // The server suppresses a personality's implicit route as soon as a config
    // route names it, so this pairing only exists BEFORE a save — which is
    // exactly the table the tester runs against.
    const configured = [
      draft({ key: 'k-res', id: '', phrase: 'yo researcher', personalityId: 'researcher' }),
    ];
    const candidates = wakeTestCandidates(configured, implicit);
    expect(candidates.map((c) => c.key)).toEqual(['k-res', 'auto:coach']);
    expect(wakeTestMatch(configured, implicit, 'hey researcher what did you find', 0.5)).toBeNull();
    expect(wakeTestMatch(configured, implicit, 'yo researcher what did you find', 0.5)).toBe(
      'k-res',
    );
  });

  it('lets a disabled row suppress the default too, exactly as the server does', () => {
    // Switching a personality's wake off did not ask for a fresh enabled
    // default to appear beside it.
    const off = [
      draft({
        key: 'k-res',
        phrase: 'hey researcher',
        personalityId: 'researcher',
        enabled: false,
      }),
    ];
    expect(wakeTestCandidates(off, implicit).map((c) => c.key)).toEqual(['auto:coach']);
    expect(wakeTestMatch(off, implicit, 'hey researcher what did you find', 0.5)).toBeNull();
  });

  it('matches the edited phrase, not the saved one — that is what “before saving” means', () => {
    const edited = [
      draft({ key: 'k-eng', id: 'r-eng', phrase: 'hey chief', personalityId: 'engineer' }),
    ];
    expect(wakeTestMatch(edited, implicit, 'hey chief did CI pass', 0.5)).toBe('k-eng');
    expect(wakeTestMatch(edited, implicit, 'hey engineer did CI pass', 0.5)).toBeNull();
  });

  it('does not resurrect a privileged personality the server left out', () => {
    // A privileged personality is reachable by voice only through a route that
    // opts in out loud. It never arrives in the implicit list, and nothing on
    // this side invents one from the phrase.
    const candidates = wakeTestCandidates([], implicit);
    expect(candidates.some((c) => c.personalityId === 'operator')).toBe(false);
    expect(wakeTestMatch([], implicit, 'hey operator, deploy to prod', 0.5)).toBeNull();
  });
});

describe('empty-state copy', () => {
  it('renders DR1 exactly — a route table with nothing in it still works', () => {
    expect(WAKE_ROUTES_EMPTY_COPY).toBe(
      "No wake routes yet — every personality answers to 'hey <name>'. Add a custom phrase.",
    );
  });

  it('tells the operator how to connect a satellite, not just that there are none', () => {
    expect(SATELLITES_EMPTY_COPY).toContain('ethos listen');
    expect(SATELLITES_EMPTY_COPY).toContain('ethos listen doctor');
    expect(SATELLITES_EMPTY_COPY).not.toMatch(/^None\b/);
  });
});
