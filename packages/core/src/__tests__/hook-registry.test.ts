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

  // ---------------------------------------------------------------------------
  // allowedPlugins gating — Phase 2.1 personality isolation
  // ---------------------------------------------------------------------------

  describe('allowedPlugins gating', () => {
    const payload = { sessionId: 's1', text: 'hi', turnCount: 1 } as const;

    it('void: undefined → all handlers fire (no filter)', async () => {
      const reg = new DefaultHookRegistry();
      const builtinSpy = vi.fn();
      const pluginSpy = vi.fn();

      reg.registerVoid('agent_done', async () => builtinSpy());
      reg.registerVoid('agent_done', async () => pluginSpy(), { pluginId: 'p1' });

      await reg.fireVoid('agent_done', payload, undefined);
      expect(builtinSpy).toHaveBeenCalledOnce();
      expect(pluginSpy).toHaveBeenCalledOnce();
    });

    it('void: [] → only built-in handlers fire (no plugin access)', async () => {
      const reg = new DefaultHookRegistry();
      const builtinSpy = vi.fn();
      const pluginSpy = vi.fn();

      reg.registerVoid('agent_done', async () => builtinSpy());
      reg.registerVoid('agent_done', async () => pluginSpy(), { pluginId: 'p1' });

      await reg.fireVoid('agent_done', payload, []);
      expect(builtinSpy).toHaveBeenCalledOnce();
      expect(pluginSpy).not.toHaveBeenCalled();
    });

    it('void: [p1] → built-in + p1 fire, other plugins blocked', async () => {
      const reg = new DefaultHookRegistry();
      const builtinSpy = vi.fn();
      const p1Spy = vi.fn();
      const p2Spy = vi.fn();

      reg.registerVoid('agent_done', async () => builtinSpy());
      reg.registerVoid('agent_done', async () => p1Spy(), { pluginId: 'p1' });
      reg.registerVoid('agent_done', async () => p2Spy(), { pluginId: 'p2' });

      await reg.fireVoid('agent_done', payload, ['p1']);
      expect(builtinSpy).toHaveBeenCalledOnce();
      expect(p1Spy).toHaveBeenCalledOnce();
      expect(p2Spy).not.toHaveBeenCalled();
    });

    it('void: REGRESSION — fail-open preserved even when plugin is allowed', async () => {
      // A plugin handler that throws must not propagate the error.
      // This ensures allowedPlugins gating doesn't silently change the fail-open contract.
      const reg = new DefaultHookRegistry();
      const afterSpy = vi.fn();

      reg.registerVoid(
        'agent_done',
        async () => {
          throw new Error('plugin boom');
        },
        { pluginId: 'p1' },
      );
      reg.registerVoid('agent_done', async () => afterSpy());

      await expect(reg.fireVoid('agent_done', payload, ['p1'])).resolves.toBeUndefined();
      expect(afterSpy).toHaveBeenCalledOnce();
    });

    it('modifying: [] → only built-in handlers run', async () => {
      const reg = new DefaultHookRegistry();

      reg.registerModifying('before_prompt_build', async () => ({ prependSystem: 'builtin' }));
      reg.registerModifying('before_prompt_build', async () => ({ appendSystem: 'plugin' }), {
        pluginId: 'p1',
      });

      const result = await reg.fireModifying(
        'before_prompt_build',
        { sessionId: 's1', history: [] },
        [],
      );
      expect(result.prependSystem).toBe('builtin');
      expect(result.appendSystem).toBeUndefined();
    });

    it('modifying: [p1] → built-in + p1 run, keys merged', async () => {
      const reg = new DefaultHookRegistry();

      reg.registerModifying('before_prompt_build', async () => ({ prependSystem: 'builtin' }));
      reg.registerModifying('before_prompt_build', async () => ({ appendSystem: 'plugin' }), {
        pluginId: 'p1',
      });
      reg.registerModifying('before_prompt_build', async () => ({ appendSystem: 'other' }), {
        pluginId: 'p2',
      });

      const result = await reg.fireModifying(
        'before_prompt_build',
        { sessionId: 's1', history: [] },
        ['p1'],
      );
      expect(result.prependSystem).toBe('builtin');
      expect(result.appendSystem).toBe('plugin'); // p1 wins; p2 blocked
    });

    it('claiming: [] → only built-in handler runs', async () => {
      const reg = new DefaultHookRegistry();
      const pluginSpy = vi.fn();

      reg.registerClaiming('inbound_claim', async () => ({ handled: false }));
      reg.registerClaiming(
        'inbound_claim',
        async () => {
          pluginSpy();
          return { handled: true };
        },
        { pluginId: 'p1' },
      );

      const msg = {
        platform: 'cli',
        chatId: 'c1',
        text: 'x',
        isDm: true,
        isGroupMention: false,
        raw: null,
      };
      const result = await reg.fireClaiming('inbound_claim', { message: msg }, []);
      expect(result.handled).toBe(false);
      expect(pluginSpy).not.toHaveBeenCalled();
    });

    it('claiming: [p1] → built-in + p1 run; p1 can claim', async () => {
      const reg = new DefaultHookRegistry();

      reg.registerClaiming('inbound_claim', async () => ({ handled: false }));
      reg.registerClaiming('inbound_claim', async () => ({ handled: true }), { pluginId: 'p1' });

      const msg = {
        platform: 'cli',
        chatId: 'c1',
        text: 'x',
        isDm: true,
        isGroupMention: false,
        raw: null,
      };
      const result = await reg.fireClaiming('inbound_claim', { message: msg }, ['p1']);
      expect(result.handled).toBe(true);
    });
  });
});
