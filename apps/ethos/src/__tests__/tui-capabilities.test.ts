import type { NotificationRouter, NotifyOptions, SlashCommandContext } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  formatSkillProposedNotice,
  makeTuiNotificationSubscriber,
  makeTuiSlashCommands,
  type PluginSlashSource,
} from '../lib/tui-capabilities';

describe('makeTuiSlashCommands', () => {
  it('lists nothing and dispatches null without a plugin loader', async () => {
    const cmds = makeTuiSlashCommands(undefined);
    expect(cmds.list()).toEqual([]);
    expect(await cmds.dispatch('anything', '', { sessionKey: 's', personalityId: 'p' })).toBeNull();
  });

  it('returns null for a name no plugin handles', async () => {
    const loader: PluginSlashSource = {
      getSlashHandler: () => undefined,
      getAllSlashCommands: () => [],
    };
    const cmds = makeTuiSlashCommands(loader);
    expect(await cmds.dispatch('nope', 'args', { sessionKey: 's', personalityId: 'p' })).toBeNull();
  });

  it('lists plugin commands from the loader', () => {
    const loader: PluginSlashSource = {
      getSlashHandler: () => undefined,
      getAllSlashCommands: () => [
        { name: 'standup', description: 'Daily standup', usage: '/standup' },
      ],
    };
    expect(makeTuiSlashCommands(loader).list()).toEqual([
      { name: 'standup', description: 'Daily standup', usage: '/standup' },
    ]);
  });

  it('accumulates send() chunks and the handler return value', async () => {
    const handler = async (args: string, ctx: SlashCommandContext) => {
      await ctx.send('chunk one');
      await ctx.send('chunk two');
      return `done with ${args}`;
    };
    const loader: PluginSlashSource = {
      getSlashHandler: (name) => (name === 'standup' ? handler : undefined),
      getAllSlashCommands: () => [],
    };
    const cmds = makeTuiSlashCommands(loader);
    const result = await cmds.dispatch('standup', 'today', {
      sessionKey: 'cli:proj',
      personalityId: 'engineer',
    });
    expect(result).toBe('chunk one\nchunk two\ndone with today');
  });

  it('passes session and personality through to the handler context', async () => {
    let seen: SlashCommandContext | undefined;
    const loader: PluginSlashSource = {
      getSlashHandler: () => async (_args, ctx) => {
        seen = ctx;
        return '';
      },
      getAllSlashCommands: () => [],
    };
    await makeTuiSlashCommands(loader).dispatch('x', '', {
      sessionKey: 'cli:proj:123',
      personalityId: 'coach',
    });
    expect(seen?.sessionId).toBe('cli:proj:123');
    expect(seen?.personalityId).toBe('coach');
    expect(seen?.platform).toBe('cli');
  });
});

describe('makeTuiNotificationSubscriber', () => {
  function makeRouter() {
    const adapters = new Map<
      string,
      { send: (m: string) => Promise<void>; injectUserMessage: (m: string) => Promise<void> }
    >();
    const router: NotificationRouter = {
      async route(_pluginId: string, opts: NotifyOptions) {
        await adapters.get(opts.sessionKey)?.send(opts.message);
      },
      register: vi.fn((key, adapter) => {
        adapters.set(key, adapter);
      }),
      deregister: vi.fn((key) => {
        adapters.delete(key);
      }),
    };
    return { router, adapters };
  }

  it('registers an adapter that forwards send() to the callback', async () => {
    const { router } = makeRouter();
    const subscribe = makeTuiNotificationSubscriber(router);
    const received: string[] = [];
    subscribe('cli:proj', (text) => received.push(text));

    await router.route('plugin-x', { sessionKey: 'cli:proj', message: 'build done' });
    expect(received).toEqual(['build done']);
  });

  it('forwards injectUserMessage to the callback too', async () => {
    const { router, adapters } = makeRouter();
    const received: string[] = [];
    makeTuiNotificationSubscriber(router)('cli:proj', (text) => received.push(text));

    await adapters.get('cli:proj')?.injectUserMessage('wake up');
    expect(received).toEqual(['wake up']);
  });

  it('cleanup deregisters the session key', async () => {
    const { router } = makeRouter();
    const received: string[] = [];
    const unsubscribe = makeTuiNotificationSubscriber(router)('cli:proj', (t) => received.push(t));
    unsubscribe();

    await router.route('plugin-x', { sessionKey: 'cli:proj', message: 'late' });
    expect(received).toEqual([]);
    expect(router.deregister).toHaveBeenCalledWith('cli:proj');
  });
});

describe('formatSkillProposedNotice', () => {
  // Inverts POSIX single-quoting. Throws on any character outside the quotes,
  // so an unquoted or half-quoted argument provably fails to decode. Copied
  // from the sibling paste-line tests rather than imported across packages.
  const decodeSingleQuoted = (arg: string): string => {
    let text = '';
    let i = 0;
    while (i < arg.length) {
      if (arg[i] !== "'") throw new Error(`unquoted text at ${i}: ${arg}`);
      const close = arg.indexOf("'", i + 1);
      if (close < 0) throw new Error(`unterminated quote: ${arg}`);
      text += arg.slice(i + 1, close);
      i = close + 1;
      if (i < arg.length) {
        if (arg.slice(i, i + 2) !== "\\'") throw new Error(`junk between quotes: ${arg}`);
        text += "'";
        i += 2;
      }
    }
    return text;
  };

  /** The single argument between `ethos evolve apply ` and the closing backtick. */
  const applyArg = (notice: string): string => {
    const start = notice.indexOf('`ethos evolve apply ');
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = notice.slice(start + '`ethos evolve apply '.length);
    const end = rest.indexOf('`');
    expect(end).toBeGreaterThanOrEqual(0);
    return rest.slice(0, end);
  };

  it('names the skill and the apply command', () => {
    expect(formatSkillProposedNotice('summarize-prs')).toBe(
      "[skill-evolver] Proposed skill: summarize-prs — run `ethos evolve apply 'summarize-prs.md'` to activate",
    );
    expect(decodeSingleQuoted(applyArg(formatSkillProposedNotice('summarize-prs')))).toBe(
      'summarize-prs.md',
    );
  });

  it('quotes a skill id containing a space', () => {
    const notice = formatSkillProposedNotice('rewrite-a b-1');
    expect(notice).toContain("`ethos evolve apply 'rewrite-a b-1.md'`");
    expect(decodeSingleQuoted(applyArg(notice))).toBe('rewrite-a b-1.md');
  });

  it('quotes a skill id containing `;` and `$(…)`', () => {
    const notice = formatSkillProposedNotice('rewrite-a;rm -rf ~ $(id)-1');
    expect(decodeSingleQuoted(applyArg(notice))).toBe('rewrite-a;rm -rf ~ $(id)-1.md');
  });

  it('quotes a skill id containing an embedded single quote', () => {
    const notice = formatSkillProposedNotice("rewrite-a'; id #-1");
    expect(decodeSingleQuoted(applyArg(notice))).toBe("rewrite-a'; id #-1.md");
  });

  it('keeps the `.md` suffix inside the quotes', () => {
    // The suffix must be part of the same shell word, not a bare `.md` that a
    // closing quote would strand outside it.
    expect(formatSkillProposedNotice('x')).toContain("apply 'x.md'`");
  });
});
