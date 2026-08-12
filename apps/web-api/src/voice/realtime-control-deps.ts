import { voiceLaneKey } from '@ethosagent/core';
import { createRealtimeToolHost } from '@ethosagent/tools-voice';
import type { HookRegistry, SessionStore, ToolRegistry } from '@ethosagent/types';
import type { RealtimeControlLaneDeps, RealtimeSessionBinding } from './realtime-control-lane';

// Binds one browser talk session to its own lane — the "own lane per talk
// session" half of voice V1b (eng-review D6).
//
// WHY THE LANE KEY IS NOT THE CHAT SESSION KEY. A typed chat session is keyed
// `web:<uuid>`; this session is keyed `voice:<botKey>:browser:<client>`. They
// are deliberately different conversations even when the user is looking at
// one window, because a spoken turn and a typed turn on ONE history is exactly
// the interleaving behind OpenClaw #112253 — a consult mid-flight and a typed
// send racing to append to the same message list, each corrupting the other's
// idea of what the last turn was. Shared context across the two comes from
// memory scopes, which is a merge the agent performs deliberately, not one the
// session store performs by accident.
//
// WHY A PHONE SESSION CANNOT COLLIDE WITH THIS ONE. The `kind` segment. A phone
// leg is `voice:<botKey>:livekit:<callerId>` (`VoiceChannelAdapter.laneKey`,
// same encoder). The trailing ids are not what keeps them apart — on a
// single-operator deployment the operator's own number and their own browser
// session id are equally plausible strings, and one could in principle equal
// the other. The kind segment is a closed union written by the surface that
// owns the transport: a browser cannot emit `livekit`, a SIP bridge cannot emit
// `browser`, and every segment is URL-encoded so no id can smuggle a separator
// and alias itself onto the other's key. That is structural, not statistical.

export interface RealtimeControlDepsOptions {
  /** The registry the agent runs on — advertised == handled derives from it. */
  toolRegistry: ToolRegistry;
  /** Fires `before_tool_call` (approval surface + spoken-confirmation gate). */
  hooks?: HookRegistry;
  sessions: SessionStore;
  /** Personality lookup; supplies the toolset that gates direct-call tools. */
  personalities: { get(id: string): { toolset?: string[] } | undefined };
  /** Defaults stamped on a freshly created talk session row. */
  defaults: { model: string; provider: string; workingDir?: string };
  /**
   * Bot this web surface answers as. Single value by design: web-api serves one
   * operator UI, so there is one bot identity here however many bots the
   * gateway runs. A deployment that wants per-bot browser lanes passes its own.
   */
  botKey?: string;
  platform?: string;
}

/**
 * Build the control-lane deps for ONE connection.
 *
 * `fallbackClientId` is the socket's own lane id, used when the browser opens
 * talk-mode before a chat session exists. Preferring the chat session id when
 * there is one is what makes a reconnect resume the same talk session instead
 * of forking a new one every time the WebSocket blips.
 */
export function createRealtimeControlDeps(
  opts: RealtimeControlDepsOptions,
  fallbackClientId: string,
): RealtimeControlLaneDeps {
  const botKey = opts.botKey ?? 'web';
  const platform = opts.platform ?? 'web';

  return {
    async open(info): Promise<RealtimeSessionBinding> {
      const laneKey = voiceLaneKey(botKey, {
        kind: 'browser',
        id: info.sessionId ?? fallbackClientId,
      });
      const existing = await opts.sessions.getSessionByKey(laneKey);
      const row =
        existing ??
        (await opts.sessions.createSession({
          key: laneKey,
          platform,
          model: opts.defaults.model,
          provider: opts.defaults.provider,
          ...(info.personalityId ? { personalityId: info.personalityId } : {}),
          ...(opts.defaults.workingDir ? { workingDir: opts.defaults.workingDir } : {}),
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0,
            apiCallCount: 0,
            compactionCount: 0,
          },
        }));
      const toolset = info.personalityId
        ? opts.personalities.get(info.personalityId)?.toolset
        : undefined;
      return {
        laneKey,
        storeSessionId: row.id,
        host: createRealtimeToolHost({
          registry: opts.toolRegistry,
          ...(opts.hooks ? { hooks: opts.hooks } : {}),
          ...(toolset ? { personalityToolset: toolset } : {}),
        }),
        workingDir: row.workingDir ?? opts.defaults.workingDir ?? process.cwd(),
        ...(info.personalityId ? { personalityId: info.personalityId } : {}),
      };
    },

    async persistTranscript(binding, role, text): Promise<void> {
      // The provider's SETTLED transcript, stored as if it had been typed.
      // Nothing else about the audio is kept — that is the anti-goal holding,
      // not an omission.
      await opts.sessions.appendMessage({
        sessionId: binding.storeSessionId,
        role,
        content: text,
      });
    },
  };
}
