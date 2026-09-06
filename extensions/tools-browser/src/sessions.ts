// ---------------------------------------------------------------------------
// Shared browser session state
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import type { NetworkPolicy } from '@ethosagent/safety-network';
import type { ToolResult } from '@ethosagent/types';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { A11yRef } from './a11y';
import { installRouteGuard } from './session-route';

const MAX_CONSOLE_LOGS = 200;

/** Default idle-sweep window (`browser.idleTimeoutMs`). */
export const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

/** How long a second session waits for a busy profile before falling back. */
export const PROFILE_LOCK_TIMEOUT_MS = 15_000;

export interface NetworkPolicyShape {
  allow?: string[];
  deny?: string[];
  allow_private_urls?: boolean;
}

export type BrowserTier = 'stock' | 'stealth';

export interface SessionProfile {
  /** Mutex identity — the personality id (D4). */
  key: string;
  /** Absolute user-data directory handed to `launchPersistentContext`. */
  dir: string;
}

/**
 * Launch-time state. D5: tier / proxy / profile are mutable per-session
 * state, deliberately NOT part of the session key — see `makeMapKey`.
 */
export interface SessionLaunchOptions {
  tier?: BrowserTier;
  headless?: boolean;
  proxy?: { server: string; username?: string; password?: string };
  profile?: SessionProfile;
  /**
   * A one-shot notice from the caller's own option resolution — today the
   * no-display headless fallback. Joins `pendingWarnings` on the session it
   * launches, so the first tool result reports it and nothing repeats it.
   */
  launchWarning?: string;
}

export interface BrowserSession {
  /**
   * Absent for a persistent context — `launchPersistentContext` owns the
   * browser internally and hands back no separate handle.
   */
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  refs: Map<string, A11yRef>;
  lastUrl: string;
  /**
   * Ch.7 — fingerprint of the network policy this session was created
   * under. The session is keyed by (sessionId, policyFingerprint), so
   * a personality / policy switch lookups-misses and forces a fresh
   * session with a fresh route handler + serviceWorkers='block' on
   * its own BrowserContext. Eliminates the race where browser_click
   * triggers a navigation gated by a stale policy ref.
   */
  policyFingerprint: string;
  /** Buffer of console messages captured since last read. */
  consoleLogs: string[];
  /** Engine tier this session is currently running at (D5 — mutable). */
  tier: BrowserTier;
  /** Proxy server currently in use, if any (D5 — mutable). */
  proxyKey?: string;
  /** Persistent profile currently held, if any (D5 — mutable). */
  profileKey?: string;
  /**
   * The profile this session was LAUNCHED FOR — the personality id, present
   * even when the profile mutex timed out and the launch fell back to an
   * ephemeral context (D4). `profileKey` cannot answer "whose session is
   * this": it is absent on that fallback, so comparing against it would
   * relaunch the same personality's browser on every single call.
   *
   * This is the field session reuse is gated on. A persistent profile holds
   * cookies and logged-in state, so handing personality B the context
   * personality A opened hands B A's logins — the isolation D4 exists to
   * promise, broken by the cache in front of it.
   */
  requestedProfileKey?: string;
  /**
   * True when this session's browser has a real window on a screen (B2). The
   * takeover tool brings that window to the front; a headless session has no
   * window to raise. Absent means "not known to be headed" — a session poked
   * into the map by a test or a plugin raises nothing.
   */
  headed?: boolean;
  /**
   * Set while a human holds the browser. The idle sweeper SKIPS these, and
   * so does `getOrCreateSession`'s policy-change teardown — closing the
   * window under someone mid-takeover is the failure this field exists to
   * prevent — `closeSession` skips them, and every other browser tool refuses
   * with `not_available` (see `acquireAgentLease`).
   *
   * `requestId` names the clarify this lock belongs to, and the screencast
   * lane checks it on every frame: a viewer that presents any other id is
   * driving one takeover while resolving somebody else's request. It stays
   * OPTIONAL in the type because the lock is taken before the id exists —
   * `browser_request_takeover` sets `{}` first so other tools are refused from
   * that instant, then stamps the id on via `ClarifyRequestInput.onRequestId`.
   * A lock with no id is one nothing can be handed back through.
   */
  takeover?: { requestId?: string };
  /** D4 fallback notice — set when the profile mutex wait expired. */
  profileWarning?: string;
  /**
   * Launch notices not yet shown to the user. Drained (spliced) by the first
   * tool result that reports — a `⚠` trail row once per session, not on every
   * navigation. `profileWarning` stays set alongside because it describes a
   * standing condition the status line keeps reading.
   */
  pendingWarnings: string[];
  /** ms epoch of the last create/lookup. Read by the idle sweeper. */
  lastActiveAt: number;
  /**
   * @internal Releases the per-profile mutex. Set only for persistent
   * contexts; `close()` calls it.
   */
  releaseProfile?: () => void;
  /** Closes context + browser and releases the profile mutex. */
  close(): Promise<void>;
}

const sessions = new Map<string, BrowserSession>();

/**
 * @internal
 *
 * Stable, order-independent hash of the policy alone. Used both as part
 * of the session map key (combined with sessionId) AND stored on the
 * BrowserSession as `policyFingerprint`. Two separate identifiers — see
 * `makeMapKey` below — so the security invariant check in
 * findActiveSession compares policy-to-policy, not key-to-key.
 *
 * Exported ONLY so tests can construct adversarial scenarios (right
 * map key + wrong fingerprint, etc.) without re-implementing the hash.
 * Not stable API — production callers must not depend on the format.
 */
export function policyFingerprint(policy: NetworkPolicyShape): string {
  const sorted = {
    allow: [...(policy.allow ?? [])].sort(),
    deny: [...(policy.deny ?? [])].sort(),
    allow_private_urls: !!policy.allow_private_urls,
  };
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

/**
 * @internal
 *
 * Map key for the sessions Map. Exported for the same reason as
 * `policyFingerprint` — tests need it to construct adversarial
 * fixtures. Not stable API.
 *
 * D5: the key is (sessionId, policy) and NOTHING else. Tier, proxy and
 * profile are per-session state, so a tier switch must NOT change the
 * key — `findActiveSession(sessionId, policy)` has to keep finding the
 * same session across `relaunchSessionWithRoute`.
 */
export function makeMapKey(sessionId: string, policy: NetworkPolicyShape): string {
  return `${sessionId}::${policyFingerprint(policy)}`;
}

// Back-compat surface — older callers (browser_click etc.) only know the
// sessionId, so the key-by-policy machinery hides behind getOrCreateSession.
export { sessions };

/**
 * Strict session lookup keyed by (sessionId, current policy fingerprint).
 *
 * Used by every browser tool that can cause network traffic (click, type,
 * screenshot, vision-*). Returns the session ONLY when its
 * policyFingerprint matches the current policy. A mismatch returns
 * undefined so the caller can refuse with a "no session under current
 * policy" error rather than navigating under stale rules.
 *
 * The map-key match is the fast path; the security invariant is the
 * explicit `session.policyFingerprint === fingerprint` check below. We
 * do NOT trust that whoever wrote the map-key used `makeKey` correctly
 * — a stray writer (test, future plugin) could otherwise insert a
 * BrowserSession under the expected key with a stale fingerprint.
 *
 * Tools must NOT use a sessionId-only lookup — that path is the
 * stale-policy hole Codex called out.
 */
export function findActiveSession(
  sessionId: string,
  policy: NetworkPolicyShape,
): BrowserSession | undefined {
  const fp = policyFingerprint(policy);
  const session = sessions.get(makeMapKey(sessionId, policy));
  if (!session) return undefined;
  // Explicit invariant — the map key is the fast path; the recorded
  // session.policyFingerprint is what actually gates the lookup.
  if (session.policyFingerprint !== fp) return undefined;
  session.lastActiveAt = Date.now();
  return session;
}

/**
 * The refusal every OTHER browser tool returns while a human holds the session
 * (B1). `not_available` rather than `execution_failed`: the tool is fine, the
 * browser is simply not the agent's right now, and the agent should wait for
 * the takeover to hand back rather than treat this as a page-level failure.
 *
 * Returns `null` when the session is unlocked.
 *
 * TOOLS MUST NOT USE THIS. Reading the flag proves only that no human held the
 * browser at that instant, and every browser tool then awaits — the window
 * after the check is where the race lives. `acquireAgentLease` below performs
 * the same check AND claims the session in one uninterrupted step; this stays
 * for the callers that genuinely only need to read the flag (the sweeper's and
 * the policy-teardown's `s.takeover` checks, and anything outside this package
 * asking "is a human holding this").
 */
export function takeoverRefusal(session: BrowserSession): ToolResult | null {
  if (!session.takeover) return null;
  return takeoverRefusalResult();
}

/**
 * The same refusal, without a session to read it off. Used by
 * `acquireAgentLease` — a tool refused because the exclusive lease is held is
 * refused for the same reason and in the same words as one refused because the
 * flag is set. One dialect, one message, one place it is written down.
 */
export function takeoverRefusalResult(): ToolResult {
  return {
    ok: false,
    error:
      'A human has taken over this browser session — the agent cannot drive it until they hand it back.',
    code: 'not_available',
  };
}

// ---------------------------------------------------------------------------
// Per-session shared/exclusive lease (B1)
// ---------------------------------------------------------------------------

// `session.takeover` is a FLAG, and a flag read once at a tool's entry cannot
// hold a promise the feature makes. Every browser tool checks it and then
// awaits — a goto, a click, a snapshot — so a takeover that begins one
// microtask after the check finds the agent still driving the page it has just
// handed to a human. Re-checking the flag at more call sites cannot fix that:
// a check-then-act with an await in between is a race by construction.
//
// So the flag keeps its job (ADMISSION: from the instant it is set, no new
// agent operation starts) and this lease takes the other one (MUTUAL
// EXCLUSION: an operation already running finishes, and the human is not handed
// the browser until it has). Ordinary tools hold the shared side for their
// WHOLE operation including cleanup; the takeover holds the exclusive side, and
// only gets it once the shared holders have drained.
//
// Why not `acquireProfileLock` / `acquireCreationLock`. Both are promise-chain
// mutexes — one holder at a time, waiters queue. Neither shape works here:
//   - Agent tools must not QUEUE behind a takeover. A tool that waits its turn
//     waits up to fifteen minutes for a human and then acts on a page that has
//     changed under it. It has to be refused immediately, which is a
//     non-blocking try-acquire, not a queue.
//   - The takeover needs to wait for N concurrent holders to finish
//     (`executeParallel` runs browser tools in parallel), not for one. A chain
//     of single holders cannot express "drain".
// A counter plus a drain signal is the smallest thing that does both, so that
// is what this is — kept in this file next to the two locks it sits beside.
//
// ORDERING (deadlock): the lease is always INNERMOST. Creation lock outside,
// profile lock inside it, lease inside both — a lease is only ever taken after
// `getOrCreateSession` has returned, and nothing that holds a lease goes on to
// acquire a creation or profile lock. There is therefore no cycle to close: a
// takeover draining leases never blocks a creation, and a creation never waits
// on a lease.

/**
 * How long a takeover waits for in-flight agent operations to drain before
 * giving up. A generous multiple of the 30s default navigation budget: a drain
 * that has not finished by then is a hung operation, not a slow page. Without
 * a bound, one wedged tool call would park the takeover — and its `session.
 * takeover` flag — for the life of the process.
 */
/** Race sentinel — shared by the takeover drain and the profile lock below. */
const TIMED_OUT = Symbol('lock-timeout');

export const TAKEOVER_DRAIN_TIMEOUT_MS = 60_000;

interface LeaseState {
  /**
   * Agent operations currently holding the shared side — the RELEASE function
   * of each, not a count.
   *
   * A set rather than a number because `closeSession` has to tell one holder
   * from another: its callers are cleanup paths that run while their OWN lease
   * is still held (deliberately — see the note above each `catch`), so
   * "somebody holds this session" is not the question it needs answered.
   * "Somebody OTHER THAN ME holds it" is, and only identity answers that.
   */
  shared: Set<() => void>;
  /** A takeover holds — or is draining toward — the exclusive side. */
  exclusive: boolean;
  /** Resolvers waiting for `shared` to empty. */
  drained: Array<() => void>;
}

const leases = new Map<string, LeaseState>();

function leaseState(sessionId: string): LeaseState {
  const existing = leases.get(sessionId);
  if (existing) return existing;
  const created: LeaseState = { shared: new Set(), exclusive: false, drained: [] };
  leases.set(sessionId, created);
  return created;
}

/** Drop a lease nobody holds or wants, so the map does not grow per session. */
function dropIdleLease(sessionId: string, state: LeaseState): void {
  if (state.shared.size === 0 && !state.exclusive && state.drained.length === 0) {
    leases.delete(sessionId);
  }
}

/**
 * Take the shared lease for one agent operation, or refuse.
 *
 * SYNCHRONOUS on purpose — the flag check and the acquire happen in the same
 * uninterrupted step, which is the whole point: there is no window between
 * "the browser is the agent's" and "the agent has claimed it".
 *
 * Returns the release, or `null` when a human holds the session (flag set, or
 * exclusive lease taken). The caller returns `takeoverRefusalResult()` and must
 * call the release from a `finally` covering its ENTIRE operation — page work,
 * snapshot, and cleanup — not just up to its first await.
 */
export function acquireAgentLease(sessionId: string, session: BrowserSession): (() => void) | null {
  const state = leaseState(sessionId);
  if (state.exclusive || session.takeover) {
    dropIdleLease(sessionId, state);
    return null;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.shared.delete(release);
    if (state.shared.size === 0) for (const resolve of state.drained.splice(0)) resolve();
    dropIdleLease(sessionId, state);
  };
  state.shared.add(release);
  return release;
}

/**
 * Is this session held by an agent operation OTHER than `own`?
 *
 * The predicate `closeSession` needs and `session.takeover` cannot give it.
 * The flag says a HUMAN is driving; this says a SIBLING TOOL is — a click
 * mid-navigation, a screenshot mid-snapshot — and closing the browser under
 * one of those is the same invariant broken by a different holder.
 *
 * `own` is the caller's own lease, which is still held on purpose while its
 * cleanup runs (releasing first would let a takeover's exclusive lease land
 * mid-teardown — see the note above each `catch`). Passing it is what keeps a
 * failed navigation able to close the browser it just failed on; omitting it
 * is safe in the other direction, the session is merely left for the idle
 * sweeper.
 *
 * `exclusive` counts as held with no exception for `own`: nothing that takes
 * the shared lease can also hold the exclusive one, and a takeover claims it
 * SYNCHRONOUSLY before `session.takeover` is set — so this covers the window
 * where a human is arriving but the flag has not landed yet.
 */
export function leaseHeldByOthers(sessionId: string, own?: (() => void) | null): boolean {
  const state = leases.get(sessionId);
  if (!state) return false;
  if (state.exclusive) return true;
  for (const holder of state.shared) {
    if (holder !== own) return true;
  }
  return false;
}

/**
 * Claim the exclusive lease for a takeover.
 *
 * The claim is SYNCHRONOUS — from the moment this returns, `acquireAgentLease`
 * refuses — and `drain` is the wait for operations that were already running.
 * It is `null` when there was nothing in flight, so the common case adds no
 * await at all and the takeover reaches the clarify bridge exactly as promptly
 * as it did before. Awaiting `drain` resolves `true` once the last shared
 * holder released, or `false` if `timeoutMs` expired first — the caller then
 * refuses the takeover rather than handing a human a browser the agent is
 * still driving.
 *
 * `release` is idempotent and belongs in the same `finally` that clears
 * `session.takeover`, so a timeout, a cancel, an abort or a throw all free it.
 */
export function claimTakeoverLease(
  sessionId: string,
  timeoutMs: number = TAKEOVER_DRAIN_TIMEOUT_MS,
): { release: () => void; drain: Promise<boolean> | null } {
  const state = leaseState(sessionId);
  state.exclusive = true;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    state.exclusive = false;
    dropIdleLease(sessionId, state);
  };
  if (state.shared.size === 0) return { release, drain: null };

  let settle: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    settle = resolve;
  });
  state.drained.push(settle);
  const drain = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    const winner = await Promise.race([drained.then(() => undefined), expiry]);
    clearTimeout(timer);
    if (winner !== TIMED_OUT) return true;
    const waiting = state.drained.indexOf(settle);
    if (waiting >= 0) state.drained.splice(waiting, 1);
    return false;
  })();
  return { release, drain };
}

/**
 * @internal Live lease entries — every session's, or just `sessionId`'s.
 * Exported so tests can prove a takeover leaves nothing behind. Scoped by
 * session on purpose: a global count couples every test to every other one.
 */
export function activeLeaseCount(sessionId?: string): number {
  if (sessionId === undefined) return leases.size;
  return leases.has(sessionId) ? 1 : 0;
}

export async function getChromium() {
  const { chromium } = await import('playwright');
  return chromium;
}

// ---------------------------------------------------------------------------
// Takeover settle notification
// ---------------------------------------------------------------------------

/** Told a takeover has ended, with the session and the request it belonged to. */
export type TakeoverSettledListener = (sessionId: string, requestId: string) => void;

const takeoverSettledListeners = new Set<TakeoverSettledListener>();

/**
 * Watch for takeovers ending. Returns an unsubscribe.
 *
 * The screencast lane (`apps/web-api/src/browser/takeover-socket.ts`) is the
 * only subscriber today, and it needs this because a takeover can end in four
 * places it cannot see: the chat card, the clarify timeout, a cancelled turn,
 * and the socket's own hand-back. Polling the lock only tells it when a viewer
 * happens to send something; a person who has stopped typing would otherwise
 * keep a live CDP session on a browser the agent has already resumed.
 */
export function onTakeoverSettled(listener: TakeoverSettledListener): () => void {
  takeoverSettledListeners.add(listener);
  return () => {
    takeoverSettledListeners.delete(listener);
  };
}

/**
 * Fire the settle notification. Called by `browser_request_takeover` from the
 * same `finally` that clears the lock, so the two can never drift apart.
 *
 * A listener that throws is swallowed: this runs on the tool's exit path, and
 * a viewer's teardown failing must not turn a completed takeover into a failed
 * tool call.
 */
export function notifyTakeoverSettled(sessionId: string, requestId: string): void {
  for (const listener of [...takeoverSettledListeners]) {
    try {
      listener(sessionId, requestId);
    } catch {
      // Deliberately ignored — see above.
    }
  }
}

// ---------------------------------------------------------------------------
// Per-profile mutex (D4)
// ---------------------------------------------------------------------------

// A persistent context owns its user-data directory exclusively, so a second
// concurrent session for the same personality has to wait for the first to
// close. Promise-chain mutex — the same shape as
// extensions/tools-todo/src/store.ts `runSerial`: a Map of per-key tails, each
// acquire chaining its own deferred onto the previous one. The difference is
// that this one is acquire/release rather than run-to-completion, because the
// lock is held for the whole lifetime of a browser session, not for one call.
//
// SCOPE: this mutex is PROCESS-LOCAL and the directory it guards is not. The
// map lives in this module's memory, so a second Ethos process on the same
// host running the same personality (`ethos serve` beside `ethos gateway`, the
// desktop app beside a CLI chat) never sees it — it neither waits the timeout
// nor takes the ephemeral fallback. It collides with Chromium's own
// single-instance lock on the user-data directory instead:
// `launchPersistentContext` throws, `launchBackend` releases and rethrows, and
// the user gets a failed navigate rather than a logged-out session with a
// warning. A real fix is the cross-process advisory lock this repo already
// uses twice — an exclusive `wx` sentinel file with stale-holder detection, as
// in extensions/agent-mesh/src/index.ts and packages/wiring/src/
// backup-schedule.ts. Until then the documented rule is one Ethos process per
// personality profile (docs/content/building/reference/browser-tools.md
// #profiles-one-process).
const profileLocks = new Map<string, Promise<void>>();

/**
 * Wait up to `timeoutMs` for the profile lock. Returns the release fn, or
 * `null` when the wait expired — the caller then falls back to an ephemeral
 * context with a warning (D4). A timed-out waiter releases its own slot
 * immediately so the chain keeps draining for everyone behind it.
 *
 * The release drops the map entry when it is still the tail — the same
 * identity-checked cleanup `acquireCreationLock` does, and for the same
 * reason: without it every personality id ever asked for keeps a settled
 * promise in this map for the life of the process, which with marketplace or
 * dynamically-created personalities is permanent growth.
 */
export async function acquireProfileLock(
  profileKey: string,
  timeoutMs: number = PROFILE_LOCK_TIMEOUT_MS,
): Promise<(() => void) | null> {
  const prev = profileLocks.get(profileKey) ?? Promise.resolve();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(
    () => held,
    () => held,
  );
  profileLocks.set(profileKey, tail);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const winner = await Promise.race([
    prev.then(
      () => undefined,
      () => undefined,
    ),
    expiry,
  ]);
  clearTimeout(timer);
  if (winner === TIMED_OUT) {
    // Deliberately NO map cleanup here: `prev` has not settled, so somebody
    // else still holds the lock. Deleting the tail on this path would start
    // the next acquirer from `Promise.resolve()` and hand it a lock that is
    // taken. This waiter's tail is collected by whichever holder releases
    // last while still being the tail.
    release();
    return null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    // Still the tail → nobody is queued behind this holder, so the chain can go.
    if (profileLocks.get(profileKey) === tail) profileLocks.delete(profileKey);
  };
}

/**
 * @internal Live profile-lock entries — every key's, or just `profileKey`'s.
 * Exported so tests can prove a released lock leaves nothing behind. Scoped by
 * key on purpose, like `activeLeaseCount`: a global count couples every test
 * to every other one.
 */
export function profileLockCount(profileKey?: string): number {
  if (profileKey === undefined) return profileLocks.size;
  return profileLocks.has(profileKey) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Per-sessionId creation mutex
// ---------------------------------------------------------------------------

// D4's sibling, and the reason it exists: two parallel calls that both missed
// the map both launched a browser. With a profile configured the loser waited
// out the 15s profile lock, fell back to an ephemeral context, and then
// OVERWROTE the persistent session in the map — the displaced browser
// unreachable, its profile lock never released, and every session after it
// falling back logged-out for the rest of the process.
//
// Same promise-chain shape as `acquireProfileLock` above, minus the timeout:
// this lock is held for one launch rather than for a session's whole lifetime,
// so a waiter has something definite and short to wait for. The tail is
// dropped on release when nobody chained behind it, so the map does not grow
// one entry per session key forever.
//
// The two locks NEST — creation outside, profile inside — and cannot deadlock:
// a creation key is never acquired while another creation key is held, and the
// inner profile wait has its own timeout and its own fallback.
//
// KEYED BY sessionId, not by (sessionId, policy). Teardown, `closeSession`,
// `claimTakeoverLease` and `createBrowserTakeoverRegistry` all speak in
// sessionIds and assume at most one session per one — the policy-change
// teardown below has always ENFORCED that by closing every other session for
// the sessionId. A lock keyed by the finer (sessionId, policy) let two
// concurrent creations under different policies both miss the map, both
// launch, and both publish: the registry then answers with whichever entry
// the map iterated first (the screencast attaching to the wrong browser) and
// the two share one `sessionId`-keyed lease boolean, so one takeover's
// release frees the other's. Serialising on the coarser key is what makes
// the invariant the rest of the file already assumes actually hold.
const creationLocks = new Map<string, Promise<void>>();

async function acquireCreationLock(key: string): Promise<() => void> {
  const prev = creationLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(
    () => held,
    () => held,
  );
  creationLocks.set(key, tail);
  await prev.catch(() => undefined);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    // Still the tail → nobody is queued behind this holder, so the chain can go.
    if (creationLocks.get(key) === tail) creationLocks.delete(key);
  };
}

/**
 * The two ways an existing session satisfies a request, in the order
 * `getOrCreateSession` has always checked them. Run once before taking the
 * creation lock (the fast path) and again under it (the whole point of the
 * lock: the call queued ahead may have published the very session this one
 * was about to launch).
 *
 * D4 — `profileKey` is part of the decision, not just of the directory name.
 * The key is (sessionId, policy), which says nothing about WHOSE browser this
 * is, so a personality switch inside one conversation used to be handed the
 * previous personality's persistent context: its cookies, its logged-in
 * state. Reuse is refused when the requested profile differs, and the caller
 * tears the old session down and launches into the right profile directory.
 * The KEY is left alone on purpose — putting the profile in it would break
 * D5's promise that `findActiveSession(sessionId, policy)` keeps finding the
 * session across an in-place tier / proxy / profile switch.
 */
function reusableSession(
  sessionId: string,
  key: string,
  fp: string,
  profileKey: string | undefined,
): BrowserSession | undefined {
  const exact = sessions.get(key);
  // The map-key match is the fast path; the security invariant is the
  // explicit fingerprint comparison. A session inserted under the right
  // key with a stale `policyFingerprint` (test, plugin, future bug) gets
  // torn down rather than reused.
  if (exact && exact.policyFingerprint === fp && exact.requestedProfileKey === profileKey) {
    exact.lastActiveAt = Date.now();
    return exact;
  }
  // B1 — a human driving this browser does not have it closed underneath
  // them. The teardown below exists to stop a navigation under a stale
  // policy, and it still does: what changes while the session is LOCKED is
  // which of the two bad outcomes we pick. Destroying the window someone is
  // typing into is worse than refusing the navigation, so the locked session
  // is handed straight back — with its own (stale) fingerprint intact, still
  // under its own map key, never re-keyed or reused under the new policy.
  // The caller's `acquireAgentLease` then refuses with the same
  // `not_available` every other browser tool returns while locked. Same
  // invariant `sweepIdleSessions` already honours.
  for (const [k, s] of sessions.entries()) {
    if (k.startsWith(`${sessionId}::`) && s.takeover) {
      s.lastActiveAt = Date.now();
      return s;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

interface LaunchedBackend {
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  profileKey?: string;
  profileWarning?: string;
  warnings: string[];
  releaseProfile?: () => void;
}

async function launchBackend(launch: SessionLaunchOptions): Promise<LaunchedBackend> {
  const chromium = await getChromium();
  const noSandbox = process.env.ETHOS_BROWSER_NO_SANDBOX === '1';
  if (noSandbox) {
    process.stderr.write(
      '[ethos] WARNING: browser sandbox disabled via ETHOS_BROWSER_NO_SANDBOX=1 — only use in trusted environments without userns support\n',
    );
  }
  const args = [
    ...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
    '--disable-gpu',
  ];
  const headless = launch.headless ?? true;

  if (launch.profile) {
    const release = await acquireProfileLock(launch.profile.key);
    if (release) {
      try {
        // serviceWorkers: 'block' for the same reason as the ephemeral path
        // below — a registered SW intercepts fetches before route() sees them.
        const context = await chromium.launchPersistentContext(launch.profile.dir, {
          args,
          headless,
          proxy: launch.proxy,
          serviceWorkers: 'block',
        });
        const page = context.pages()[0] ?? (await context.newPage());
        return {
          context,
          page,
          profileKey: launch.profile.key,
          releaseProfile: release,
          warnings: launch.launchWarning ? [launch.launchWarning] : [],
        };
      } catch (err) {
        release();
        throw err;
      }
    }
  }

  const browser = await chromium.launch({ args, headless, proxy: launch.proxy });
  // serviceWorkers: 'block' — a registered service worker can intercept
  // fetches before page.route() sees them (Playwright documents this
  // behavior). Blocking SW registration at the context level closes
  // the bypass.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const profileWarning = launch.profile
    ? `Browser profile '${launch.profile.key}' is in use by another session — this second session is not logged in.`
    : undefined;
  return {
    browser,
    context,
    page,
    profileWarning,
    warnings: [launch.launchWarning, profileWarning].filter((w): w is string => w !== undefined),
  };
}

function attachPageListeners(session: BrowserSession, page: Page): void {
  // Capture console messages for browser_console tool
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (session.consoleLogs.length >= MAX_CONSOLE_LOGS) {
      session.consoleLogs.shift();
    }
    session.consoleLogs.push(`[${type}] ${text}`);
  });

  // Capture dialogs (alert/confirm/prompt) for browser_dialog tool.
  // Playwright dialogs block the triggering page action until handled.
  // Auto-dismiss immediately to prevent deadlock, but record the event
  // so the agent can inspect what happened via browser_console / browser_dialog.
  page.on('dialog', async (dialog) => {
    const entry = `[dialog:${dialog.type()}] ${dialog.message()}`;
    if (session.consoleLogs.length >= MAX_CONSOLE_LOGS) {
      session.consoleLogs.shift();
    }
    session.consoleLogs.push(entry);
    // Auto-dismiss to unblock the page. Alerts are accepted (they only have OK).
    // Confirms/prompts are dismissed (safest default).
    if (dialog.type() === 'alert') {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
  });
}

/** Close a backend nothing is pointing at, and give its profile mutex back. */
async function discardBackend(backend: LaunchedBackend): Promise<void> {
  await backend.context.close().catch(() => {});
  await backend.browser?.close().catch(() => {});
  backend.releaseProfile?.();
}

/** Drop `session` from the map by identity — its key is nobody's business. */
function forgetSession(session: BrowserSession): void {
  for (const [k, s] of sessions.entries()) if (s === session) sessions.delete(k);
}

async function closeSessionResources(session: BrowserSession): Promise<void> {
  await session.context.close().catch(() => {});
  await session.browser?.close().catch(() => {});
  session.releaseProfile?.();
  session.releaseProfile = undefined;
}

export async function getOrCreateSession(
  sessionId: string,
  policy: NetworkPolicyShape = {},
  launch: SessionLaunchOptions = {},
): Promise<BrowserSession> {
  const fp = policyFingerprint(policy);
  const key = makeMapKey(sessionId, policy);
  const profileKey = launch.profile?.key;

  const cached = reusableSession(sessionId, key, fp, profileKey);
  if (cached) return cached;

  // Nothing to reuse — from here on exactly one caller per sessionId may
  // launch.
  const releaseCreation = await acquireCreationLock(sessionId);
  try {
    const published = reusableSession(sessionId, key, fp, profileKey);
    if (published) return published;

    // ONE published session per sessionId. Everything still mapped under this
    // sessionId is a session this call supersedes — a stale policy
    // fingerprint (the protection against browser_click running under stale
    // rules), a previous personality's profile, or the exact key about to be
    // replaced. Closing them BEFORE the launch is also what releases a
    // persistent profile's mutex in time for the replacement to take it.
    //
    // Nothing reached here is under a takeover: `reusableSession` hands a
    // locked session straight back above, so a human's browser never gets
    // this far (B1).
    for (const [k, s] of sessions.entries()) {
      if (!k.startsWith(`${sessionId}::`)) continue;
      sessions.delete(k);
      await s.close();
    }

    const backend = await launchBackend(launch);

    const session: BrowserSession = {
      browser: backend.browser,
      context: backend.context,
      page: backend.page,
      refs: new Map(),
      lastUrl: '',
      policyFingerprint: fp,
      consoleLogs: [],
      tier: launch.tier ?? 'stock',
      proxyKey: launch.proxy?.server,
      profileKey: backend.profileKey,
      requestedProfileKey: profileKey,
      headed: !(launch.headless ?? true),
      profileWarning: backend.profileWarning,
      pendingWarnings: backend.warnings,
      releaseProfile: backend.releaseProfile,
      lastActiveAt: Date.now(),
      close: () => closeSessionResources(session),
    };

    attachPageListeners(session, backend.page);

    // Only the creator publishes. A writer that claimed this key while the
    // launch was in flight keeps it, and THIS backend is the redundant one —
    // closed rather than left running with nothing pointing at it and its
    // profile lock still held.
    const raced = sessions.get(key);
    if (raced && raced !== session) {
      await session.close();
      raced.lastActiveAt = Date.now();
      return raced;
    }

    sessions.set(key, session);
    return session;
  } finally {
    releaseCreation();
  }
}

/**
 * Create-or-reuse, with the SSRF route guard installed. THE entry point for
 * any session that navigates — `getOrCreateSession` alone hands back a
 * context with no route handler on it.
 */
export async function getOrCreateSessionWithRoute(
  sessionId: string,
  policy: NetworkPolicy,
  launch?: SessionLaunchOptions,
): Promise<BrowserSession> {
  const session = await getOrCreateSession(sessionId, policy, launch);
  try {
    await installRouteGuard(session.context, policy);
  } catch (err) {
    // Same shape as the failed relaunch below: a session whose context did
    // NOT take the guard is dropped, closed, and its profile mutex given
    // back. `getOrCreateSession` has already published it, so leaving it
    // there would keep an unguarded context reachable through
    // `findActiveSession` and the takeover registry for the rest of its life
    // — no SSRF guard on anything it navigates to.
    //
    // Forget FIRST, then close: the close is awaited, and an unguarded
    // session must not be reachable across that await.
    forgetSession(session);
    await session.close();
    throw err;
  }
  return session;
}

/**
 * D5 — relaunch a session IN PLACE, guarded. The same BrowserSession object
 * survives so the policy-only map key stays valid and `findActiveSession`
 * keeps finding it across a tier / proxy / profile switch.
 *
 * SECURITY: because the object survives, anything memoised per-session that
 * actually attaches to the CONTEXT is stale after this call. The SSRF route
 * guard is the one that matters, and it is installed on the replacement
 * context BEFORE a single field of `session` is swapped — a concurrent reader
 * can never observe the replacement in an unguarded state. There is
 * deliberately no unguarded relaunch to call by mistake: this is the only
 * exported one, and there is no other.
 *
 * ORDERING: the old backend is closed FIRST, which is not the safe order and
 * is not a choice. A persistent profile's user-data directory is held
 * exclusively by the live context, so a replacement wanting the same profile
 * cannot open it until this one is gone — launch-first would wait out the
 * 15s profile mutex and silently fall back to a logged-out ephemeral context
 * on every tier switch. The window that opens instead is closed the other
 * way: a replacement that fails to launch or to take its guard DROPS the
 * session from the map, so the next call builds a clean one rather than
 * `reusableSession` handing out a session pointing at a closed context
 * forever.
 */
export async function relaunchSessionWithRoute(
  session: BrowserSession,
  policy: NetworkPolicy,
  launch: SessionLaunchOptions,
): Promise<BrowserSession> {
  await session.close();

  let backend: LaunchedBackend;
  try {
    backend = await launchBackend(launch);
  } catch (err) {
    forgetSession(session);
    throw err;
  }
  try {
    await installRouteGuard(backend.context, policy);
  } catch (err) {
    await discardBackend(backend);
    forgetSession(session);
    throw err;
  }

  session.browser = backend.browser;
  session.context = backend.context;
  session.page = backend.page;
  session.refs = new Map();
  session.lastUrl = '';
  session.consoleLogs = [];
  session.tier = launch.tier ?? 'stock';
  session.proxyKey = launch.proxy?.server;
  session.profileKey = backend.profileKey;
  session.requestedProfileKey = launch.profile?.key;
  session.headed = !(launch.headless ?? true);
  session.profileWarning = backend.profileWarning;
  session.pendingWarnings = backend.warnings;
  session.releaseProfile = backend.releaseProfile;
  session.lastActiveAt = Date.now();
  attachPageListeners(session, backend.page);
  return session;
}

/**
 * Close every session for `sessionId` — EXCEPT one somebody else is using (B1).
 *
 * This is the dangerous half of the takeover story. Every caller of this
 * function is a cleanup path: `browse_url`'s abort listener, which fires
 * asynchronously in the middle of a navigation, and the navigation-failure
 * `catch` in `browse_url` / `browser_navigate`. A takeover that begins while a
 * navigation is in flight would otherwise have the browser destroyed under the
 * person using it by a handler that was scheduled before the lock existed —
 * "the browser cannot close underneath the human" broken by the agent's own
 * tidying up.
 *
 * TWO holders can be underneath, and both are checked here — the same pair
 * `sweepIdleSessions` checks, for the same reason:
 *
 *   `session.takeover`  — a HUMAN is driving. Set synchronously, so a lane
 *                         that opened before the lock is not the risk.
 *   `leaseHeldByOthers` — a SIBLING TOOL is driving: a click mid-navigation,
 *                         a screenshot mid-snapshot. `browse_url` failing does
 *                         not make `browser_click`'s page disposable, and the
 *                         two tools reach this function from opposite ends of
 *                         one session.
 *
 * `ownLease` is the caller's OWN lease, and passing it is what keeps this a
 * skip rather than a refusal to clean up after itself: cleanup runs inside the
 * lease on purpose (releasing first would let a takeover's exclusive lease land
 * mid-teardown), so without it every caller would recognise itself as the
 * sibling it must not close under. Omitting it fails safe — the session is left
 * for the idle sweeper, not closed under anyone.
 *
 * The check is here rather than at the call sites because the call sites cannot
 * know: the decision is made after they scheduled the call. Skipping is the
 * same trade `sweepIdleSessions` and `getOrCreateSession`'s policy-change
 * teardown already make — refusing to clean up beats closing a window someone
 * is typing into. The skipped session is not leaked: once the takeover clears
 * the flag and the last lease releases, the idle sweeper collects it on the
 * ordinary schedule.
 *
 * `closeAllSessions` / `cleanupOnExit` deliberately do NOT skip: the process is
 * going away, and the same abort that triggers them cancels the clarify the
 * takeover is parked on.
 */
export async function closeSession(
  sessionId: string,
  ownLease?: (() => void) | null,
): Promise<void> {
  for (const [k, s] of sessions.entries()) {
    if (k.startsWith(`${sessionId}::`) || k === sessionId) {
      if (s.takeover) continue;
      if (leaseHeldByOthers(sessionIdOf(k), ownLease)) continue;
      sessions.delete(k);
      await s.close();
    }
  }
}

/**
 * Close ALL browser sessions. Use when the agent loop aborts or the process
 * is shutting down — prevents headless Chromium instances from leaking.
 */
export async function closeAllSessions(): Promise<void> {
  const entries = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(entries.map((s) => s.close()));
}

/** The sessionId half of a map key (`sessionId::fingerprint`). */
function sessionIdOf(key: string): string {
  const cut = key.lastIndexOf('::');
  return cut === -1 ? key : key.slice(0, cut);
}

/**
 * Close sessions untouched for `idleTimeoutMs`. Sessions with `takeover` set
 * are SKIPPED — a human is driving that browser, and closing it under them is
 * exactly the failure this check exists to prevent.
 *
 * Sessions with a LIVE LEASE — shared (an agent operation in flight) or
 * exclusive (a takeover draining) — are skipped for the same reason.
 * `lastActiveAt` is stamped when a tool FINDS the session, not while its
 * operation runs, so at the allowed 60s minimum `idleTimeoutMs` the sweep
 * would otherwise close the browser mid-navigation, mid-screenshot, or in the
 * middle of a vision tool's LLM call — `navigationTimeoutMs` alone permits a
 * ten-minute operation.
 *
 * Skipping DEFERS the reap, it does not exempt: nothing here refreshes the
 * clock, so once the last holder releases, the next sweep sees the same
 * expired `lastActiveAt` and collects the session normally.
 *
 * Returns the number of sessions closed.
 */
export async function sweepIdleSessions(
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): Promise<number> {
  const cutoff = Date.now() - idleTimeoutMs;
  const stale = [...sessions.entries()].filter(
    ([k, s]) => !s.takeover && activeLeaseCount(sessionIdOf(k)) === 0 && s.lastActiveAt <= cutoff,
  );
  for (const [k] of stale) sessions.delete(k);
  await Promise.allSettled(stale.map(([, s]) => s.close()));
  return stale.length;
}

/** Start the idle sweeper. Returns a stop function. */
export function startIdleSweeper(idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS): () => void {
  const timer = setInterval(
    () => {
      void sweepIdleSessions(idleTimeoutMs);
    },
    Math.min(idleTimeoutMs, 60_000),
  );
  timer.unref();
  return () => clearInterval(timer);
}

export function isPlaywrightInstalled(): boolean {
  try {
    import.meta.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

/**
 * @internal Cleanup all sessions on process exit. Awaits `context.close()` —
 * a persistent context flushes its profile (cookies, storage) on close, so
 * closing only the browser handle loses the login the profile exists for.
 * Exported for tests.
 */
export async function cleanupOnExit(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(all.map((s) => s.close()));
}

process.on('SIGTERM', () => {
  void cleanupOnExit();
});
process.on('SIGINT', () => {
  void cleanupOnExit();
});
