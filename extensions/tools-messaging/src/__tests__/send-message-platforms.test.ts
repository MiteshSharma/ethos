// WhatsApp is a first-class `send_message` target (plan/phases/ambient-group-monitoring.md T1).
// The enum the model sees and the rejection an unsupported platform gets both come from
// SEND_MESSAGE_PLATFORMS, so these assertions also guard the two against drifting apart.

import type { Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createMessagingTools } from '../index';

const ctx = { personalityId: 'p' } as ToolContext;

/** Written out on purpose: deriving it from SEND_MESSAGE_PLATFORMS would make
 *  dropping a platform from that constant invisible to these tests. */
const EXPECTED = ['slack', 'telegram', 'discord', 'whatsapp', 'email'];

function sendMessageTool(send = vi.fn(async () => ({ ok: true }))): {
  tool: Tool;
  send: ReturnType<typeof vi.fn>;
} {
  const tools = createMessagingTools({ send });
  const tool = tools.find((t) => t.name === 'send_message');
  if (!tool) throw new Error('send_message not registered');
  return { tool, send };
}

describe('send_message — platform roster', () => {
  it('offers whatsapp in the schema enum the model sees', () => {
    const { tool } = sendMessageTool();
    const properties = tool.schema.properties as { platform: { enum: string[] } };
    expect(properties.platform.enum).toEqual(EXPECTED);
  });

  it('accepts whatsapp and forwards it to the send function', async () => {
    const { tool, send } = sendMessageTool();
    const result = await tool.execute(
      { platform: 'whatsapp', target: '123@g.us', body: 'hi' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledWith('whatsapp', '123@g.us', 'hi');
  });

  it('rejects an unknown platform with a message naming all five', async () => {
    const { tool, send } = sendMessageTool();
    const result = await tool.execute({ platform: 'signal', target: 'x', body: 'hi' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const platform of EXPECTED) {
      expect(result.error).toContain(platform);
    }
    expect(send).not.toHaveBeenCalled();
  });
});
