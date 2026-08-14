/**
 * Size caps for inline vision/document content.
 *
 * Two callers share these: the `vision_analyze` tool, which resolves a file
 * from a path/URL/base64 argument, and the agent loop's native-attachment
 * path, which inlines a channel upload into the user turn. They live here
 * rather than in either caller so a cap change moves both at once — core
 * cannot import an extension, and duplicating the numbers is how the two
 * paths drift.
 */

/** Largest image accepted as an inline `image` block. */
export const VISION_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Largest PDF accepted as an inline `document` block. */
export const VISION_PDF_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Coarse cap applied while streaming a remote file, before its media type is
 * known. Set to the largest per-media limit so no download runs that would be
 * rejected on size anyway; the per-media check still runs after detection.
 */
export const VISION_URL_STREAM_MAX_BYTES = VISION_PDF_MAX_BYTES;

/**
 * Maximum inline image/document blocks in a single user turn. Overflow reverts
 * that turn to the `<attachments>` annotation instead of silently dropping
 * blocks, so the model is told what it is not seeing.
 */
export const VISION_MAX_BLOCKS_PER_TURN = 8;

/** The per-media byte cap for `mediaType`. */
export function visionMaxBytesFor(mediaType: string): number {
  return mediaType === 'application/pdf' ? VISION_PDF_MAX_BYTES : VISION_IMAGE_MAX_BYTES;
}
