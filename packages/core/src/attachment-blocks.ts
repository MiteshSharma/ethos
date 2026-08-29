import type { Attachment, AttachmentCache, MessageContent, Storage } from '@ethosagent/types';
import { VISION_MAX_BLOCKS_PER_TURN, visionMaxBytesFor } from '@ethosagent/types';

/**
 * C1 — encoding native attachments as inline `image`/`document` blocks, so a
 * vision-capable model sees the pixels rather than a filename.
 *
 * Sits beside {@link ../attachment-classifier} (which decides an attachment's
 * class) and {@link ../attachment-text-resolver} (which inlines text): this
 * module owns only the block path, and never the annotation, which is emitted
 * for native attachments either way.
 */

/** Which native media a turn is allowed to inline. */
export interface NativeVisionSupport {
  images: boolean;
  documents: boolean;
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF_MEDIA_TYPE = 'application/pdf';

type ImageMediaType = Extract<MessageContent, { type: 'image' }>['mediaType'];

/**
 * Whether `att` can be sent inline to a model with `vision` support.
 *
 * Media type decides, not `Attachment.type`: a channel may label a PDF as a
 * generic `file`, and the two capability flags are independent — a provider
 * that takes images may still reject documents.
 */
export function canInlineNatively(att: Attachment, vision: NativeVisionSupport): boolean {
  const mediaType = att.mimeType.toLowerCase();
  if (IMAGE_MEDIA_TYPES.has(mediaType)) return vision.images;
  if (mediaType === PDF_MEDIA_TYPE) return vision.documents;
  return false;
}

/**
 * Read `candidates` and encode them as inline blocks.
 *
 * Going over {@link VISION_MAX_BLOCKS_PER_TURN} reverts the WHOLE turn to
 * annotation rather than sending a truncated subset: a model shown 8 of 20
 * screenshots answers confidently about the 8 and never mentions the 12. The
 * returned error names the cap so the model can say so instead.
 *
 * A single unreadable or oversized file costs only itself — it degrades to the
 * annotation that was already emitted for it, and the rest still go inline.
 */
export async function encodeNativeBlocks(
  candidates: readonly Attachment[],
  io: { storage?: Storage; attachmentCache?: AttachmentCache },
): Promise<{ blocks: MessageContent[]; errors: string[] }> {
  if (candidates.length === 0) return { blocks: [], errors: [] };

  if (candidates.length > VISION_MAX_BLOCKS_PER_TURN) {
    return {
      blocks: [],
      errors: [
        `${candidates.length} images/documents attached; at most ${VISION_MAX_BLOCKS_PER_TURN} can be viewed in one turn. ` +
          'They are listed by name below — ask about one to view it.',
      ],
    };
  }

  const blocks: MessageContent[] = [];
  const errors: string[] = [];

  for (const att of candidates) {
    const label = att.filename ?? att.mimeType;
    const mediaType = att.mimeType.toLowerCase();
    try {
      const bytes = await readAttachmentBytes(att, io);
      const max = visionMaxBytesFor(mediaType);
      if (bytes.length > max) {
        errors.push(
          `"${label}" is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB, over the ${(max / (1024 * 1024)).toFixed(0)} MB limit for inline viewing`,
        );
        continue;
      }
      const data = Buffer.from(bytes).toString('base64');
      const filename = att.filename;
      blocks.push(
        mediaType === PDF_MEDIA_TYPE
          ? { type: 'document', mediaType: PDF_MEDIA_TYPE, data, ...(filename ? { filename } : {}) }
          : {
              type: 'image',
              mediaType: mediaType as ImageMediaType,
              data,
              ...(filename ? { filename } : {}),
            },
      );
    } catch {
      errors.push(`"${label}" could not be read for inline viewing`);
    }
  }

  return { blocks, errors };
}

/** Bytes behind an attachment URL. Throws when the URL cannot be resolved. */
async function readAttachmentBytes(
  att: Attachment,
  io: { storage?: Storage; attachmentCache?: AttachmentCache },
): Promise<Uint8Array> {
  if (att.url.startsWith('file://') && io.attachmentCache && io.storage) {
    const localPath = io.attachmentCache.resolveLocalPath(att.url);
    const raw = await io.storage.readBytes(localPath);
    if (!raw) throw new Error('File not found');
    return raw;
  }
  if (att.url.startsWith('data:')) {
    const commaIdx = att.url.indexOf(',');
    if (commaIdx < 0) throw new Error('Invalid data: URL');
    return Uint8Array.from(Buffer.from(att.url.slice(commaIdx + 1), 'base64'));
  }
  throw new Error('Unsupported URL scheme');
}
