import type { Attachment, AttachmentCache, Storage } from '@ethosagent/types';

// Max raw bytes to read per text file (1 MB)
const TEXT_MAX_BYTES = 1 * 1024 * 1024;
// Max chars to inline per file after decoding
const TEXT_MAX_CHARS = 50_000;

export interface ResolvedTextAttachment {
  attachment: Attachment;
  text: string;
  truncatedFromChars?: number;
}

/**
 * Read bytes from a text attachment, decode to UTF-8, and cap to the char limit.
 * Supports file:// URLs (via attachmentCache + storage) and data: URLs (base64 decode).
 */
export async function resolveTextAttachment(
  att: Attachment,
  storage: Storage | undefined,
  attachmentCache: AttachmentCache | undefined,
): Promise<ResolvedTextAttachment> {
  let bytes: Uint8Array;

  if (att.url.startsWith('file://') && attachmentCache && storage) {
    const localPath = attachmentCache.resolveLocalPath(att.url);
    const raw = await storage.readBytes(localPath);
    if (!raw) {
      throw new Error(`Attachment file not found: ${localPath}`);
    }
    bytes = raw;
  } else if (att.url.startsWith('data:')) {
    const commaIdx = att.url.indexOf(',');
    if (commaIdx < 0) throw new Error('Invalid data: URL');
    const base64 = att.url.slice(commaIdx + 1);
    bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  } else {
    throw new Error(`Cannot read text from URL scheme: ${att.url.split(':')[0]}`);
  }

  // Size cap on raw bytes
  const cappedBytes = bytes.length > TEXT_MAX_BYTES ? bytes.slice(0, TEXT_MAX_BYTES) : bytes;

  // Decode UTF-8
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = decoder.decode(cappedBytes);

  // Cap on decoded chars
  let truncatedFromChars: number | undefined;
  if (text.length > TEXT_MAX_CHARS) {
    truncatedFromChars = text.length;
    text = text.slice(0, TEXT_MAX_CHARS);
  } else if (bytes.length > TEXT_MAX_BYTES) {
    truncatedFromChars = text.length; // We capped bytes, text might be shorter
  }

  return { attachment: att, text, truncatedFromChars };
}

/**
 * Sanitize a filename for safe inclusion in prompt delimiters.
 * Collapses control characters, removes newlines, and truncates.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\r\n]/g, ' ') // no newlines
    .replace(/[^\x20-\x7E]/g, '_') // only printable ASCII
    .replace(/={3,}/g, '==') // break delimiter-like sequences
    .slice(0, 200); // cap length
}

/**
 * Format an inlined text attachment as a delimited block.
 */
export function formatInlinedAttachment(resolved: ResolvedTextAttachment): string {
  const name = sanitizeFilename(resolved.attachment.filename ?? 'unnamed');
  const truncNote = resolved.truncatedFromChars
    ? ` [truncated to ${resolved.text.length.toLocaleString('en-US')} chars from ${resolved.truncatedFromChars.toLocaleString('en-US')}]`
    : '';
  return `=== file: ${name}${truncNote} ===\n${resolved.text}\n=== end file ===`;
}
