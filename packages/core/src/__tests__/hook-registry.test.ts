import { describe, expect, it, vi } from 'vitest';
import { DefaultHookRegistry } from '../hook-registry';

describe('DefaultHookRegistry', () => {
  it('void: all handlers run in parallel', async () => {
    const reg = new DefaultHookRegistry();
    const order: string[] = [];

    reg.registerVoid('agent_done', async () => {
      order.push('a');
    });
    reg.registerVoid('agent_done', async () => {
      order.push('b');
    });

    await reg.fireVoid('agent_done', { sessionId: 's1', text: 'hi', turnCount: 1 });
    expect(order).toContain('a');
    expect(order).toContain('b');
  });

  it('void: failing handler does not throw (fail-open)', async () => {
    const reg = new DefaultHookRegistry();
    reg.registerVoid('agent_done', async () => {
      throw new Error('boom');
    });
    await expect(
      reg.fireVoid('agent_done', { sessionId: 's1', text: 'hi', turnCount: 1 }),
    ).resolves.toBeUndefined();
  });

  it('modifying: handlers run sequentially, first non-null value per key wins', async () => {
    const reg = new DefaultHookRegistry();
    reg.registerModifying('before_prompt_build', async () => ({
      prependSystem: 'first',
    }));
    reg.registerModifying('before_prompt_build', async () => ({
      prependSystem: 'second', // should be ignored — key already set
      appendSystem: 'appended',
    }));

    const result = await reg.fireModifying('before_prompt_build', {
      sessionId: 's1',
      history: [],
    });

    expect(result.prependSystem).toBe('first');
    expect(result.appendSystem).toBe('appended');
  });

  it('claiming: stops after first handled:true', async () => {
    const reg = new DefaultHookRegistry();
    const spy = vi.fn();

    reg.registerClaiming('inbound_claim', async () => ({ handled: true }));
    reg.registerClaiming('inbound_claim', async () => {
      spy(); // should NOT be called
      return { handled: false };
    });

    const result = await reg.fireClaiming('inbound_claim', {
      message: {
        platform: 'cli',
        chatId: 'c1',
        text: 'hello',
        isDm: true,
        isGroupMention: false,
        raw: null,
      },
    });

    expect(result.handled).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('unregisterPlugin removes all hooks for that plugin', async () => {
    const reg = new DefaultHookRegistry();
    const spy = vi.fn();

    reg.registerVoid('agent_done', async () => spy(), { pluginId: 'my-plugin' });
    reg.unregisterPlugin('my-plugin');

    await reg.fireVoid('agent_done', { sessionId: 's1', text: 'hi', turnCount: 1 });
    expect(spy).not.toHaveBeenCalled();
  });
});
