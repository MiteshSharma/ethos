import type { Attachment, AttachmentCache } from '@ethosagent/types';
import type { RawWhatsAppMessage } from './message-parser';
import { getMediaMeta } from './message-parser';

/** Default inbound-media ceiling. Overridable per deployment via
 *  `gateway.maxInboundMediaBytes` → `WhatsAppAdapterConfig.maxInboundMediaBytes`. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB

function getFileLength(msg: RawWhatsAppMessage): number | null {
  const m = msg.message;
  const len =
    m?.imageMessage?.fileLength ??
    m?.documentMessage?.fileLength ??
    m?.audioMessage?.fileLength ??
    m?.videoMessage?.fileLength;
  return typeof len === 'number' ? len : null;
}

export async function downloadMedia(
  msg: RawWhatsAppMessage,
  downloadFn: (msg: RawWhatsAppMessage) => Promise<Buffer>,
  cache: AttachmentCache,
  sessionKey: string,
  maxBytes = MAX_MEDIA_BYTES,
): Promise<Attachment | null> {
  const meta = getMediaMeta(msg);
  if (!meta) return null;

  // Check declared file size before downloading
  const fileLength = getFileLength(msg);
  if (fileLength && fileLength > maxBytes) {
    return null;
  }

  const bytes = await downloadFn(msg);

  // Double-check actual size after download
  if (bytes.length > maxBytes) {
    return null;
  }

  const url = await cache.write(new Uint8Array(bytes), {
    sessionKey,
    messageId: msg.key.id ?? `wa-${Date.now()}`,
    filename: meta.filename,
    mime: meta.mime,
  });

  return {
    type: meta.type,
    ref: `wa-${msg.key.id ?? Date.now()}`,
    url,
    mimeType: meta.mime,
    filename: meta.filename,
  };
}
