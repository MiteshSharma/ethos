import type { DeliveryResult, InboundMessage, OutboundMessage, PlatformAdapter } from '@ethosagent/types';
import type { ChannelPlugin, OpenClawPluginChannelRegistration } from './types';

/**
 * Wraps an OpenClaw `ChannelPlugin` descriptor as an Ethos `PlatformAdapter`.
 *
 * OpenClaw channels are declarative descriptors with typed sub-adapters
 * (`outbound`, `gateway`, `lifecycle`). Ethos channels are imperative objects
 * with direct methods (`start`, `stop`, `send`, `onMessage`).
 *
 * Key uncertainties (U3, U4 from plan/openclaw_api_surface.md):
 * - `ChannelOutboundAdapter.send()` parameter shape is inferred from DingTalk plugin
 * - `ChannelGatewayAdapter.onMessage()` shape is inferred from real plugin patterns
 *
 * Both adapter paths include fallback behaviour and log warnings for gaps.
 */
export function translateChannelPlugin(plugin: ChannelPlugin): PlatformAdapter {
  const caps = plugin.capabilities;

  return {
    id: String(plugin.id),
    displayName: plugin.meta.label,

    // Capability flags — mapped from ChannelCapabilities
    canSendTyping: false, // no typing indicator field in ChannelCapabilities
    canEditMessage: caps.edit ?? false,
    canReact: caps.reactions ?? false,
    canSendFiles: caps.media ?? false,
    maxMessageLength: 4000, // no equivalent in ChannelCapabilities; use safe default

    async start(): Promise<void> {
      if (plugin.lifecycle?.runStartupMaintenance) {
        await plugin.lifecycle.runStartupMaintenance({
          cfg: {},
          log: {
            info: (msg) => process.stdout.write(`[openclaw-compat/${plugin.id}] ${msg}\n`),
            warn: (msg) => process.stderr.write(`[openclaw-compat/${plugin.id}] ${msg}\n`),
          },
        });
      }
    },

    async stop(): Promise<void> {
      // OpenClaw has no explicit stop — ChannelLifecycleAdapter.onAccountRemoved
      // is called by the host on config removal, not on graceful shutdown.
    },

    async send(chatId: string, message: OutboundMessage): Promise<DeliveryResult> {
      if (!plugin.outbound?.send) {
        console.warn(`[openclaw-compat] Channel "${plugin.id}" has no outbound.send — message dropped`);
        return { ok: false, error: 'no outbound adapter' };
      }
      try {
        // U4: ChannelOutboundAdapter.send shape inferred from real plugins
        const result = await plugin.outbound.send({
          chatId,
          message: {
            text: message.text,
            attachments: message.attachments,
            replyToId: message.replyToId,
            parseMode: message.parseMode,
          },
        });
        return { ok: true, messageId: result?.messageId };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    onMessage(handler: (message: InboundMessage) => void): void {
      if (!plugin.gateway?.onMessage) {
        console.warn(`[openclaw-compat] Channel "${plugin.id}" has no gateway.onMessage — inbound messages won't arrive`);
        return;
      }
      // U3: ChannelGatewayAdapter.onMessage event shape inferred from real plugins
      plugin.gateway.onMessage((event) => {
        const msg: InboundMessage = {
          platform: String(plugin.id),
          chatId: event.chatId,
          userId: event.userId,
          username: event.username,
          text: event.text,
          isDm: event.isDm ?? (caps.chatTypes.includes('dm') && !event.isGroupMention),
          isGroupMention: event.isGroupMention ?? false,
          messageId: event.messageId,
          attachments: mapAttachments(event.attachments),
          raw: event.raw ?? event,
        };
        handler(msg);
      });
    },

    async health(): Promise<{ ok: boolean; latencyMs?: number }> {
      // OpenClaw's ChannelStatusAdapter handles health probes, but its shape
      // is not in scope. Return ok=true unless we can do better.
      return { ok: true };
    },
  };
}

/**
 * Normalise the input to `api.registerChannel()` which accepts either a bare
 * `ChannelPlugin` or a `{ plugin: ChannelPlugin }` wrapper.
 */
export function unwrapChannelRegistration(
  reg: OpenClawPluginChannelRegistration | ChannelPlugin,
): ChannelPlugin {
  if ('plugin' in reg && reg.plugin && typeof reg.plugin === 'object' && 'id' in reg.plugin) {
    return (reg as OpenClawPluginChannelRegistration).plugin;
  }
  return reg as ChannelPlugin;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mapAttachments(
  raw: unknown[] | undefined,
): import('@ethosagent/types').Attachment[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const a = item as Record<string, unknown>;
    return [
      {
        type: (typeof a.type === 'string' ? a.type : 'file') as 'image' | 'file' | 'audio' | 'video',
        url: typeof a.url === 'string' ? a.url : undefined,
        mimeType: typeof a.mimeType === 'string' ? a.mimeType : 'application/octet-stream',
        filename: typeof a.filename === 'string' ? a.filename : undefined,
      },
    ];
  });
}
