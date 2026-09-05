import type { RowStatus } from '../../lib/trail';
import type { rpc } from '../../rpc';
import { wakeAge } from '../voice/satellite-rows';

// View logic for "Observed chats" — the rooms a bot watches and never answers
// (plan/phases/ambient-group-monitoring.md R12).
//
// Pure, and exported, so every state this section can be in is testable without
// a click: rows, the empty house, the unreadable transcript, the truncated
// list. The component below it only arranges what these functions return.
//
// What is NOT here is as deliberate as what is. There is no last-message
// preview (the plan's privacy line, §8) and no per-lane MODE: the transcript
// store records lanes, not configuration, so a mode column would be a fact the
// wire never carried, dressed as one it did. That a lane is listed at all is
// the statement — nothing else records a room it does not answer.

type ObservedData = Awaited<ReturnType<typeof rpc.channels.observed>>;
export type ObservedLane = ObservedData['lanes'][number];

/** Empty-state voice, borrowed verbatim from the drawer's — one house style. */
export const OBSERVED_EMPTY_COPY =
  'Quiet for now. Chats a bot watches in observe mode appear here.';

/** The `since` the section asks for: local midnight, so "today" is the
 *  reader's today. The server has no idea what timezone they are in. */
export function startOfToday(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface ObservedRowView {
  status: RowStatus;
  /** Mono subject — the room. A thread is its own room, so it is named. */
  subject: string;
  result: string;
  meta: string;
}

/**
 * One watched room as a feedback row.
 *
 * `count` is windowed to {@link startOfToday} while `lastSentAt` is not, which
 * is why a row can honestly read "no messages today · 3d ago": the room is
 * still watched, it was simply quiet. Dropping such a row would read as "we
 * stopped listening", which is the opposite of true.
 */
export function observedRowView(lane: ObservedLane, now: number): ObservedRowView {
  const subject = lane.threadId ? `${lane.chatId} / ${lane.threadId}` : lane.chatId;
  const result =
    lane.count === 0
      ? 'no messages today'
      : `${lane.count} message${lane.count === 1 ? '' : 's'} today`;
  return { status: 'ok', subject, result, meta: wakeAge(lane.lastSentAt, now) };
}

/** The row an unreadable transcript gets. It STAYS on the page (contract §6);
 *  it is not a toast, and it does not replace the section with a blank. */
export function observedErrorRow(error: string): ObservedRowView {
  return { status: 'failed', subject: 'observed chats', result: error, meta: '' };
}

export interface ObservedBotGroup {
  /** `${platform}:${botKey}` — unique, and the React key. */
  id: string;
  platform: string;
  botKey: string;
  lanes: ObservedLane[];
}

/**
 * Group the lanes by the bot that watched them, preserving the server's
 * newest-active-first order both between groups and inside one. Which bot is
 * listening is the fact an operator with several bots in the same workspace
 * needs first, and the lane key alone does not spell it.
 */
export function groupByBot(lanes: readonly ObservedLane[]): ObservedBotGroup[] {
  const groups: ObservedBotGroup[] = [];
  const byId = new Map<string, ObservedBotGroup>();
  for (const lane of lanes) {
    const id = `${lane.platform}:${lane.botKey}`;
    const existing = byId.get(id);
    if (existing) {
      existing.lanes.push(lane);
      continue;
    }
    const group: ObservedBotGroup = {
      id,
      platform: lane.platform,
      botKey: lane.botKey,
      lanes: [lane],
    };
    byId.set(id, group);
    groups.push(group);
  }
  return groups;
}

/**
 * `showing 40 of 52 watched chats`, or null when the list is whole.
 *
 * The store's own `omittedCount` vocabulary, said out loud rather than left as
 * a list that quietly stops (contract §7). Deliberately NOT a row: "12 chats
 * are not on screen" is not an outcome, and painting a status glyph on it
 * would be a word the wire never said.
 */
export function omittedNote(shown: number, omittedCount: number): string | null {
  if (omittedCount <= 0) return null;
  return `showing ${shown} of ${shown + omittedCount} watched chats`;
}
