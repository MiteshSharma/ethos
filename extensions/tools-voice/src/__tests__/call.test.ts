import { type CallLog, InMemoryCallLog } from '@ethosagent/call-log';
import type {
  OutboundCallHandle,
  OutboundCallRequest,
  SipTrunkClient,
} from '@ethosagent/platform-voice';
import type { Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createVoiceTools } from '../index';

// In-memory SIP trunk — `calls` is the assertion surface (empty ⇒ nothing dialed).
class FakeSipTrunkClient implements SipTrunkClient {
  readonly calls: OutboundCallRequest[] = [];
  async createOutboundCall(req: OutboundCallRequest): Promise<OutboundCallHandle> {
    this.calls.push(req);
    return { callId: `call-${this.calls.length}`, roomName: req.roomName, toNumber: req.toNumber };
  }
}

function callTool(trunk: SipTrunkClient, fromNumber?: string): Tool {
  const tools = createVoiceTools(fromNumber ? { trunk, fromNumber } : { trunk });
  const tool = tools.find((t) => t.name === 'call');
  if (!tool) throw new Error('call tool not registered');
  return tool;
}

const ctx = { sessionId: 's', sessionKey: 'k', platform: 'voice', workingDir: '/' } as ToolContext;

// Faithful stand-in for AgentLoop's approval gate: a tool marked
// `requiresApproval` is NOT executed unless the approval surface approves it
// (packages/core/.../tool-processing.ts). This mirrors that boundary so the
// "without approval, no call is placed" contract is exercised end to end.
async function runGated(tool: Tool, args: unknown, approved: boolean) {
  if (tool.requiresApproval && !approved) {
    return { ok: false as const, code: 'not_available' as const, error: 'awaiting approval' };
  }
  return tool.execute(args, ctx);
}

function voiceSessionTool(): Tool {
  const tool = createVoiceTools().find((t) => t.name === 'voice_session');
  if (!tool) throw new Error('voice_session tool not registered');
  return tool;
}

describe('voice_session capability tool', () => {
  it('is exported from the factory even with no trunk configured', () => {
    const names = createVoiceTools().map((t) => t.name);
    expect(names).toContain('voice_session');
  });

  it('is grouped under the voice toolset', () => {
    expect(voiceSessionTool().toolset).toBe('voice');
  });

  it('is ALWAYS available regardless of live infra (it is a selectable gate)', () => {
    expect(voiceSessionTool().isAvailable?.()).toBe(true);
    // Even with a trunk wired, the capability marker stays available.
    const withTrunk = createVoiceTools({ trunk: new FakeSipTrunkClient() }).find(
      (t) => t.name === 'voice_session',
    );
    expect(withTrunk?.isAvailable?.()).toBe(true);
  });

  it('does not require approval — it is not a live action', () => {
    expect(voiceSessionTool().requiresApproval).toBeFalsy();
  });

  it('a stray model call is harmless and explains the session is channel-managed', async () => {
    const result = await voiceSessionTool().execute({}, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/channel|managed/i);
  });
});

describe('call tool — availability gating', () => {
  it('reports unavailable when no trunk is configured', () => {
    const tool = createVoiceTools().find((t) => t.name === 'call');
    expect(tool?.isAvailable?.()).toBe(false);
  });

  it('reports available once a trunk is configured', () => {
    expect(callTool(new FakeSipTrunkClient()).isAvailable?.()).toBe(true);
  });

  it('refuses to dial with not_available when executed without a trunk', async () => {
    const tool = createVoiceTools().find((t) => t.name === 'call');
    const result = await tool?.execute({ to_number: '+15551234567' }, ctx);
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.code).toBe('not_available');
  });
});

describe('call tool — approval gating', () => {
  it('is marked requiresApproval so AgentLoop gates it', () => {
    expect(callTool(new FakeSipTrunkClient()).requiresApproval).toBe(true);
  });

  it('does NOT place the call when approval is denied', async () => {
    const trunk = new FakeSipTrunkClient();
    const result = await runGated(callTool(trunk), { to_number: '+15551234567' }, false);

    expect(result.ok).toBe(false);
    expect(trunk.calls).toHaveLength(0);
  });

  it('places the call once approved', async () => {
    const trunk = new FakeSipTrunkClient();
    const result = await runGated(callTool(trunk), { to_number: '+15551234567' }, true);

    expect(result.ok).toBe(true);
    expect(trunk.calls).toHaveLength(1);
    expect(trunk.calls[0]?.toNumber).toBe('+15551234567');
  });
});

describe('call tool — execution', () => {
  it('bridges into a default per-call room and passes the trunk fromNumber', async () => {
    const trunk = new FakeSipTrunkClient();
    const result = await callTool(trunk, '+15550000000').execute(
      { to_number: '+15551234567' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(trunk.calls[0]).toEqual({
      toNumber: '+15551234567',
      roomName: 'call-15551234567',
      fromNumber: '+15550000000',
    });
  });

  it('honors an explicit room_name', async () => {
    const trunk = new FakeSipTrunkClient();
    await callTool(trunk).execute({ to_number: '+15551234567', room_name: 'vip-room' }, ctx);
    expect(trunk.calls[0]?.roomName).toBe('vip-room');
  });

  it('rejects a non-E.164 number without dialing', async () => {
    const trunk = new FakeSipTrunkClient();
    const result = await callTool(trunk).execute({ to_number: '555-1234' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
    expect(trunk.calls).toHaveLength(0);
  });

  it('surfaces a trunk failure as execution_failed without throwing', async () => {
    const trunk: SipTrunkClient = {
      createOutboundCall: () => Promise.reject(new Error('trunk down')),
    };
    const result = await callTool(trunk).execute({ to_number: '+15551234567' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('trunk down');
    }
  });
});

// A call the agent PLACED is the one the owner most wants to see, and it used to
// leave no trace at all: Communications → Calls showed inbound history only.
describe('call tool — call history', () => {
  it('opens an outbound row that listRecent returns', async () => {
    const callLog = new InMemoryCallLog();
    const trunk = new FakeSipTrunkClient();
    const tool = createVoiceTools({ trunk, fromNumber: '+15550000000', callLog }).find(
      (t) => t.name === 'call',
    );

    const result = await tool?.execute({ to_number: '+15551234567' }, ctx);
    expect(result?.ok).toBe(true);

    const recent = await callLog.listRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      // Keyed by the room, the one id that exists before the dial.
      id: 'call-15551234567',
      direction: 'outbound',
      fromNumber: '+15550000000',
      toNumber: '+15551234567',
    });
    // The far end seeds the lane, exactly as it does inbound (`voiceLaneKey`
    // percent-encodes the id, so `+` arrives as `%2B`).
    expect(recent[0]?.laneKey).toContain(':sip:%2B15551234567');
  });

  // Nothing in this process joins the LiveKit room or hears the far end hang up,
  // so a row left `ringing` is never moved out of it — and `listLive()` is what
  // the web "call in progress" indicator reads. Left as it was, the first call an
  // agent ever placed lit that indicator permanently, and every call after it
  // added another.
  it('leaves NO live row behind once the trunk has accepted the dial', async () => {
    const callLog = new InMemoryCallLog();
    const tool = createVoiceTools({ trunk: new FakeSipTrunkClient(), callLog }).find(
      (t) => t.name === 'call',
    );

    await tool?.execute({ to_number: '+15551234567' }, ctx);

    expect(await callLog.listLive()).toEqual([]);
  });

  it('closes the row terminally, keeping startedAt and saying the outcome was never seen', async () => {
    const callLog = new InMemoryCallLog();
    const tool = createVoiceTools({ trunk: new FakeSipTrunkClient(), callLog }).find(
      (t) => t.name === 'call',
    );

    const before = Date.now();
    await tool?.execute({ to_number: '+15551234567' }, ctx);

    const row = await callLog.get('call-15551234567');
    // `completed` is the weakest claim the union offers — it asserts nothing
    // about HOW the call ended, and the reason says so in the owner's words
    // rather than leaving a green row to imply it went fine.
    expect(row?.status).toBe('completed');
    expect(row?.reason).toBe(
      'Placed by your agent — Ethos does not stay on the line for calls it makes, ' +
        'so whether this one was answered was not recorded.',
    );
    expect(row?.startedAt).toBeGreaterThanOrEqual(before);
  });

  // The row closes at the moment the trunk ACCEPTED the dial, which is not the
  // moment the call ended — nothing here was on the line to see that. Writing
  // that instant as `endedAt` would hand the web call list an `endedAt` equal to
  // `startedAt`, and every call the agent ever placed would render `0:00` in the
  // same duration column as real, measured inbound calls.
  it('leaves endedAt UNSET, because nothing observed the call ending', async () => {
    const callLog = new InMemoryCallLog();
    const tool = createVoiceTools({ trunk: new FakeSipTrunkClient(), callLog }).find(
      (t) => t.name === 'call',
    );

    await tool?.execute({ to_number: '+15551234567' }, ctx);

    const row = await callLog.get('call-15551234567');
    expect(row?.status).toBe('completed');
    expect(row?.endedAt).toBeUndefined();
  });

  // An unset `endedAt` must not put the row back in the live list — `listLive()`
  // filters on status alone, and this pins that it stays that way.
  it('stays out of the live list even with no endedAt to close it', async () => {
    const callLog = new InMemoryCallLog();
    const tool = createVoiceTools({ trunk: new FakeSipTrunkClient(), callLog }).find(
      (t) => t.name === 'call',
    );

    await tool?.execute({ to_number: '+15551234567' }, ctx);

    expect(await callLog.listLive()).toEqual([]);
    expect(await callLog.listRecent()).toHaveLength(1);
  });

  it('records an unset trunk caller-ID rather than dropping the row', async () => {
    const callLog = new InMemoryCallLog();
    const tool = createVoiceTools({ trunk: new FakeSipTrunkClient(), callLog }).find(
      (t) => t.name === 'call',
    );

    await tool?.execute({ to_number: '+15551234567' }, ctx);
    expect((await callLog.listRecent())[0]?.fromNumber).toBe('unknown');
  });

  it('marks the row failed when the trunk refuses the dial', async () => {
    const callLog = new InMemoryCallLog();
    const trunk: SipTrunkClient = {
      createOutboundCall: () => Promise.reject(new Error('trunk down')),
    };
    const tool = createVoiceTools({ trunk, callLog }).find((t) => t.name === 'call');

    await tool?.execute({ to_number: '+15551234567' }, ctx);

    const row = await callLog.get('call-15551234567');
    expect(row).toMatchObject({ status: 'failed', reason: 'trunk down' });
    // The failure path is the one outbound ending this process DID witness — the
    // trunk rejected the dial right here — so it keeps a real `endedAt`.
    expect(row?.endedAt).toBeGreaterThanOrEqual(row?.startedAt ?? 0);
  });

  it('writes nothing — and still dials — when no call log is wired', async () => {
    const trunk = new FakeSipTrunkClient();
    const result = await callTool(trunk).execute({ to_number: '+15551234567' }, ctx);
    expect(result.ok).toBe(true);
    expect(trunk.calls).toHaveLength(1);
  });

  it('places the call anyway when the log throws, and reports the failure', async () => {
    // The row is a record OF the call, never a precondition for it. A broken
    // SQLite file must not take the phone off the hook.
    const throwing = {
      start: async () => {
        throw new Error('disk full');
      },
      update: async () => {
        throw new Error('disk full');
      },
    } as unknown as CallLog;
    const errors: string[] = [];
    const trunk = new FakeSipTrunkClient();
    const tool = createVoiceTools({
      trunk,
      callLog: throwing,
      onError: (m) => errors.push(m),
    }).find((t) => t.name === 'call');

    const result = await tool?.execute({ to_number: '+15551234567' }, ctx);
    expect(result?.ok).toBe(true);
    expect(trunk.calls).toHaveLength(1);
    expect(errors[0]).toContain('disk full');

    // And the same on the failure path, where BOTH writes throw.
    const deadTrunk: SipTrunkClient = {
      createOutboundCall: () => Promise.reject(new Error('trunk down')),
    };
    const failing = createVoiceTools({
      trunk: deadTrunk,
      callLog: throwing,
      onError: (m) => errors.push(m),
    }).find((t) => t.name === 'call');
    const failed = await failing?.execute({ to_number: '+15551234567' }, ctx);
    expect(failed?.ok).toBe(false);
    if (failed && !failed.ok) expect(failed.error).toContain('trunk down');
    expect(errors.some((m) => m.startsWith('call log update failed'))).toBe(true);
  });
});
