import type { Attachment, InboundMessage } from '@ethosagent/types';
import { voiceAudioExtension, voiceAudioFormatFromMime } from '@ethosagent/types';

export interface RawWhatsAppMessage {
  key: {
    remoteJid: string | null | undefined;
    fromMe: boolean;
    id: string;
    participant?: string;
  };
  pushName?: string;
  message?: {
    conversation?: string;
    extendedTextMessage?: {
      text?: string;
      contextInfo?: {
        quotedMessage?: unknown;
        stanzaId?: string;
        mentionedJid?: string[];
      };
    };
    imageMessage?: {
      mimetype?: string;
      caption?: string;
      fileLength?: number;
    };
    documentMessage?: {
      mimetype?: string;
      fileName?: string;
      fileLength?: number;
    };
    audioMessage?: { mimetype?: string; fileLength?: number };
    videoMessage?: {
      mimetype?: string;
      caption?: string;
      fileLength?: number;
    };
  };
  /** Seconds since the epoch. protobufjs decodes this 64-bit field as a
   *  `Long` whenever the runtime has long.js available, so both shapes arrive
   *  in practice — `resolveSentAt` normalises them. */
  messageTimestamp?: number | { toNumber(): number } | null;
}

/**
 * The bot's own number as WhatsApp writes it in a JID: `<number>[:<device>]@<server>`.
 */
function botNumberOf(botJid: string): string {
  return botJid.split('@')[0].split(':')[0];
}

/**
 * Was the bot mentioned in this message?
 *
 * The ONE mention test for the adapter. The inbound gate used to carry its own
 * crude copy — a substring check over `conversation`/`extendedTextMessage`
 * only — which disagreed with this one twice: it never saw an image or video
 * CAPTION (so a captioned "@bot do X" was dropped before the parser ran), and
 * it never saw `contextInfo.mentionedJid` (so a mention chip with no literal
 * `@<number>` in the body was dropped too). Both call sites now share this
 * function so they cannot disagree again.
 *
 * Group-ness is the caller's business: this answers only "was I mentioned".
 */
export function isBotMentioned(msg: RawWhatsAppMessage, botJid: string): boolean {
  const botNumber = botNumberOf(botJid);
  const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  return (
    mentionedJids?.some((j) => botNumberOf(j) === botNumber) ||
    extractText(msg).includes(`@${botNumber}`)
  );
}

/**
 * Platform send time in MILLISECONDS, or `undefined` when WhatsApp sent none.
 *
 * WhatsApp reports `messageTimestamp` in seconds — as a plain number, or as a
 * protobufjs `Long` for the same field on the same connection. `Number(long)`
 * is `NaN`, so the Long branch goes through `toNumber()` rather than a cast.
 */
export function resolveSentAt(ts: RawWhatsAppMessage['messageTimestamp']): number | undefined {
  if (ts === undefined || ts === null) return undefined;
  const seconds = typeof ts === 'number' ? ts : ts.toNumber();
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1000);
}

export function parseInboundMessage(
  msg: RawWhatsAppMessage,
  botJid: string,
  botKey: string,
  attachments?: Attachment[],
): InboundMessage | null {
  if (msg.key.fromMe) return null;

  const jid = msg.key.remoteJid ?? '';
  const isDm = !jid.endsWith('@g.us');
  const text = extractText(msg);
  const isGroupMention = !isDm && isBotMentioned(msg, botJid);

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;

  return {
    platform: 'whatsapp',
    chatId: jid,
    userId: msg.key.participant ?? jid,
    username: msg.pushName ?? undefined,
    text,
    attachments,
    replyToId: contextInfo?.stanzaId ?? undefined,
    isDm,
    isGroupMention,
    messageId: msg.key.id ?? undefined,
    sentAt: resolveSentAt(msg.messageTimestamp),
    botKey,
    raw: msg,
  };
}

function extractText(msg: RawWhatsAppMessage): string {
  if (msg.message?.conversation) return msg.message.conversation;
  if (msg.message?.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
  if (msg.message?.imageMessage?.caption) return msg.message.imageMessage.caption;
  if (msg.message?.videoMessage?.caption) return msg.message.videoMessage.caption;
  return '';
}

export function hasMedia(msg: RawWhatsAppMessage): boolean {
  const m = msg.message;
  return !!(m?.imageMessage || m?.documentMessage || m?.audioMessage || m?.videoMessage);
}

export function getMediaMeta(
  msg: RawWhatsAppMessage,
): { mime: string; filename: string; type: 'image' | 'file' | 'audio' } | null {
  const m = msg.message;
  if (m?.imageMessage) {
    return {
      mime: m.imageMessage.mimetype ?? 'image/jpeg',
      filename: 'image.jpg',
      type: 'image',
    };
  }
  if (m?.documentMessage) {
    return {
      mime: m.documentMessage.mimetype ?? 'application/octet-stream',
      filename: m.documentMessage.fileName ?? 'document',
      type: 'file',
    };
  }
  if (m?.audioMessage) {
    // `type: 'audio'` is what the gateway's transcription gate keys on — a
    // push-to-talk memo classified as `file` never reaches STT. The extension
    // is derived from the mimetype rather than hardcoded, because WhatsApp
    // sends `audio/ogg; codecs=opus` for push-to-talk but `audio/mpeg` or
    // `audio/mp4` for a forwarded audio file, and both the transcode stage and
    // the STT providers key off the container.
    const mime = m.audioMessage.mimetype ?? 'audio/ogg';
    const format = voiceAudioFormatFromMime(mime);
    return {
      mime,
      filename: `audio.${format ? voiceAudioExtension(format) : 'ogg'}`,
      type: 'audio',
    };
  }
  if (m?.videoMessage) {
    return {
      mime: m.videoMessage.mimetype ?? 'video/mp4',
      filename: 'video.mp4',
      type: 'file',
    };
  }
  return null;
}
