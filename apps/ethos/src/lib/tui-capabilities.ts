// Capability adapters injected into the TUI through runTUI's options.
// @ethosagent/tui must not import apps/ethos (layering), so chat.ts builds
// these from its own wiring (plugin loader, notification router) and passes
// them across the runTUI boundary. Extracted from chat.ts for unit testing.

import type {
  NotificationAdapter,
  NotificationRouter,
  SlashCommandContext,
} from '@ethosagent/types';

/** Structural subset of PluginLoader that the slash-command adapter needs. */
export interface PluginSlashSource {
  getSlashHandler(
    name: string,
  ): ((args: string, ctx: SlashCommandContext) => Promise<string>) | undefined;
  getAllSlashCommands(): { name: string; description: string; usage: string }[];
}

/** Shape consumed by the TUI's `slashCommands` option (structurally typed). */
export interface TuiSlashCommands {
  list(): { name: string; description: string; usage: string }[];
  dispatch(
    name: string,
    args: string,
    ctx: { sessionKey: string; personalityId: string },
  ): Promise<string | null>;
}

/**
 * Plugin slash commands for the TUI. `dispatch` returns null when no plugin
 * handles `name` (the TUI shows its unknown-command hint); otherwise the
 * accumulated handler output (send() chunks + return value).
 */
export function makeTuiSlashCommands(
  pluginLoader: PluginSlashSource | undefined,
): TuiSlashCommands {
  return {
    list: () => pluginLoader?.getAllSlashCommands() ?? [],
    dispatch: async (name, args, ctx) => {
      const handler = pluginLoader?.getSlashHandler(name);
      if (!handler) return null;
      const chunks: string[] = [];
      const result = await handler(args, {
        sessionId: ctx.sessionKey,
        personalityId: ctx.personalityId,
        platform: 'cli',
        send: async (text) => {
          chunks.push(text);
        },
      });
      if (result) chunks.push(result);
      return chunks.join('\n');
    },
  };
}

/**
 * Session-scoped notification subscription for the TUI. Registers an adapter
 * under `sessionKey` and forwards every routed message to `cb`; the returned
 * cleanup deregisters (the TUI re-subscribes when its session key changes).
 */
export function makeTuiNotificationSubscriber(
  router: NotificationRouter,
): (sessionKey: string, cb: (text: string) => void) => () => void {
  return (sessionKey, cb) => {
    const adapter: NotificationAdapter = {
      async send(message) {
        cb(message);
      },
      async injectUserMessage(message) {
        // Input injection requires surface integration; surface the text instead.
        cb(message);
      },
    };
    router.register(sessionKey, adapter);
    return () => router.deregister(sessionKey);
  };
}

/**
 * Wrap one argument in POSIX single quotes, ending and reopening the quote
 * around every embedded `'`. Inside single quotes a shell expands nothing, so
 * spaces, `;`, `&`, backticks and `$(…)` are all literal.
 *
 * The same four lines live in `apps/ethos/src/commands/backup.ts`,
 * `apps/ethos/src/commands/personality-export.ts`,
 * `packages/wiring/src/backup/secrets-manifest.ts`, `extensions/cron/src/index.ts`
 * and `apps/web`'s AddMcpModal. Copied rather than shared: each surface keeps
 * its own module-private copy.
 */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Single source for the skill-evolver proposal notice (readline + TUI).
 *
 * The apply command is quoted because `skillId` is MODEL-controlled, not
 * operator-supplied: `skill_propose` derives it from the LLM's `targetFile`
 * argument. This line exists to be PASTED into a shell, so an id with `;` or
 * `$(…)` in it would produce a line that runs something else entirely. The
 * `.md` suffix goes inside the quotes — the whole argument is one word.
 */
export function formatSkillProposedNotice(skillId: string): string {
  return `[skill-evolver] Proposed skill: ${skillId} — run \`ethos evolve apply ${shellQuote(`${skillId}.md`)}\` to activate`;
}
