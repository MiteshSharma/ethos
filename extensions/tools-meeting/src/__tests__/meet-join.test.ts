import type {
  MeetingClient,
  MeetingJoinOptions,
  RawCaptionFragment,
} from '@ethosagent/platform-meeting';
import type {
  MemoryContext,
  MemoryProvider,
  MemoryUpdate,
  Tool,
  ToolContext,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createMeetingTools } from '../index';

// Rolling Meet-style caption stream (a compact stand-in for the recorded
// fixture): partials merge, a re-emit dedups, two speakers.
const FRAGMENTS: RawCaptionFragment[] = [
  { speaker: 'Alice', text: 'lets', blockId: 'a' },
  { speaker: 'Alice', text: 'lets ship it', blockId: 'a' },
  { speaker: 'Alice', text: 'lets ship it', blockId: 'a' },
  { speaker: 'Bob', text: 'agreed', blockId: 'b' },
];

// Fake meeting client — drains the stream on join, then aborts the turn (the
// honest "meeting ended" signal) via the test-supplied onDrained hook.
class FakeMeetingClient implements MeetingClient {
  readonly joined: MeetingJoinOptions[] = [];
  leftCount = 0;
  private readonly handlers = new Set<(f: RawCaptionFragment) => void>();
  constructor(private readonly onDrained: () => void) {}
  async join(opts: MeetingJoinOptions): Promise<void> {
    this.joined.push(opts);
    for (const f of FRAGMENTS) for (const h of this.handlers) h(f);
    this.onDrained();
  }
  onCaption(handler: (f: RawCaptionFragment) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async leave(): Promise<void> {
    this.leftCount += 1;
  }
}

class RecordingMemory implements MemoryProvider {
  readonly synced: Array<{ updates: MemoryUpdate[]; ctx: MemoryContext }> = [];
  async prefetch() {
    return null;
  }
  async read() {
    return null;
  }
  async search() {
    return [];
  }
  async sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    this.synced.push({ updates, ctx });
  }
  async list() {
    return [];
  }
}

function ctxWith(signal: AbortSignal): ToolContext {
  return {
    sessionId: 's1',
    sessionKey: 'k1',
    platform: 'meeting',
    workingDir: '/tmp',
    memoryScopeId: 'personality:notes',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  } as ToolContext;
}

function meetJoinTool(meetingClient: MeetingClient, memory: MemoryProvider): Tool {
  const tool = createMeetingTools({ meetingClient, memory }).find((t) => t.name === 'meet_join');
  if (!tool) throw new Error('meet_join tool not registered');
  return tool;
}

const ac = new AbortController();

describe('meet_join tool — availability gating', () => {
  it('reports unavailable when no meeting client is configured', () => {
    const tool = createMeetingTools().find((t) => t.name === 'meet_join');
    expect(tool?.isAvailable?.()).toBe(false);
  });

  it('reports available once a meeting client and memory are configured', () => {
    const tool = meetJoinTool(new FakeMeetingClient(() => {}), new RecordingMemory());
    expect(tool.isAvailable?.()).toBe(true);
  });

  it('refuses to join with not_available when executed without a client', async () => {
    const tool = createMeetingTools().find((t) => t.name === 'meet_join');
    const result = await tool?.execute(
      { meeting_url: 'https://meet.google.com/abc-defg-hij' },
      ctxWith(new AbortController().signal),
    );
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.code).toBe('not_available');
  });
});

describe('meet_join tool — approval gating', () => {
  it('is marked requiresApproval so AgentLoop gates it', () => {
    const tool = meetJoinTool(new FakeMeetingClient(() => {}), new RecordingMemory());
    expect(tool.requiresApproval).toBe(true);
    expect(tool.toolset).toBe('meeting');
  });

  it('is marked outputIsUntrusted so participant-controlled captions get sanitized+wrapped', () => {
    const tool = meetJoinTool(new FakeMeetingClient(() => {}), new RecordingMemory());
    expect(tool.outputIsUntrusted).toBe(true);
  });

  it('rejects a non-Meet URL without joining', async () => {
    const memory = new RecordingMemory();
    const meeting = new FakeMeetingClient(() => {});
    const tool = meetJoinTool(meeting, memory);
    const result = await tool.execute({ meeting_url: 'https://zoom.us/j/123' }, ctxWith(ac.signal));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
    expect(meeting.joined).toHaveLength(0);
    expect(memory.synced).toHaveLength(0);
  });
});

describe('meet_join tool — join flow', () => {
  it('joins, transcribes, and writes the transcript+summary via the injected writer', async () => {
    const controller = new AbortController();
    const memory = new RecordingMemory();
    const meeting = new FakeMeetingClient(() => controller.abort());
    const tool = meetJoinTool(meeting, memory);

    const result = await tool.execute(
      { meeting_url: 'https://meet.google.com/abc-defg-hij' },
      ctxWith(controller.signal),
    );

    // Joined with the default display name and left cleanly.
    expect(meeting.joined).toEqual([
      { url: 'https://meet.google.com/abc-defg-hij', displayName: 'Ethos' },
    ]);
    expect(meeting.leftCount).toBe(1);

    // Transcript written through the injected memory writer (no raw fs).
    expect(memory.synced).toHaveLength(1);
    const call = memory.synced[0];
    expect(call?.ctx.scopeId).toBe('personality:notes');
    const update = call?.updates[0];
    expect(update?.action).toBe('replace');
    if (update && update.action === 'replace') {
      expect(update.key).toMatch(/^meeting-\d+\.md$/);
      // Merged + deduped transcript body.
      expect(update.content).toContain('- **Alice:** lets ship it');
      expect(update.content).toContain('- **Bob:** agreed');
      expect(update.content).toContain('## Summary');
    }

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('Saved transcript to meeting-');
  });
});
