import { describe, expect, it } from 'vitest';
import {
  ApprovalRequestSchema,
  contract,
  PersonalitySchema,
  SessionSchema,
  type SseEvent,
  SseEventSchema,
} from '../index';

// ---------------------------------------------------------------------------
// Schemas — every entity round-trips through Zod parse without loss.
// ---------------------------------------------------------------------------

describe('entity schemas', () => {
  it('Session round-trips through parse', () => {
    const s = {
      id: 'sess_1',
      key: 'cli:proj',
      platform: 'cli',
      model: 'claude-opus-4',
      provider: 'anthropic',
      personalityId: 'researcher',
      parentSessionId: null,
      workingDir: '/tmp/proj',
      title: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(SessionSchema.parse(s)).toEqual(s);
  });

  it('Session rejects negative token counts', () => {
    expect(() =>
      SessionSchema.parse({
        id: 'x',
        key: 'x',
        platform: 'cli',
        model: 'm',
        provider: 'p',
        personalityId: null,
        parentSessionId: null,
        workingDir: null,
        title: null,
        usage: {
          inputTokens: -1, // invalid
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0,
          apiCallCount: 0,
          compactionCount: 0,
        },
        createdAt: '',
        updatedAt: '',
      }),
    ).toThrow();
  });

  it('Personality omits server-internal fields (ethosFile, skillsDirs)', () => {
    const p = {
      id: 'researcher',
      name: 'Researcher',
      description: null,
      model: null,
      provider: null,
      toolset: null,
      capabilities: null,
      memoryScope: null,
      streamingTimeoutMs: null,
      builtin: true,
    };
    const parsed = PersonalitySchema.parse(p);
    expect(parsed).toEqual(p);
    expect('ethosFile' in parsed).toBe(false);
    expect('skillsDirs' in parsed).toBe(false);
  });

  it('ApprovalRequest accepts arbitrary args payload (unknown)', () => {
    const r = {
      approvalId: 'ap_1',
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/x' },
      reason: 'destructive',
    };
    expect(ApprovalRequestSchema.parse(r)).toEqual(r);
  });
});

// ---------------------------------------------------------------------------
// SSE events — discriminated union accepts every variant we ship.
// ---------------------------------------------------------------------------

describe('SSE event union', () => {
  it.each<SseEvent>([
    { type: 'text_delta', text: 'hello' },
    { type: 'thinking_delta', thinking: 'hmm' },
    { type: 'tool_start', toolCallId: 'tc_1', toolName: 'bash', args: {} },
    { type: 'tool_progress', toolName: 'bash', message: 'running…', audience: 'user' },
    { type: 'tool_end', toolCallId: 'tc_1', toolName: 'bash', ok: true, durationMs: 12 },
    { type: 'usage', inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 },
    { type: 'context_meta', data: { skill_files_used: ['summarize'] } },
    { type: 'done', text: 'final', turnCount: 1 },
    { type: 'error', error: 'overloaded', code: 'overloaded' },
    { type: 'message_persisted', messageId: 'msg_1', role: 'assistant' },
    {
      type: 'tool.approval_required',
      request: {
        approvalId: 'ap_1',
        sessionId: 'sess_1',
        toolCallId: 'tc_1',
        toolName: 'bash',
        args: {},
        reason: null,
      },
    },
    { type: 'approval.resolved', approvalId: 'ap_1', decision: 'allow', decidedBy: 'tab-A' },
    { type: 'cron.fired', jobId: 'daily-news', ranAt: new Date().toISOString(), outputPath: null },
    {
      type: 'mesh.changed',
      agents: [{ agentId: 'a:1', capabilities: ['research'], activeSessions: 0 }],
    },
    {
      type: 'evolve.skill_pending',
      skillId: 'summarize-v2',
      personalityId: 'researcher',
      proposedAt: new Date().toISOString(),
    },
    { type: 'protocol.upgrade_required', serverVersion: '0.2.0', clientVersionExpected: '0.1.x' },
  ])('accepts %j', (event) => {
    expect(SseEventSchema.parse(event)).toEqual(event);
  });

  it('rejects an unknown discriminator', () => {
    expect(() =>
      SseEventSchema.parse({ type: 'not_a_real_event' as 'text_delta', text: 'x' }),
    ).toThrow();
  });

  it('rejects a tool_progress with audience outside the enum', () => {
    expect(() =>
      SseEventSchema.parse({
        type: 'tool_progress',
        toolName: 'bash',
        message: 'x',
        audience: 'admin', // not in enum — runtime parse rejects
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Contract shape — namespaces are present and procedures look like procedures.
// We don't exercise oRPC's runtime, just confirm the contract was assembled.
// ---------------------------------------------------------------------------

describe('contract router', () => {
  it('exposes the v0 + v0.5 namespaces', () => {
    expect(Object.keys(contract).sort()).toEqual([
      'chat',
      'config',
      'cron',
      'evolver',
      'mesh',
      'onboarding',
      'personalities',
      'sessions',
      'skills',
      'tools',
    ]);
  });

  it('every leaf is an object (oRPC procedure)', () => {
    for (const [ns, procedures] of Object.entries(contract)) {
      for (const [name, procedure] of Object.entries(procedures)) {
        expect(procedure, `${ns}.${name}`).toBeTypeOf('object');
        expect(procedure, `${ns}.${name}`).not.toBeNull();
      }
    }
  });
});
