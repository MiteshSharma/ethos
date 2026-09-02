import { describe, expect, it } from 'vitest';
import {
  ApprovalRequestSchema,
  contract,
  KEY_CATEGORY_IDS,
  KeyBlobDetailsSchema,
  KeyCategorySchema,
  ModelCatalogOutput,
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
      pinned: false,
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
      version: 1,
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
        pinned: false,
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

  it('Personality omits server-internal fields (soulFile, skillsDirs)', () => {
    const p = {
      id: 'researcher',
      name: 'Researcher',
      description: null,
      model: null,
      provider: null,
      toolset: null,
      capabilities: null,
      streamingTimeoutMs: null,
      mcp_servers: null,
      plugins: null,
      fs_reach: null,
      system: false,
      builtin: true,
      version: 1,
    };
    const parsed = PersonalitySchema.parse(p);
    expect(parsed).toEqual(p);
    expect('soulFile' in parsed).toBe(false);
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
    { type: 'memory.captured', summary: 'daughter Priya (b. 2019)' },
    {
      type: 'run.update',
      jobId: 'job_8f3c21ab',
      runner: 'pi',
      status: 'running',
      now: 'editing packages/core/src/auth/session-token.ts',
      elapsedMs: 401_000,
      spendUsd: 0.83,
      toolCount: 12,
    },
    {
      type: 'run.update',
      jobId: 'job_8f3c21ab',
      runner: 'pi',
      status: 'blocked',
      now: 'paused — waiting on you',
      elapsedMs: 402_000,
      spendUsd: 0.83,
      toolCount: 12,
    },
  ])('accepts %j', (event) => {
    expect(SseEventSchema.parse(event)).toEqual(event);
  });

  // D20 — `run.update` is an SSE push-family event, never an AgentEvent. These
  // two guards keep the payload from drifting into a free-form bag.
  it('rejects a run.update carrying a status outside the job-status enum', () => {
    expect(() =>
      SseEventSchema.parse({
        type: 'run.update',
        jobId: 'job_1',
        runner: 'pi',
        status: 'paused', // not a BackgroundJobStatus
        now: 'x',
        elapsedMs: 0,
        spendUsd: 0,
        toolCount: 0,
      }),
    ).toThrow();
  });

  it('rejects a run.update missing the now line', () => {
    expect(() =>
      SseEventSchema.parse({
        type: 'run.update',
        jobId: 'job_1',
        runner: 'pi',
        status: 'running',
        elapsedMs: 0,
        spendUsd: 0,
        toolCount: 0,
      }),
    ).toThrow();
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

  it('accepts tool_progress with audience: dashboard', () => {
    const event = SseEventSchema.parse({
      type: 'tool_progress',
      toolName: 'bash',
      message: 'rendering…',
      audience: 'dashboard',
    });
    expect(event).toEqual({
      type: 'tool_progress',
      toolName: 'bash',
      message: 'rendering…',
      audience: 'dashboard',
    });
  });

  it('ModelCatalogOutput round-trips, allows arbitrary model ids, and the optional default key', () => {
    const manifest = {
      version: 1,
      updatedAt: new Date().toISOString(),
      providers: {
        anthropic: {
          models: [
            {
              id: 'claude-opus-4-7',
              label: 'Claude Opus 4.7',
              contextWindow: 200_000,
              default: true,
            },
            {
              // arbitrary / custom model id — the picker allows free text
              id: 'some-custom/unlisted-model:v9',
              label: 'Custom',
              contextWindow: 32_000,
            },
          ],
        },
      },
    };
    const parsed = ModelCatalogOutput.parse(manifest);
    expect(parsed).toEqual(manifest);
    expect(parsed.providers.anthropic?.models[0]?.default).toBe(true);
    expect('default' in (parsed.providers.anthropic?.models[1] ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contract shape — namespaces are present and procedures look like procedures.
// We don't exercise oRPC's runtime, just confirm the contract was assembled.
// ---------------------------------------------------------------------------

describe('contract router', () => {
  it('exposes the v0 + v0.5 + v1 namespaces', () => {
    expect(Object.keys(contract).sort()).toEqual([
      'a2a',
      'activity',
      'admin',
      'apiKeys',
      'batch',
      'chat',
      'clarify',
      'config',
      'context',
      'cron',
      'dashboards',
      'debug',
      'deliveries',
      'digest',
      'documents',
      'eval',
      'evolver',
      'files',
      'goals',
      'kanban',
      'keys',
      'mcp',
      'memory',
      'mesh',
      'meta',
      'models',
      'namedSecrets',
      'onboarding',
      'personalities',
      'platforms',
      'plugins',
      'sessions',
      'skills',
      'slashCommands',
      'tasks',
      'toolSettings',
      'tools',
      'voice',
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

// ---------------------------------------------------------------------------
// Keys — the blob `details` allowlist, enforced by the contract itself
// ---------------------------------------------------------------------------

describe('KeyBlobDetailsSchema', () => {
  it('accepts the two fields the API may expose', () => {
    expect(
      KeyBlobDetailsSchema.parse({
        accountId: 'acct_9f3c21',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    ).toEqual({ accountId: 'acct_9f3c21', expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(KeyBlobDetailsSchema.parse({})).toEqual({});
  });

  // The point of the closed schema: a bearer token added by a future parse
  // refactor or an object spread must FAIL here, not be quietly stripped. If
  // this ever starts passing, the contract has stopped being a boundary.
  it('REJECTS an unknown key rather than dropping it', () => {
    for (const leak of ['accessToken', 'refreshToken', 'idToken', 'updatedAt']) {
      const result = KeyBlobDetailsSchema.safeParse({
        accountId: 'acct_9f3c21',
        [leak]: 'secret-value',
      });
      expect(result.success, leak).toBe(false);
    }
  });

  it('rejects a non-string value for an allowed key', () => {
    expect(KeyBlobDetailsSchema.safeParse({ accountId: { nested: 'object' } }).success).toBe(false);
  });
});

describe('KEY_CATEGORY_IDS', () => {
  // Finding 3: one canonical list. The taxonomy, the settings index, the
  // service's category order and this contract enum all derive from it.
  it('is the contract enum, in order, with no duplicates', () => {
    expect(new Set(KEY_CATEGORY_IDS).size).toBe(KEY_CATEGORY_IDS.length);
    expect(KeyCategorySchema.options).toEqual([...KEY_CATEGORY_IDS]);
    expect(KeyCategorySchema.safeParse('not-a-category').success).toBe(false);
  });
});
