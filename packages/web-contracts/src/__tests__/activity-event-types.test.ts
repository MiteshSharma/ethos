import { describe, expect, it } from 'vitest';
import { ACTIVITY_EVENT_TYPES, SseEventSchema, type SseEventType } from '../events';

// `ACTIVITY_EVENT_TYPES` is the ONE allowlist behind both ends of the activity
// feed — `ChatService.append` on the server and `convertSseEvent` on the
// client. This gate makes a new `SseEvent` type an explicit decision: it has to
// be admitted to the feed or named in the exclusion list below, and it cannot
// slip in unclassified.

/**
 * Types the activity feed deliberately drops: per-token / per-connection
 * plumbing, not discrete actions. Restated here rather than imported, so the
 * gate is a real second opinion on the set instead of a tautology.
 */
const EXCLUDED: SseEventType[] = [
  'text_delta',
  'thinking_delta',
  'usage',
  'context_meta',
  'stream_meta',
  'protocol.upgrade_required',
];

describe('ACTIVITY_EVENT_TYPES', () => {
  const allTypes = SseEventSchema.options.map((option) => option.shape.type.value);

  it('partitions every SseEvent type into admitted or excluded', () => {
    const unclassified = allTypes.filter(
      (type) => !ACTIVITY_EVENT_TYPES.has(type) && !EXCLUDED.includes(type),
    );
    expect(unclassified).toEqual([]);
    expect(ACTIVITY_EVENT_TYPES.size + EXCLUDED.length).toBe(allTypes.length);
  });

  it('admits nothing that is not an SseEvent type', () => {
    expect([...ACTIVITY_EVENT_TYPES].filter((type) => !allTypes.includes(type))).toEqual([]);
  });

  it('excludes the streaming-token types that would flood the feed', () => {
    for (const type of EXCLUDED) {
      expect(ACTIVITY_EVENT_TYPES.has(type)).toBe(false);
    }
  });

  it('admits the discrete-action types the feed exists to show', () => {
    for (const type of ['tool_start', 'tool_end', 'done', 'error', 'cron.fired'] as const) {
      expect(ACTIVITY_EVENT_TYPES.has(type)).toBe(true);
    }
  });
});
