import type { MemoryContext, MemoryProvider, MemoryUpdate } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { parseCaptions } from '../caption-parser';
import { buildTranscriptArtifact, createMemoryTranscriptWriter } from '../transcript';
import { MEET_CAPTION_FRAGMENTS } from './fixtures/meet-captions';

const NOW = Date.UTC(2026, 6, 19, 12, 0, 0); // deterministic clock

// Records sync() calls — the injected write path under test.
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

const memCtx: MemoryContext = {
  scopeId: 'personality:notes',
  sessionId: 's1',
  sessionKey: 'k1',
  platform: 'meeting',
  workingDir: '/tmp',
};

describe('buildTranscriptArtifact', () => {
  it('assembles a deterministic markdown transcript + summary', () => {
    const entries = parseCaptions(MEET_CAPTION_FRAGMENTS);
    const artifact = buildTranscriptArtifact({
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      entries,
      now: NOW,
    });

    expect(artifact.key).toBe(`meeting-${NOW}.md`);
    expect(artifact.summary).toBe('4 caption line(s) from 2 speaker(s): Alice Chen, Bob Kumar.');
    expect(artifact.markdown).toContain('## Transcript');
    expect(artifact.markdown).toContain('- **Alice Chen:** So I think we should ship Phase D');
    expect(artifact.markdown).toContain('https://meet.google.com/abc-defg-hij');
    // Participant-controlled speech (captions + speaker names) is wrapped in
    // the provenance fence before it's persisted to trusted memory.
    expect(artifact.markdown).toContain('<untrusted source="meeting" tool="meet_join">');
    expect(artifact.markdown).toContain('</untrusted>');
  });

  it('handles an empty transcript honestly (captions not host-enabled)', () => {
    const artifact = buildTranscriptArtifact({
      meetingUrl: 'https://meet.google.com/x',
      entries: [],
      now: NOW,
    });
    expect(artifact.summary).toBe('No captions were captured.');
    expect(artifact.markdown).toContain('Captions must be enabled by the meeting host');
    // The framework-authored placeholder is not participant-controlled, so it
    // stays unwrapped.
    expect(artifact.markdown).not.toContain('<untrusted');
  });
});

describe('createMemoryTranscriptWriter', () => {
  it('writes the transcript through MemoryProvider.sync (no raw fs)', async () => {
    const memory = new RecordingMemory();
    const writer = createMemoryTranscriptWriter(memory, memCtx);
    const artifact = buildTranscriptArtifact({
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      entries: parseCaptions(MEET_CAPTION_FRAGMENTS),
      now: NOW,
    });

    await writer.write(artifact);

    expect(memory.synced).toHaveLength(1);
    const call = memory.synced[0];
    expect(call?.ctx).toBe(memCtx);
    expect(call?.updates).toEqual([
      { action: 'replace', key: artifact.key, content: artifact.markdown },
    ]);
  });
});
