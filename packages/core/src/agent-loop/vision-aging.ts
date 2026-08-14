import type { Message, MessageContent } from '@ethosagent/types';

/**
 * C3 — block aging.
 *
 * Images are the most token-expensive thing in a history and the least likely
 * to matter three turns later, so past a recency window they are replaced with
 * a line naming what was there. Same family as
 * {@link ./tool-result-aging}, with one deliberate difference: tool-result
 * aging fires on token PRESSURE, this fires on RECENCY alone. A 40-turn
 * session that never approaches the window would otherwise re-send every
 * screenshot on every request forever.
 *
 * Aging happens at prompt build and never mutates stored messages — the
 * session keeps the blocks so a fork or replay still has them, exactly as
 * tool-result aging does.
 */

/**
 * Assistant turns of history that keep their image/document blocks. Older user
 * turns degrade to text. Four is one more than tool-result aging's window: an
 * image is likelier than a tool result to be the subject of a follow-up
 * question ("what about the second error?").
 */
export const KEEP_RECENT_VISION_TURNS = 4;

/** The text a block degrades to. */
function agedPlaceholder(block: Extract<MessageContent, { type: 'image' | 'document' }>): string {
  const kind = block.type === 'document' ? 'document' : 'image';
  return block.filename ? `[${kind} aged out: ${block.filename}]` : `[${kind} aged out]`;
}

function isVisionBlock(
  block: MessageContent,
): block is Extract<MessageContent, { type: 'image' | 'document' }> {
  return block.type === 'image' || block.type === 'document';
}

/**
 * Replace image/document blocks older than `keepRecentTurns` assistant turns
 * with placeholder text.
 *
 * Returns the input array unchanged when nothing aged, so an ordinary
 * text-only session pays one pass and no allocation.
 */
export function ageVisionBlocks(
  messages: Message[],
  keepRecentTurns: number = KEEP_RECENT_VISION_TURNS,
): Message[] {
  // Walk backward counting assistant turns; everything beyond the window is
  // old. Counting backward rather than forward means the window is measured
  // from the CURRENT turn, which is what "recent" has to mean when history is
  // also being truncated from the head.
  let assistantTurns = 0;
  let agedAny = false;
  const out: Message[] = new Array(messages.length);

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.role === 'assistant') assistantTurns++;

    const withinWindow = assistantTurns <= keepRecentTurns;
    if (withinWindow || !Array.isArray(msg.content)) {
      out[i] = msg;
      continue;
    }

    if (!msg.content.some(isVisionBlock)) {
      out[i] = msg;
      continue;
    }

    // Collapse each vision block to text in place, preserving block order so
    // the surrounding text blocks keep their relationship to it.
    const content: MessageContent[] = msg.content.map((block) =>
      isVisionBlock(block) ? { type: 'text', text: agedPlaceholder(block) } : block,
    );
    out[i] = { ...msg, content };
    agedAny = true;
  }

  return agedAny ? out : messages;
}

/**
 * Flatten vision blocks to their placeholder text for a compaction summarizer.
 *
 * The summarizer is a separate model call whose only job is to produce prose;
 * re-sending every image into it doubles the cost of compaction and can exceed
 * the summarizer's own context. It sees what was there, not the pixels.
 */
export function stripVisionBlocksForSummary(messages: Message[]): Message[] {
  return ageVisionBlocks(messages, 0);
}
