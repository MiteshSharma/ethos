// The WhatsApp formatting prompt has to be filed under the id the adapter itself
// reports, or PlatformFormattingInjector silently finds nothing and the agent
// writes Telegram markdown into a WhatsApp chat
// (plan/phases/ambient-group-monitoring.md T1).

import { WhatsAppAdapter } from '@ethosagent/platform-whatsapp';
import { platformId as whatsappId } from '@ethosagent/platform-whatsapp/format';
import { describe, expect, it } from 'vitest';
import { platformPrompts } from '../compose-tools';

describe('platformPrompts — WhatsApp', () => {
  const adapter = new WhatsAppAdapter({
    sessionDir: '/tmp/ethos-whatsapp-prompt-test',
    allowedJids: ['15550000000@s.whatsapp.net'],
  });

  it('files the prompt under the id the adapter reports', () => {
    expect(whatsappId).toBe(adapter.capabilities.platform);
    expect(platformPrompts.has(adapter.capabilities.platform)).toBe(true);
  });

  it('names the mistake WhatsApp punishes — markdown links', () => {
    const prompt = platformPrompts.get(adapter.capabilities.platform) ?? '';
    expect(prompt).toContain('[text](url)');
  });
});
