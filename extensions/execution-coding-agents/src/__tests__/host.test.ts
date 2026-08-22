// `runAcpHost`'s message framing/correlation and D-ACP3's degrade-when-
// unsupported path, driven end to end against a FAKE `docker` child process —
// no real Docker daemon, no real agent binary. `docker run`/`docker rm`
// resolve immediately; `docker exec` is a scripted double that speaks real
// ACP JSON-RPC back at the host exactly like a real adapter would.
//
// This is the host-level complement to `acp-connection.test.ts` (the pure
// framing layer) and `acp-gate.test.ts` (the pure gate/router translation) —
// here the three are proven wired together correctly.

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AgentEvent, SteerSink } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AcpGateAnswer } from '../acp-gate';
import type { SpawnFn } from '../host';
import { type AcpHostSpec, runAcpHost } from '../host';

const NOOP_STEER: SteerSink = { push: () => true, drain: () => [], depth: () => 0 };

// biome-ignore lint/suspicious/noExplicitAny: a hand-rolled JSON-RPC double; typing every message shape here would just re-derive acp-protocol.ts.
type Json = any;

/** A minimal fake `docker run -d` / `docker rm -f` child: closes immediately, code 0. */
function immediatelyClosingChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & {
    exitCode: number | null;
    signalCode: string | null;
  };
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (
    child as unknown as { stdin: { destroyed: boolean; write: () => boolean; end: () => void } }
  ).stdin = {
    destroyed: false,
    write: () => true,
    end: () => {},
  };
  child.exitCode = 0;
  child.signalCode = null;
  queueMicrotask(() => child.emit('close', 0));
  return child;
}

/**
 * A scripted `docker exec` double that speaks real ACP JSON-RPC framing back
 * at the host: register a handler per inbound METHOD (a request FROM the
 * host), or originate a request of its own (`request()`) and get called back
 * once the host answers it — exactly the request_permission round trip a
 * real agent drives.
 */
class ScriptedAcpAgent {
  readonly child: ChildProcess;
  readonly writes: string[] = [];
  private readonly stdout = new EventEmitter();
  private readonly stderr = new EventEmitter();
  private nextId = 1;
  private readonly pendingReplies = new Map<string, (result: Json) => void>();
  private readonly handlers = new Map<string, (msg: Json) => void>();

  constructor() {
    const child = new EventEmitter() as unknown as ChildProcess & {
      exitCode: number | null;
      signalCode: string | null;
      pid: number;
    };
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    (child as unknown as { stdout: EventEmitter }).stdout = this.stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = this.stderr;
    (
      child as unknown as {
        stdin: { destroyed: boolean; write: (d: string) => boolean; end: () => void };
      }
    ).stdin = {
      destroyed: false,
      write: (data: string): boolean => {
        this.writes.push(data);
        for (const line of data.split('\n').filter((l) => l.trim().length > 0)) {
          this.onLine(JSON.parse(line));
        }
        return true;
      },
      end: () => {},
    };
    (child as unknown as { kill: (sig?: string) => boolean }).kill = () => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('close', 0));
      return true;
    };
    this.child = child;
  }

  private onLine(msg: Json): void {
    if ('method' in msg && 'id' in msg) {
      this.handlers.get(msg.method)?.(msg);
      return;
    }
    if (!('method' in msg) && 'id' in msg) {
      const cb = this.pendingReplies.get(String(msg.id));
      if (cb) {
        this.pendingReplies.delete(String(msg.id));
        cb('error' in msg ? undefined : msg.result);
      }
    }
  }

  /** Reply to a host-originated request (`msg.id` from an inbound method call). */
  on(method: string, handler: (msg: Json) => void): void {
    this.handlers.set(method, handler);
  }

  reply(id: string | number, result: unknown): void {
    this.emit({ jsonrpc: '2.0', id, result });
  }

  /** Answer a host-originated request with a JSON-RPC error instead of a result. */
  replyError(id: string | number, message: string): void {
    this.emit({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }

  /** Agent-originated request; `onReply` fires once the host answers it. */
  request(method: string, params: unknown, onReply: (result: Json) => void): void {
    const id = `agent-${this.nextId++}`;
    this.pendingReplies.set(id, onReply);
    this.emit({ jsonrpc: '2.0', id, method, params });
  }

  notify(method: string, params: unknown): void {
    this.emit({ jsonrpc: '2.0', method, params });
  }

  private emit(msg: unknown): void {
    queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify(msg)}\n`)));
  }
}

function spawnFor(agent: ScriptedAcpAgent): SpawnFn {
  return (_cmd, args) => (args[0] === 'exec' ? agent.child : immediatelyClosingChild());
}

function baseSpec(overrides: Partial<AcpHostSpec> = {}): AcpHostSpec {
  return {
    jobId: 'job-1',
    prompt: 'do the thing',
    workspace: '/work/job-1',
    mounts: [],
    image: 'x@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    memoryMb: 512,
    networkMode: 'none',
    command: 'claude-agent-acp',
    args: [],
    signal: new AbortController().signal,
    steerSink: NOOP_STEER,
    appendLog: () => {},
    gate: async () => ({ outcome: 'cancelled' }) satisfies AcpGateAnswer,
    ...overrides,
  };
}

/** Drain the generator with a hard timeout — a hang is a test failure, not a slow one. */
async function drainWithTimeout(gen: AsyncIterable<AgentEvent>, ms = 2_000): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const iterator = gen[Symbol.asyncIterator]();
  for (;;) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('runAcpHost hung — never settled')), ms);
        t.unref?.();
      }),
    ]);
    if (result.done) return events;
    events.push(result.value);
  }
}

describe('runAcpHost — handshake and text/tool translation', () => {
  it('drives initialize -> session/new -> session/prompt and translates the reply into AgentEvents', async () => {
    const agent = new ScriptedAcpAgent();
    agent.on('initialize', (msg) => agent.reply(msg.id, { protocolVersion: 1 }));
    agent.on('session/new', (msg) => agent.reply(msg.id, { sessionId: 'sess-1' }));
    agent.on('session/prompt', (msg) => {
      agent.notify('session/update', {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      });
      agent.reply(msg.id, { stopReason: 'end_turn' });
    });

    const events = await drainWithTimeout(runAcpHost(baseSpec(), { spawn: spawnFor(agent) }));

    expect(events).toContainEqual({ type: 'text_delta', text: 'hi' });
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'hi', turnCount: 1 });

    // The real ACP wire shape, not a guess: `session/new`'s params carry `cwd`
    // and `mcpServers`, matching `AcpNewSessionParams`.
    const sessionNewWrite = agent.writes.find((w) => w.includes('"session/new"'));
    expect(JSON.parse(sessionNewWrite ?? '{}').params).toEqual({
      cwd: '/work/job-1',
      mcpServers: [],
    });
  });

  it('translates a tool_call / tool_call_update pair into tool_start/tool_end', async () => {
    const agent = new ScriptedAcpAgent();
    agent.on('initialize', (msg) => agent.reply(msg.id, { protocolVersion: 1 }));
    agent.on('session/new', (msg) => agent.reply(msg.id, { sessionId: 'sess-1' }));
    agent.on('session/prompt', (msg) => {
      agent.notify('session/update', {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'bash', kind: 'execute' },
      });
      agent.notify('session/update', {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' },
      });
      agent.reply(msg.id, { stopReason: 'end_turn' });
    });

    const events = await drainWithTimeout(runAcpHost(baseSpec(), { spawn: spawnFor(agent) }));

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_start', toolCallId: 'tc-1', toolName: 'bash' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_end', toolCallId: 'tc-1', ok: true }),
    );
  });

  it('surfaces the agent process dying before the handshake settles as an error event, not a hang', async () => {
    const agent = new ScriptedAcpAgent();
    // Never answers `initialize` — the process exits instead, as an
    // incompatible or crashed agent would. Triggered FROM the `initialize`
    // handler (not scheduled up front) so it fires only once the host has
    // actually sent the request and attached its `close` listener — a bare
    // `queueMicrotask` at test-setup time races the listener registration
    // and can fire before anything is listening.
    agent.on('initialize', () => {
      queueMicrotask(() => agent.child.emit('close', 1));
    });

    const events = await drainWithTimeout(runAcpHost(baseSpec(), { spawn: spawnFor(agent) }));

    // The process death rejects the still-pending `initialize` request
    // (`conn.rejectAllPending`), which the handshake catch-block turns into
    // `acp_handshake_failed` — a more specific report than the generic
    // `acp_host_died` (reserved for a process that dies with no request in
    // flight at all). Either way: an error event, never a hang.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'acp_handshake_failed' });
  });

  it('surfaces a JSON-RPC error response to `initialize` as a visible failure, not a hang — the agent process stays alive but does not speak ACP correctly', async () => {
    const agent = new ScriptedAcpAgent();
    // The process itself is fine (never dies) — it just answers `initialize`
    // with a JSON-RPC error, the "speaks a different/incompatible protocol
    // version" case named in the plan's failure-modes table, distinct from
    // the process-death path covered above.
    agent.on('initialize', (msg) => agent.replyError(msg.id, 'unsupported protocolVersion'));

    const events = await drainWithTimeout(runAcpHost(baseSpec(), { spawn: spawnFor(agent) }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'acp_handshake_failed' });
    expect((events[0] as { error: string }).error).toContain('unsupported protocolVersion');
  });

  it('surfaces an alive-but-silent agent (accepts `initialize`, never replies, never dies) as a visible handshake-timeout failure, not a permanent hang', async () => {
    const agent = new ScriptedAcpAgent();
    // Deliberately does nothing: the process stays alive (no close/error
    // event ever fires) and no response line is ever sent. Before the
    // per-call timeout this existed with no way to detect it — `request()`
    // would await forever, and the job's heartbeat (driven independently by
    // the executor) would keep bumping, so stale-run reclaim would never
    // fire either. This is that exact scenario, distinct from both the
    // process-death and JSON-RPC-error cases above.
    agent.on('initialize', () => {
      /* never responds */
    });

    // A short override in place of the real 30s constant — proves the
    // mechanism without a real 30-second wait.
    const events = await drainWithTimeout(
      runAcpHost(baseSpec(), { spawn: spawnFor(agent), handshakeTimeoutMs: 20 }),
      2_000,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'acp_handshake_failed' });
    expect((events[0] as { error: string }).error).toContain(
      'ACP request "initialize" timed out after 20ms',
    );
  });
});

describe("runAcpHost — session/request_permission routes through the gate (D-ACP3's supported path)", () => {
  it("answers the agent's permission request with the gate's outcome, then finishes the turn", async () => {
    const agent = new ScriptedAcpAgent();
    agent.on('initialize', (msg) => agent.reply(msg.id, { protocolVersion: 1 }));
    agent.on('session/new', (msg) => agent.reply(msg.id, { sessionId: 'sess-1' }));
    agent.on('session/prompt', (msg) => {
      agent.request(
        'session/request_permission',
        {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 'tc-1', title: 'bash', kind: 'execute', rawInput: { cmd: 'ls' } },
          options: [{ optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' }],
        },
        (result) => {
          expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-allow' } });
          agent.reply(msg.id, { stopReason: 'end_turn' });
        },
      );
    });

    const gate = vi.fn(
      async () => ({ outcome: 'selected', optionId: 'opt-allow' }) satisfies AcpGateAnswer,
    );
    const events = await drainWithTimeout(
      runAcpHost(baseSpec({ gate }), { spawn: spawnFor(agent) }),
    );

    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        toolCallId: 'tc-1',
        toolName: 'bash',
        kind: 'execute',
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('answers with cancelled, never a hang, when the gate policy throws', async () => {
    const agent = new ScriptedAcpAgent();
    agent.on('initialize', (msg) => agent.reply(msg.id, { protocolVersion: 1 }));
    agent.on('session/new', (msg) => agent.reply(msg.id, { sessionId: 'sess-1' }));
    agent.on('session/prompt', (msg) => {
      agent.request(
        'session/request_permission',
        { sessionId: 'sess-1', toolCall: { toolCallId: 'tc-1' }, options: [] },
        (result) => {
          expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
          agent.reply(msg.id, { stopReason: 'end_turn' });
        },
      );
    });

    const gate = vi.fn(async () => {
      throw new Error('router escalation timed out');
    });
    const events = await drainWithTimeout(
      runAcpHost(baseSpec({ gate }), { spawn: spawnFor(agent) }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});

describe("runAcpHost — D-ACP3's degrade-when-unsupported path", () => {
  it('an agent that never sends session/request_permission runs to completion, never invoking the gate, never hanging', async () => {
    const agent = new ScriptedAcpAgent();
    agent.on('initialize', (msg) => agent.reply(msg.id, { protocolVersion: 1 }));
    agent.on('session/new', (msg) => agent.reply(msg.id, { sessionId: 'sess-1' }));
    agent.on('session/prompt', (msg) => {
      // No permission request at all — some ACP agents never implement it.
      agent.reply(msg.id, { stopReason: 'end_turn' });
    });

    const gate = vi.fn(async () => ({ outcome: 'cancelled' }) satisfies AcpGateAnswer);
    const events = await drainWithTimeout(
      runAcpHost(baseSpec({ gate }), { spawn: spawnFor(agent) }),
    );

    expect(gate).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'done', turnCount: 1 });
  });
});
