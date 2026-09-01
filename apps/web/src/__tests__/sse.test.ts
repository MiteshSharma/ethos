import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  subscribeToActivity as SubscribeToActivity,
  subscribeToSession as SubscribeToSession,
} from '../sse';

// Minimal fake EventSource: records every instance, exposes a `close` spy,
// and lets the test push a `message` event through whatever handler the
// subject assigned to `onmessage`.
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  emit(data: unknown, lastEventId = ''): void {
    this.onmessage?.({ data: JSON.stringify(data), lastEventId });
  }
}

// A schema-valid SseEvent payload (the `notification` variant from
// @ethosagent/web-contracts is the simplest discriminated-union member).
const sampleEvent = { type: 'notification' as const, message: 'hi' };

// The shared-connection registry is module-level state, so each test gets a
// fresh copy of the module to stay isolated.
let subscribeToSession: typeof SubscribeToSession;
let subscribeToActivity: typeof SubscribeToActivity;

beforeEach(async () => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  vi.resetModules();
  ({ subscribeToSession, subscribeToActivity } = await import('../sse'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeToSession connection sharing', () => {
  it('creates exactly one EventSource for three subscribers to the same session', () => {
    subscribeToSession('s1', { onEvent: vi.fn() });
    subscribeToSession('s1', { onEvent: vi.fn() });
    subscribeToSession('s1', { onEvent: vi.fn() });

    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('fans an emitted message out to every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    subscribeToSession('s1', { onEvent: a });
    subscribeToSession('s1', { onEvent: b });
    subscribeToSession('s1', { onEvent: c });

    const source = FakeEventSource.instances[0];
    source?.emit(sampleEvent, '7');

    expect(a).toHaveBeenCalledWith(sampleEvent, 7);
    expect(b).toHaveBeenCalledWith(sampleEvent, 7);
    expect(c).toHaveBeenCalledWith(sampleEvent, 7);
  });

  it('closes the EventSource only when the last subscriber leaves', () => {
    const s1 = subscribeToSession('s1', { onEvent: vi.fn() });
    const s2 = subscribeToSession('s1', { onEvent: vi.fn() });
    const s3 = subscribeToSession('s1', { onEvent: vi.fn() });

    const source = FakeEventSource.instances[0];

    s1.close();
    s2.close();
    expect(source?.close).not.toHaveBeenCalled();

    s3.close();
    expect(source?.close).toHaveBeenCalledTimes(1);
  });

  it('opens a distinct EventSource for a different session', () => {
    subscribeToSession('s1', { onEvent: vi.fn() });
    subscribeToSession('s2', { onEvent: vi.fn() });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]?.url).not.toBe(FakeEventSource.instances[1]?.url);
  });

  it('re-opens a fresh EventSource after all subscribers close', () => {
    const s1 = subscribeToSession('s1', { onEvent: vi.fn() });
    s1.close();
    expect(FakeEventSource.instances).toHaveLength(1);

    subscribeToSession('s1', { onEvent: vi.fn() });
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});

// The merged activity stream shares the pooling machinery above but carries a
// different payload (an `ActivityEvent` envelope, not a bare `SseEvent`) and a
// different registry key, so global and per-agent views are distinct
// connections rather than one that keeps re-scoping itself.
const sampleActivity = {
  sessionId: 's1',
  personalityId: 'agent-a',
  event: sampleEvent,
};

describe('subscribeToActivity', () => {
  it('opens the global feed with no personalityId param', () => {
    subscribeToActivity(null, { onEvent: vi.fn() });

    const url = FakeEventSource.instances[0]?.url ?? '';
    expect(url).toContain('/sse/activity');
    expect(url).not.toContain('personalityId');
  });

  it('scopes to one agent via the query param', () => {
    subscribeToActivity('agent-a', { onEvent: vi.fn() });

    expect(FakeEventSource.instances[0]?.url).toContain('personalityId=agent-a');
  });

  it('carries sinceSeq so a remount resumes instead of restarting from now', () => {
    subscribeToActivity(null, { onEvent: vi.fn(), sinceSeq: 42 });

    expect(FakeEventSource.instances[0]?.url).toContain('lastEventId=42');
  });

  it('parses frames as ActivityEvent envelopes and reports the seq', () => {
    const onEvent = vi.fn();
    subscribeToActivity(null, { onEvent });

    FakeEventSource.instances[0]?.emit(sampleActivity, '9');

    expect(onEvent).toHaveBeenCalledWith(sampleActivity, 9);
  });

  it('surfaces a bare SseEvent frame as a parse error, not a typed event', () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    subscribeToActivity(null, { onEvent, onError });

    FakeEventSource.instances[0]?.emit(sampleEvent, '1');

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('shares one connection per scope and keeps scopes apart', () => {
    subscribeToActivity(null, { onEvent: vi.fn() });
    subscribeToActivity(null, { onEvent: vi.fn() });
    expect(FakeEventSource.instances).toHaveLength(1);

    subscribeToActivity('agent-a', { onEvent: vi.fn() });
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('does not collide with a session connection of the same name', () => {
    subscribeToActivity('activity', { onEvent: vi.fn() });
    subscribeToSession('activity', { onEvent: vi.fn() });

    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('closes the EventSource only when the last subscriber leaves', () => {
    const a = subscribeToActivity(null, { onEvent: vi.fn() });
    const b = subscribeToActivity(null, { onEvent: vi.fn() });
    const source = FakeEventSource.instances[0];

    a.close();
    expect(source?.close).not.toHaveBeenCalled();

    b.close();
    expect(source?.close).toHaveBeenCalledTimes(1);
  });
});
