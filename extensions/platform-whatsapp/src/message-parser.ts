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
  messageTimestamp?: number;
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
  const botNumber = botJid.split('@')[0].split(':')[0];
  const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  const isGroupMention =
    !isDm &&
    (mentionedJids?.some((j) => j.split('@')[0].split(':')[0] === botNumber) ||
      text.includes(`@${botNumber}`));

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
