import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createCapturingAdapter } from '@ethosagent/gateway';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWebhookServer,
  type DeliveryRelay,
  type PrefilterRunner,
  type WebhookConfig,
  type WebhookDeliveryTarget,
  type WebhookGateway,
  type WebhookRejectionReason,
  type WebhookRejectionSink,
  type WebhookServer,
} from '../webhook-server';

const webhooks = { hook1: { personalityId: 'researcher', secret: 's3cret' } };

let server: WebhookServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function start(
  gateway: WebhookGateway,
  opts: {
    webhooks?: Record<string, WebhookConfig>;
    runPrefilter?: PrefilterRunner;
    relayTargets?: DeliveryRelay;
    onRejected?: WebhookRejectionSink;
    now?: () => number;
  } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const s = createWebhookServer(
      0,
      '127.0.0.1',
      gateway,
      opts.webhooks ?? webhooks,
      createCapturingAdapter,
      opts.runPrefilter,
      opts.relayTargets,
      {
        ...(opts.onRejected ? { onRejected: opts.onRejected } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      },
    );
    server = s;
    s.once('listening', () => {
      const addr = s.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

function post(
  port: number,
  path: string,
  body: string,
  auth?: string,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = auth;
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body }).then(
    async (res) => ({ status: res.status, body: await res.text() }),
  );
}

/** `post()` plus arbitrary extra request headers — a separate helper so the
 *  existing positional `post()` calls keep working unchanged. */
function postWithHeaders(
  port: number,
  path: string,
  body: string,
  auth: string | undefined,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (auth) headers.Authorization = auth;
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body }).then(
    async (res) => ({ status: res.status, body: await res.text() }),
  );
}

// Echoing gateway — drives the capturing adapter the same way handleMessage does.
const echoGateway: WebhookGateway = {
  handleMessage: async (_msg: InboundMessage, adapter: PlatformAdapter) => {
    await adapter.send('chat', { text: 'hello from agent' });
  },
};

describe('createWebhookServer', () => {
  it('200 + reply for a valid request', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: 'hello from agent' });
  });

  it('401 for a bad secret', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer wrong',
    );
    expect(res.status).toBe(401);
  });

  it('401 for a missing secret', async () => {
    const port = await start(echoGateway);
    const res = await post(port, '/webhook/hook1', JSON.stringify({ prompt: 'hi' }));
    expect(res.status).toBe(401);
  });

  it('404 for an unknown hookId', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/nope',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(404);
  });

  it('400 for an empty prompt', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: '  ' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(400);
  });

  it('400 for a malformed body shape (prompt not a string)', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 123 }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(400);
  });

  it('keeps working when no prefilter is configured and no runner is injected', async () => {
    const port = await start(echoGateway);
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(200);
  });

  it('504 when the gateway never resolves', async () => {
    const prev = process.env.ETHOS_WEBHOOK_TIMEOUT_MS;
    process.env.ETHOS_WEBHOOK_TIMEOUT_MS = '50';
    const hangGateway: WebhookGateway = {
      handleMessage: () => new Promise<void>(() => {}),
    };
    try {
      const port = await start(hangGateway);
      const res = await post(
        port,
        '/webhook/hook1',
        JSON.stringify({ prompt: 'hi' }),
        'Bearer s3cret',
      );
      expect(res.status).toBe(504);
    } finally {
      if (prev === undefined) delete process.env.ETHOS_WEBHOOK_TIMEOUT_MS;
      else process.env.ETHOS_WEBHOOK_TIMEOUT_MS = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Prefilter + ack mode (gap-event-triggers Phase 4)
// ---------------------------------------------------------------------------

/** Gateway that records every InboundMessage it receives. */
function recordingGateway() {
  const calls: InboundMessage[] = [];
  const gateway: WebhookGateway = {
    handleMessage: async (msg: InboundMessage, adapter: PlatformAdapter) => {
      calls.push(msg);
      await adapter.send('chat', { text: 'hello from agent' });
    },
  };
  return { gateway, calls };
}

function prefilterHooks(extra: Partial<WebhookConfig> = {}): Record<string, WebhookConfig> {
  return {
    hook1: { personalityId: 'researcher', secret: 's3cret', prefilter: 'gate.sh', ...extra },
  };
}

/** Prefilter runner stub — records invocations, returns a fixed outcome. */
function stubRunner(outcome: Awaited<ReturnType<PrefilterRunner>>) {
  const calls: Array<{ file: string; stdin: string; timeoutSeconds: number }> = [];
  const run: PrefilterRunner = async (file, opts) => {
    calls.push({ file, stdin: opts.stdin, timeoutSeconds: opts.timeoutSeconds });
    return outcome;
  };
  return { run, calls };
}

describe('createWebhookServer — prefilter', () => {
  it('exit 78 → 200 {"filtered": true} and zero handleMessage calls', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 78, stdout: '' });
    const port = await start(gateway, { webhooks: prefilterHooks(), runPrefilter: runner.run });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ filtered: true });
    expect(calls).toHaveLength(0);
  });

  it('exit 0 with stdout replaces the prompt', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 0, stdout: 'replaced prompt\n' });
    const port = await start(gateway, { webhooks: prefilterHooks(), runPrefilter: runner.run });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'original' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('replaced prompt');
  });

  it('exit 0 with empty stdout keeps the body-derived prompt', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 0, stdout: '  \n' });
    const port = await start(gateway, { webhooks: prefilterHooks(), runPrefilter: runner.run });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'original' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('original');
  });

  it('non-zero exit → 500 {"error": "prefilter failed"} and no turn', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 1, stdout: 'should be ignored' });
    const port = await start(gateway, { webhooks: prefilterHooks(), runPrefilter: runner.run });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'prefilter failed' });
    expect(calls).toHaveLength(0);
  });

  it('script failure (timeout / spawn error) → 500 and no turn', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({
      ok: false,
      exitCode: null,
      stdout: '',
      failure: 'script "gate.sh" timed out after 30s',
    });
    const port = await start(gateway, { webhooks: prefilterHooks(), runPrefilter: runner.run });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(0);
  });

  it('prefilter configured but no runner wired → 500 fail-closed', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: prefilterHooks() });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(0);
  });

  it('receives the raw request body on stdin with the configured timeout', async () => {
    const { gateway } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 0, stdout: 'go' });
    const port = await start(gateway, {
      webhooks: prefilterHooks({ prefilterTimeoutSeconds: 5 }),
      runPrefilter: runner.run,
    });
    const rawBody = '{"event":"push","ref":"main"}';
    await post(port, '/webhook/hook1', rawBody, 'Bearer s3cret');
    expect(runner.calls).toEqual([{ file: 'gate.sh', stdin: rawBody, timeoutSeconds: 5 }]);
  });

  it('defaults the prefilter timeout to 30 seconds', async () => {
    const { gateway } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 0, stdout: 'go' });
    const port = await start(gateway, { webhooks: prefilterHooks(), runPrefilter: runner.run });
    await post(port, '/webhook/hook1', JSON.stringify({ prompt: 'hi' }), 'Bearer s3cret');
    expect(runner.calls[0]?.timeoutSeconds).toBe(30);
  });

  it('accepts a non-JSON body when the prefilter supplies the prompt', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 0, stdout: 'transformed' });
    const port = await start(gateway, { webhooks: prefilterHooks(), runPrefilter: runner.run });
    const res = await post(port, '/webhook/hook1', 'not json at all', 'Bearer s3cret');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('transformed');
  });

  it('401 before the prefilter runs — a bad bearer never executes the script', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 0, stdout: 'go' });
    const port = await start(gateway, { webhooks: prefilterHooks(), runPrefilter: runner.run });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer wrong',
    );
    expect(res.status).toBe(401);
    expect(runner.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe('createWebhookServer — ack mode', () => {
  it('202 {"accepted": true} immediately, turn still runs detached', async () => {
    const calls: InboundMessage[] = [];
    let resolveInvoked!: () => void;
    const invoked = new Promise<void>((r) => {
      resolveInvoked = r;
    });
    const gateway: WebhookGateway = {
      handleMessage: async (msg: InboundMessage) => {
        calls.push(msg);
        resolveInvoked();
      },
    };
    const port = await start(gateway, {
      webhooks: { hook1: { personalityId: 'researcher', secret: 's3cret', mode: 'ack' } },
    });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ accepted: true });
    await invoked;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('hi');
  });

  it('ack + prefilter exit 78 → 200 filtered, no 202, no turn', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 78, stdout: '' });
    const port = await start(gateway, {
      webhooks: prefilterHooks({ mode: 'ack' }),
      runPrefilter: runner.run,
    });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ filtered: true });
    expect(calls).toHaveLength(0);
  });

  it('ack + failed prefilter → 500, no turn', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 2, stdout: '' });
    const port = await start(gateway, {
      webhooks: prefilterHooks({ mode: 'ack' }),
      runPrefilter: runner.run,
    });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(0);
  });
});

describe('createWebhookServer — in-flight sync requests', () => {
  /** The live server handle `start()` stashed, for reading the counter. */
  function handle(): WebhookServer {
    if (!server) throw new Error('server not started');
    return server;
  }

  it('is 0 when idle, 1 while a sync turn is held, 0 again after the reply', async () => {
    let releaseTurn!: () => void;
    const parked = new Promise<void>((r) => {
      releaseTurn = r;
    });
    let resolveInvoked!: () => void;
    const invoked = new Promise<void>((r) => {
      resolveInvoked = r;
    });
    const gateway: WebhookGateway = {
      handleMessage: async (_msg: InboundMessage, adapter: PlatformAdapter) => {
        resolveInvoked();
        await parked;
        await adapter.send('chat', { text: 'done' });
      },
    };
    const port = await start(gateway);
    expect(handle().inFlightSyncRequests()).toBe(0);

    const res = post(port, '/webhook/hook1', JSON.stringify({ prompt: 'hi' }), 'Bearer s3cret');
    await invoked;
    expect(handle().inFlightSyncRequests()).toBe(1);

    releaseTurn();
    expect((await res).status).toBe(200);
    expect(handle().inFlightSyncRequests()).toBe(0);
  });

  it('decrements when the handler throws', async () => {
    const gateway: WebhookGateway = {
      handleMessage: async () => {
        throw new Error('boom');
      },
    };
    const port = await start(gateway);
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(500);
    expect(handle().inFlightSyncRequests()).toBe(0);
  });

  it('does not count ack-mode requests — the gateway owns that turn', async () => {
    let resolveInvoked!: () => void;
    const invoked = new Promise<void>((r) => {
      resolveInvoked = r;
    });
    const gateway: WebhookGateway = {
      handleMessage: async () => {
        resolveInvoked();
        await new Promise<void>(() => {}); // never settles
      },
    };
    const port = await start(gateway, {
      webhooks: { hook1: { personalityId: 'researcher', secret: 's3cret', mode: 'ack' } },
    });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(202);
    await invoked;
    expect(handle().inFlightSyncRequests()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Event filtering (webhook-subscriptions Phase 1)
// ---------------------------------------------------------------------------

function eventHooks(extra: Partial<WebhookConfig> = {}): Record<string, WebhookConfig> {
  return {
    hook1: {
      personalityId: 'researcher',
      secret: 's3cret',
      events: ['push', 'issue.opened'],
      ...extra,
    },
  };
}

describe('createWebhookServer — event filtering', () => {
  it('runs the turn when the default header names a listed event', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: eventHooks() });
    const res = await postWithHeaders(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
      { 'x-event-type': 'push' },
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: 'hello from agent' });
    expect(calls).toHaveLength(1);
  });

  it('200 {filtered, reason: "event"} and no turn when the header event is not listed', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: eventHooks() });
    const res = await postWithHeaders(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
      { 'x-event-type': 'deleted' },
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ filtered: true, reason: 'event' });
    expect(calls).toHaveLength(0);
  });

  it('honors a custom eventHeader', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, {
      webhooks: eventHooks({ eventHeader: 'X-GitHub-Event' }),
    });
    const res = await postWithHeaders(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
      { 'X-GitHub-Event': 'push', 'x-event-type': 'deleted' },
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('falls back to the default "event" body field when no header is sent', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: eventHooks() });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ event: 'push', prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('reads a custom dotted eventField', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: eventHooks({ eventField: 'meta.event' }) });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ meta: { event: 'issue.opened' }, prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('filters on a body field that WebhookBody would strip — proves it reads pre-zod raw', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: eventHooks() });
    // `event` is not on the WebhookBody schema, so `.parse().data` never sees
    // it; only the pre-zod object carries it.
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ event: 'deleted', prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ filtered: true, reason: 'event' });
    expect(calls).toHaveLength(0);
  });

  it('400 cannot determine event type for a non-JSON body with no header', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: eventHooks() });
    const res = await post(port, '/webhook/hook1', 'not json at all', 'Bearer s3cret');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'cannot determine event type' });
    expect(calls).toHaveLength(0);
  });

  it('400 cannot determine event type when the body carries no event field', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: eventHooks() });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'cannot determine event type' });
    expect(calls).toHaveLength(0);
  });

  it('ignores a non-string terminal value at the event path', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: eventHooks() });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ event: 42, prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'cannot determine event type' });
    expect(calls).toHaveLength(0);
  });

  it('leaves behavior unchanged when no events are configured', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway);
    const ok = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ reply: 'hello from agent' });
    expect(calls).toHaveLength(1);

    const bad = await post(port, '/webhook/hook1', 'not json at all', 'Bearer s3cret');
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({ error: 'invalid JSON body' });
    expect(calls).toHaveLength(1);
  });

  it('filters by event before the prefilter runs — the script is never spawned', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 0, stdout: 'go' });
    const port = await start(gateway, {
      webhooks: eventHooks({ prefilter: 'gate.sh' }),
      runPrefilter: runner.run,
    });
    const res = await postWithHeaders(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
      { 'x-event-type': 'deleted' },
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ filtered: true, reason: 'event' });
    expect(runner.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — delivery targets + deliver-only relay mode.
// ---------------------------------------------------------------------------

/** Records every relay invocation; resolves `next` on each one so an ack-mode
 *  test can await the detached fan-out instead of racing a timer. */
function stubRelay(opts: { rejects?: boolean } = {}) {
  const calls: Array<{ targets: readonly WebhookDeliveryTarget[]; content: string; ctx: unknown }> =
    [];
  let signal: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const relay: DeliveryRelay = async (targets, content, ctx) => {
    calls.push({ targets, content, ctx });
    signal();
    if (opts.rejects) throw new Error('relay exploded');
    return targets.map(() => ({ ok: true }));
  };
  return { relay, calls, next };
}

const logTarget: WebhookDeliveryTarget = { type: 'log' };

function deliverOnlyHooks(extra: Partial<WebhookConfig> = {}): Record<string, WebhookConfig> {
  return {
    hook1: {
      personalityId: 'researcher',
      secret: 's3cret',
      deliverOnly: true,
      deliver: [logTarget],
      ...extra,
    },
  };
}

describe('createWebhookServer — deliverOnly', () => {
  it('never dispatches a turn, relays the raw body, and answers 200 {delivered}', async () => {
    const { gateway, calls } = recordingGateway();
    const relay = stubRelay();
    const port = await start(gateway, {
      webhooks: deliverOnlyHooks(),
      relayTargets: relay.relay,
    });
    const body = JSON.stringify({ prompt: 'hi', extra: 1 });
    const res = await post(port, '/webhook/hook1', body, 'Bearer s3cret');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ delivered: [{ ok: true }] });
    expect(calls).toHaveLength(0);
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0]?.content).toBe(body);
    expect(relay.calls[0]?.targets).toEqual([logTarget]);
    expect(relay.calls[0]?.ctx).toEqual({ hookId: 'hook1', sessionKey: 'hook1' });
  });

  it('relays the prefiltered stdout rather than the raw body when a prefilter rewrites it', async () => {
    const { gateway, calls } = recordingGateway();
    const relay = stubRelay();
    const runner = stubRunner({ ok: true, exitCode: 0, stdout: 'rewritten by the script\n' });
    const port = await start(gateway, {
      webhooks: deliverOnlyHooks({ prefilter: 'gate.sh' }),
      runPrefilter: runner.run,
      relayTargets: relay.relay,
    });
    const res = await post(port, '/webhook/hook1', 'raw payload', 'Bearer s3cret');

    expect(res.status).toBe(200);
    // The prefilter still runs in this mode — a script may gate or transform
    // even when no model will see the result.
    expect(runner.calls).toHaveLength(1);
    expect(relay.calls[0]?.content).toBe('rewritten by the script');
    expect(calls).toHaveLength(0);
  });

  it('accepts a non-JSON body and a JSON body with no prompt/text (prompt check skipped)', async () => {
    const { gateway, calls } = recordingGateway();
    const relay = stubRelay();
    const port = await start(gateway, {
      webhooks: deliverOnlyHooks(),
      relayTargets: relay.relay,
    });

    const nonJson = await post(port, '/webhook/hook1', 'not json at all', 'Bearer s3cret');
    expect(nonJson.status).toBe(200);
    expect(relay.calls[0]?.content).toBe('not json at all');

    const noPrompt = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ event: 'push' }),
      'Bearer s3cret',
    );
    expect(noPrompt.status).toBe(200);
    expect(relay.calls[1]?.content).toBe(JSON.stringify({ event: 'push' }));
    expect(calls).toHaveLength(0);
  });

  it('500s when no relay is wired, rather than silently accepting', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: deliverOnlyHooks() });
    const res = await post(port, '/webhook/hook1', 'payload', 'Bearer s3cret');

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'no delivery relay wired' });
    expect(calls).toHaveLength(0);
  });

  it('still honours the event filter ahead of the relay', async () => {
    const relay = stubRelay();
    const { gateway } = recordingGateway();
    const port = await start(gateway, {
      webhooks: deliverOnlyHooks({ events: ['push'] }),
      relayTargets: relay.relay,
    });
    const res = await postWithHeaders(port, '/webhook/hook1', '{}', 'Bearer s3cret', {
      'x-event-type': 'deleted',
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ filtered: true, reason: 'event' });
    expect(relay.calls).toHaveLength(0);
  });
});

describe('createWebhookServer — deliver alongside the normal agent path', () => {
  const deliverHooks = (extra: Partial<WebhookConfig> = {}): Record<string, WebhookConfig> => ({
    hook1: { personalityId: 'researcher', secret: 's3cret', deliver: [logTarget], ...extra },
  });

  it('sync: returns the reply AND relays it', async () => {
    const { gateway, calls } = recordingGateway();
    const relay = stubRelay();
    const port = await start(gateway, { webhooks: deliverHooks(), relayTargets: relay.relay });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: 'hello from agent' });
    expect(calls).toHaveLength(1);
    // Fan-out is detached from the response, so wait for it explicitly.
    await relay.next;
    expect(relay.calls).toHaveLength(1);
    expect(relay.calls[0]?.content).toBe('hello from agent');
  });

  it('ack: 202 immediately, and the reply reaches the targets once the turn finishes', async () => {
    const { gateway, calls } = recordingGateway();
    const relay = stubRelay();
    const port = await start(gateway, {
      webhooks: deliverHooks({ mode: 'ack' }),
      relayTargets: relay.relay,
    });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );

    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ accepted: true });
    // Before `deliver`, an ack-mode reply was generated and then discarded.
    await relay.next;
    expect(calls).toHaveLength(1);
    expect(relay.calls[0]?.content).toBe('hello from agent');
  });

  it('a rejecting relay does not turn a successful sync reply into a 500', async () => {
    const { gateway } = recordingGateway();
    const relay = stubRelay({ rejects: true });
    const port = await start(gateway, { webhooks: deliverHooks(), relayTargets: relay.relay });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: 'hello from agent' });
    await relay.next;
  });

  it('never calls the relay when no deliver/deliverOnly is configured (regression)', async () => {
    const { gateway, calls } = recordingGateway();
    const relay = stubRelay();
    const port = await start(gateway, { relayTargets: relay.relay });
    const res = await post(
      port,
      '/webhook/hook1',
      JSON.stringify({ prompt: 'hi' }),
      'Bearer s3cret',
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: 'hello from agent' });
    expect(calls).toHaveLength(1);
    expect(relay.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// HMAC payload signing (webhook-subscriptions Phase 3)
// ---------------------------------------------------------------------------

const SIGNING_SECRET = 'signing-key';
const OLD_SIGNING_SECRET = 'old-signing-key';

/** Sign exactly the bytes that will be sent — the server verifies the raw
 *  body, so the test must too. */
function sign(body: string, secret = SIGNING_SECRET, algorithm = 'sha256'): string {
  return createHmac(algorithm, secret).update(body).digest('hex');
}

function hmacHooks(hmac: Partial<WebhookConfig['hmac']> = {}): Record<string, WebhookConfig> {
  return {
    hook1: {
      personalityId: 'researcher',
      secret: 's3cret',
      hmac: { secret: SIGNING_SECRET, ...hmac },
    },
  };
}

describe('createWebhookServer — HMAC signing', () => {
  const body = JSON.stringify({ prompt: 'hi' });

  it('matches a known HMAC-SHA256 test vector', () => {
    // Hard-coded so a change to the digest encoding (hex → base64, say) fails
    // here rather than silently at a sender.
    expect(sign('{"prompt":"hi"}')).toBe(
      '8cd2934232ccd7e3e9201b7fdf0f3495235ce9fd5249df1b65c6d245e389f7b5',
    );
  });

  it('bearer ok + signature ok → 200 and the turn runs', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: hmacHooks() });
    const res = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer s3cret', {
      'x-signature': sign(body),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ reply: 'hello from agent' });
    expect(calls).toHaveLength(1);
  });

  it('bearer ok + signature bad → 401 invalid signature, no turn', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: hmacHooks() });
    const res = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer s3cret', {
      'x-signature': sign(body, 'not-the-secret'),
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid signature' });
    expect(calls).toHaveLength(0);
  });

  it('bearer bad + signature ok → 401 unauthorized (bearer is still mandatory)', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: hmacHooks() });
    const res = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer wrong', {
      'x-signature': sign(body),
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
    expect(calls).toHaveLength(0);
  });

  it('bearer bad + signature bad → 401 unauthorized (bearer rejects first)', async () => {
    const { gateway } = recordingGateway();
    const port = await start(gateway, { webhooks: hmacHooks() });
    const res = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer wrong', {
      'x-signature': sign(body, 'not-the-secret'),
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
  });

  it('401 when the signature header is missing entirely', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: hmacHooks() });
    const res = await post(port, '/webhook/hook1', body, 'Bearer s3cret');
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid signature' });
    expect(calls).toHaveLength(0);
  });

  it('401 when the body differs from the signed body by one byte', async () => {
    const { gateway } = recordingGateway();
    const port = await start(gateway, { webhooks: hmacHooks() });
    const signed = JSON.stringify({ prompt: 'hi' });
    const sent = JSON.stringify({ prompt: 'ho' });
    const res = await postWithHeaders(port, '/webhook/hook1', sent, 'Bearer s3cret', {
      'x-signature': sign(signed),
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid signature' });
  });

  it('accepts a signature made with previousSecret during a rotation window', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, {
      webhooks: hmacHooks({ secret: SIGNING_SECRET, previousSecret: OLD_SIGNING_SECRET }),
    });
    const res = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer s3cret', {
      'x-signature': sign(body, OLD_SIGNING_SECRET),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('still rejects a third, unrelated secret while previousSecret is set', async () => {
    const { gateway } = recordingGateway();
    const port = await start(gateway, {
      webhooks: hmacHooks({ secret: SIGNING_SECRET, previousSecret: OLD_SIGNING_SECRET }),
    });
    const res = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer s3cret', {
      'x-signature': sign(body, 'some-other-key'),
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid signature' });
  });

  it('honors a custom header name and ignores the default one', async () => {
    const { gateway } = recordingGateway();
    const port = await start(gateway, { webhooks: hmacHooks({ header: 'x-hub-signature-256' }) });
    const ok = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer s3cret', {
      'x-hub-signature-256': sign(body),
    });
    expect(ok.status).toBe(200);

    const wrongHeader = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer s3cret', {
      'x-signature': sign(body),
    });
    expect(wrongHeader.status).toBe(401);
  });

  it('verifies end to end under algorithm sha512', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { webhooks: hmacHooks({ algorithm: 'sha512' }) });
    const res = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer s3cret', {
      'x-signature': sign(body, SIGNING_SECRET, 'sha512'),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);

    // A sha256 digest under a sha512 hook is the wrong length and must not
    // throw out of `timingSafeEqual` — it is a plain rejection.
    const mismatched = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer s3cret', {
      'x-signature': sign(body),
    });
    expect(mismatched.status).toBe(401);
  });

  it('rejects rather than 500s when the configured algorithm is unknown', async () => {
    const { gateway } = recordingGateway();
    const port = await start(gateway, { webhooks: hmacHooks({ algorithm: 'not-a-digest' }) });
    const res = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer s3cret', {
      'x-signature': sign(body),
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid signature' });
  });

  it('no hmac configured → unchanged, signature header or not', async () => {
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway);
    const plain = await post(port, '/webhook/hook1', body, 'Bearer s3cret');
    expect(plain.status).toBe(200);
    const withGarbageSignature = await postWithHeaders(
      port,
      '/webhook/hook1',
      body,
      'Bearer s3cret',
      { 'x-signature': 'total-nonsense' },
    );
    expect(withGarbageSignature.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('rejects before the event filter and before the prefilter', async () => {
    const { gateway, calls } = recordingGateway();
    const runner = stubRunner({ ok: true, exitCode: 0, stdout: '' });
    const port = await start(gateway, {
      webhooks: {
        hook1: {
          personalityId: 'researcher',
          secret: 's3cret',
          hmac: { secret: SIGNING_SECRET },
          events: ['push'],
          prefilter: 'gate.sh',
        },
      },
      runPrefilter: runner.run,
    });
    // The event name is present and allowed, so only the bad signature can be
    // what rejects this — and it must do so before either later gate runs.
    const res = await postWithHeaders(port, '/webhook/hook1', body, 'Bearer s3cret', {
      'x-event-type': 'push',
      'x-signature': sign(body, 'not-the-secret'),
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid signature' });
    expect(runner.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting + rejection observability (webhook-subscriptions Phase 4)
// ---------------------------------------------------------------------------

/** A hand-cranked clock. The limiter refills by ELAPSED time, so every timing
 *  claim below is made by moving this, never by waiting. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advanceSeconds: (s: number) => {
      now += s * 1000;
    },
  };
}

/** `post()` that also surfaces response headers — `Retry-After` is half the
 *  429 contract. A separate helper so the existing `post()` calls stay put. */
function postFull(
  port: number,
  path: string,
  body: string,
  auth?: string,
): Promise<{ status: number; body: string; headers: Headers }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = auth;
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body }).then(
    async (res) => ({ status: res.status, body: await res.text(), headers: res.headers }),
  );
}

function rateLimitedHooks(
  rateLimit: WebhookConfig['rateLimit'],
  extra: Partial<WebhookConfig> = {},
): Record<string, WebhookConfig> {
  return {
    hook1: { personalityId: 'researcher', secret: 's3cret', rateLimit, ...extra },
  };
}

const HI = JSON.stringify({ prompt: 'hi' });

describe('createWebhookServer — rate limiting', () => {
  it('refuses the request past maxPerMinute with 429 + Retry-After', async () => {
    const clock = fakeClock();
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, {
      webhooks: rateLimitedHooks({ maxPerMinute: 2, lockoutSeconds: 120 }),
      now: clock.now,
    });

    expect((await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);
    expect((await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);

    const third = await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret');
    expect(third.status).toBe(429);
    expect(JSON.parse(third.body)).toEqual({ error: 'rate limited' });
    expect(third.headers.get('retry-after')).toBe('120');
    // The refused request never reached the agent.
    expect(calls).toHaveLength(2);
  });

  it('restores tokens once the window rolls over', async () => {
    const clock = fakeClock();
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, {
      webhooks: rateLimitedHooks({ maxPerMinute: 2 }),
      now: clock.now,
    });

    expect((await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);
    expect((await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);

    // One token per elapsed window — the ported algorithm adds the number of
    // whole windows that passed, it does not reset the bucket to full.
    clock.advanceSeconds(60);
    expect((await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);
    clock.advanceSeconds(60);
    expect((await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);
    expect(calls).toHaveLength(4);
  });

  it('holds the lockout even after tokens would have refilled, then releases', async () => {
    const clock = fakeClock();
    const { gateway } = recordingGateway();
    const port = await start(gateway, {
      webhooks: rateLimitedHooks({ maxPerMinute: 2, lockoutSeconds: 120 }),
      now: clock.now,
    });

    await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret');
    await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret');
    // Empties the bucket and arms the 120s lockout.
    expect((await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(429);

    // A full refill window has passed, but the lockout outranks it.
    clock.advanceSeconds(61);
    const stillLocked = await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret');
    expect(stillLocked.status).toBe(429);
    expect(stillLocked.headers.get('retry-after')).toBe('59');

    // Past the lockout, the elapsed-time refill applies and the hook is live.
    clock.advanceSeconds(60);
    expect((await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);
  });

  it('keeps one bucket per hookId — hammering A never throttles B', async () => {
    const clock = fakeClock();
    const { gateway } = recordingGateway();
    const port = await start(gateway, {
      webhooks: {
        hookA: {
          personalityId: 'researcher',
          secret: 's3cret',
          rateLimit: { maxPerMinute: 1, lockoutSeconds: 120 },
        },
        hookB: {
          personalityId: 'researcher',
          secret: 's3cret',
          rateLimit: { maxPerMinute: 1, lockoutSeconds: 120 },
        },
      },
      now: clock.now,
    });

    expect((await postFull(port, '/webhook/hookA', HI, 'Bearer s3cret')).status).toBe(200);
    expect((await postFull(port, '/webhook/hookA', HI, 'Bearer s3cret')).status).toBe(429);
    expect((await postFull(port, '/webhook/hookA', HI, 'Bearer s3cret')).status).toBe(429);

    expect((await postFull(port, '/webhook/hookB', HI, 'Bearer s3cret')).status).toBe(200);
  });

  it('rate-limits BEFORE the bearer check — a bad token still gets 429', async () => {
    const clock = fakeClock();
    const { gateway } = recordingGateway();
    const port = await start(gateway, {
      webhooks: rateLimitedHooks({ maxPerMinute: 1, lockoutSeconds: 120 }),
      now: clock.now,
    });

    expect((await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);
    // Ordering proof: were auth first, this would be a 401.
    const res = await postFull(port, '/webhook/hook1', HI, 'Bearer wrong');
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: 'rate limited' });
  });

  it('no rateLimit configured → unlimited (regression)', async () => {
    const clock = fakeClock();
    const { gateway, calls } = recordingGateway();
    const port = await start(gateway, { now: clock.now });
    for (let i = 0; i < 25; i++) {
      expect((await postFull(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);
    }
    expect(calls).toHaveLength(25);
  });
});

describe('createWebhookServer — rejection sink', () => {
  /** Collects `(hookId, reason)` pairs. */
  function sink() {
    const seen: Array<{ hookId: string; reason: WebhookRejectionReason }> = [];
    const onRejected: WebhookRejectionSink = (hookId, reason) => {
      seen.push({ hookId, reason });
    };
    return { onRejected, seen };
  }

  it('fires unknown_hook for a hookId that is not configured', async () => {
    const { gateway } = recordingGateway();
    const s = sink();
    const port = await start(gateway, { onRejected: s.onRejected });
    const res = await post(port, '/webhook/nope', HI, 'Bearer s3cret');
    expect(res.status).toBe(404);
    expect(s.seen).toEqual([{ hookId: 'nope', reason: 'unknown_hook' }]);
  });

  it('fires unauthorized for a bad bearer token', async () => {
    const { gateway } = recordingGateway();
    const s = sink();
    const port = await start(gateway, { onRejected: s.onRejected });
    expect((await post(port, '/webhook/hook1', HI, 'Bearer wrong')).status).toBe(401);
    expect(s.seen).toEqual([{ hookId: 'hook1', reason: 'unauthorized' }]);
  });

  it('fires invalid_signature for a bad HMAC', async () => {
    const { gateway } = recordingGateway();
    const s = sink();
    const port = await start(gateway, { webhooks: hmacHooks(), onRejected: s.onRejected });
    const res = await postWithHeaders(port, '/webhook/hook1', HI, 'Bearer s3cret', {
      'x-signature': sign(HI, 'not-the-secret'),
    });
    expect(res.status).toBe(401);
    expect(s.seen).toEqual([{ hookId: 'hook1', reason: 'invalid_signature' }]);
  });

  it('fires rate_limited once the bucket empties', async () => {
    const clock = fakeClock();
    const { gateway } = recordingGateway();
    const s = sink();
    const port = await start(gateway, {
      webhooks: rateLimitedHooks({ maxPerMinute: 1 }),
      onRejected: s.onRejected,
      now: clock.now,
    });
    expect((await post(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);
    expect((await post(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(429);
    expect(s.seen).toEqual([{ hookId: 'hook1', reason: 'rate_limited' }]);
  });

  it('fires unclassifiable_event when no event name can be determined', async () => {
    const { gateway } = recordingGateway();
    const s = sink();
    const port = await start(gateway, {
      webhooks: {
        hook1: { personalityId: 'researcher', secret: 's3cret', events: ['push'] },
      },
      onRejected: s.onRejected,
    });
    const res = await post(port, '/webhook/hook1', HI, 'Bearer s3cret');
    expect(res.status).toBe(400);
    expect(s.seen).toEqual([{ hookId: 'hook1', reason: 'unclassifiable_event' }]);
  });

  it('fires prefilter_failed when the prefilter script fails', async () => {
    const { gateway } = recordingGateway();
    const s = sink();
    const runner = stubRunner({ ok: true, exitCode: 3, stdout: '' });
    const port = await start(gateway, {
      webhooks: prefilterHooks(),
      runPrefilter: runner.run,
      onRejected: s.onRejected,
    });
    const res = await post(port, '/webhook/hook1', HI, 'Bearer s3cret');
    expect(res.status).toBe(500);
    expect(s.seen).toEqual([{ hookId: 'hook1', reason: 'prefilter_failed' }]);
  });

  it('does NOT fire for a non-POST request or an unmatched path', async () => {
    const { gateway } = recordingGateway();
    const s = sink();
    const port = await start(gateway, { onRejected: s.onRejected });

    const getRes = await fetch(`http://127.0.0.1:${port}/webhook/hook1`);
    expect(getRes.status).toBe(404);
    const strayRes = await post(port, '/not-a-webhook', HI, 'Bearer s3cret');
    expect(strayRes.status).toBe(404);

    // Neither carries a hookId to attribute — a scanner must not show up as
    // per-hook rejection traffic.
    expect(s.seen).toEqual([]);
  });

  it('does NOT fire on the accepted path or on an event-filtered 200', async () => {
    const { gateway } = recordingGateway();
    const s = sink();
    const port = await start(gateway, {
      webhooks: {
        hook1: { personalityId: 'researcher', secret: 's3cret', events: ['push'] },
      },
      onRejected: s.onRejected,
    });
    const accepted = await postWithHeaders(port, '/webhook/hook1', HI, 'Bearer s3cret', {
      'x-event-type': 'push',
    });
    expect(accepted.status).toBe(200);
    const filtered = await postWithHeaders(port, '/webhook/hook1', HI, 'Bearer s3cret', {
      'x-event-type': 'issue.closed',
    });
    expect(filtered.status).toBe(200);
    expect(s.seen).toEqual([]);
  });

  it('a throwing sink cannot break the request', async () => {
    const { gateway } = recordingGateway();
    const port = await start(gateway, {
      onRejected: () => {
        throw new Error('telemetry exploded');
      },
    });
    const res = await post(port, '/webhook/hook1', HI, 'Bearer wrong');
    // Still the normal rejection, not a 500 from the sink.
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
    // And the server is still serving.
    expect((await post(port, '/webhook/hook1', HI, 'Bearer s3cret')).status).toBe(200);
  });
});
