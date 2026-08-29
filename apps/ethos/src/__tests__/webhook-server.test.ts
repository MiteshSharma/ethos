import type { AddressInfo } from 'node:net';
import { createCapturingAdapter } from '@ethosagent/gateway';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWebhookServer,
  type PrefilterRunner,
  type WebhookConfig,
  type WebhookGateway,
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
  opts: { webhooks?: Record<string, WebhookConfig>; runPrefilter?: PrefilterRunner } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const s = createWebhookServer(
      0,
      '127.0.0.1',
      gateway,
      opts.webhooks ?? webhooks,
      createCapturingAdapter,
      opts.runPrefilter,
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
