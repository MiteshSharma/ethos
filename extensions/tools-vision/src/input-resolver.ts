// Input resolver for vision tools — the security-critical edge between user
// input and the bytes we hand to a vision-capable LLM.
//
// Three input shapes, mutually exclusive:
//   - file_path:  routed through ctx.scopedFs (ScopedFs) which enforces the
//                 personality path allowlist and reads the file in one call.
//                 No direct node:fs import — all filesystem access goes
//                 through the ScopedFs abstraction.
//   - file_url:   routed through @ethosagent/safety-network's safeFetch for
//                 the full SSRF pipeline (scheme + cloud-metadata + private-
//                 network + redirect revalidation). Streamed; aborts at 32MB.
//   - file_base64: decoded from a base64 string (with optional data: prefix).
//
// Media type is detected from magic bytes (NOT extension) — extension can be
// forged. Accepted: PNG / JPEG / GIF / WEBP / PDF. Anything else is
// UNSUPPORTED_FILE_TYPE. Per-media size caps: 5 MB for images, 32 MB for PDFs.

import { isAbsolute, resolve as resolvePath } from 'node:path';
import { type NetworkPolicy, safeFetch } from '@ethosagent/safety-network';
import { type ScopedFs, VISION_URL_STREAM_MAX_BYTES, visionMaxBytesFor } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Path normalization — security-critical
// ---------------------------------------------------------------------------
//
// `resolvePath()` collapses `..` / `.` segments before ScopedFs sees the path.
// Without this, an absolute path like `/safe/../etc/passwd` would lexically
// start with an allowed `/safe/` prefix at the ScopedFs gate (which uses
// `normalize(resolve(path))` + `startsWith`) and sneak through.
//
// Symlink canonicalization (`realpath`) is no longer needed here:
// ScopedFsImpl.checkReach() normalizes internally via `normalize(resolve())`,
// and the read itself goes through Storage (which reads by path, not by fd).
// The TOCTOU window is the same as before — a shared native O_NOFOLLOW /
// dirfd helper is still deferred (see tools-file).
function normalizeAbsolute(filePath: string, workingDir: string | undefined): string {
  return isAbsolute(filePath)
    ? resolvePath(filePath)
    : resolvePath(workingDir ?? process.cwd(), filePath);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolveInput {
  file_path?: string;
  file_url?: string;
  file_base64?: string;
}

export type ResolvedMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'application/pdf';

export interface ResolvedFile {
  mediaType: ResolvedMediaType;
  buffer: Buffer;
}

export type VisionInputErrorCode =
  | 'INVALID_INPUT'
  | 'FILE_NOT_FOUND'
  | 'URL_BLOCKED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE';

export class VisionInputError extends Error {
  readonly code: VisionInputErrorCode;

  constructor(code: VisionInputErrorCode, message: string) {
    super(message);
    this.name = 'VisionInputError';
    this.code = code;
  }
}

export interface ResolveContext {
  /** Required for file_path mode — ScopedFs enforces the path allowlist and reads in one call. */
  scopedFs?: ScopedFs;
  /** Working directory used to resolve relative file_path inputs. */
  workingDir?: string;
  /** Network policy threaded into safeFetch for file_url mode. */
  networkPolicy?: NetworkPolicy;
  /** Injected fetch implementation. Tests only — production uses global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected DNS resolver. Tests only — production uses node:dns. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Abort signal forwarded into safeFetch. */
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

// The caps themselves live in `@ethosagent/types` (`vision-limits.ts`) because
// the agent loop's native-attachment path applies the same limits and core
// cannot import an extension.

// ---------------------------------------------------------------------------
// resolveFile
// ---------------------------------------------------------------------------

export async function resolveFile(input: ResolveInput, ctx: ResolveContext): Promise<ResolvedFile> {
  const keysSet = [
    input.file_path !== undefined,
    input.file_url !== undefined,
    input.file_base64 !== undefined,
  ].filter(Boolean).length;
  if (keysSet !== 1) {
    throw new VisionInputError(
      'INVALID_INPUT',
      'exactly one of file_path, file_url, file_base64 must be set',
    );
  }

  let buffer: Buffer;
  if (input.file_path !== undefined) {
    buffer = await readFromPath(input.file_path, ctx);
  } else if (input.file_url !== undefined) {
    buffer = await readFromUrl(input.file_url, ctx);
  } else if (input.file_base64 !== undefined) {
    buffer = decodeBase64(input.file_base64);
  } else {
    // Unreachable — the `keysSet === 1` check above guarantees one is set.
    throw new VisionInputError('INVALID_INPUT', 'no input key set');
  }

  const mediaType = detectMediaType(buffer);
  if (!mediaType) {
    throw new VisionInputError(
      'UNSUPPORTED_FILE_TYPE',
      'file is not one of image/png, image/jpeg, image/gif, image/webp, application/pdf',
    );
  }

  enforceSizeCap(buffer, mediaType);
  return { mediaType, buffer };
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

async function readFromPath(filePath: string, ctx: ResolveContext): Promise<Buffer> {
  if (!ctx.scopedFs) {
    throw new VisionInputError(
      'INVALID_INPUT',
      'file_path requires scopedFs on ToolContext; none was provided',
    );
  }

  // Normalize first so `..`/`.` segments collapse before ScopedFs sees
  // them — otherwise `/safe/../etc/passwd` lexically starts with `/safe/`
  // and sneaks past the prefix check. ScopedFsImpl normalizes internally
  // too, but we resolve relative paths against workingDir here.
  const absolutePath = normalizeAbsolute(filePath, ctx.workingDir);

  // Binary read via ScopedFs.readBytes — gates against the personality
  // read-reach allowlist AND returns raw bytes (no UTF-8 decode). The
  // legacy `read()` path returned a decoded string + `Buffer.from(..., 'latin1')`
  // round-trip; that broke for any file whose bytes aren't valid UTF-8
  // (every JPEG/PNG/PDF), because Node replaced bad sequences with U+FFFD
  // before the tool ever saw them.
  try {
    const bytes = await ctx.scopedFs.readBytes(absolutePath);
    return Buffer.from(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('PATH_NOT_REACHABLE') || msg.includes('File not found')) {
      throw new VisionInputError(
        'FILE_NOT_FOUND',
        `file not found or outside the personality allowlist: ${absolutePath}`,
      );
    }
    throw err;
  }
}

async function readFromUrl(url: string, ctx: ResolveContext): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VisionInputError('URL_BLOCKED', `invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new VisionInputError(
      'URL_BLOCKED',
      `unsupported URL scheme: ${parsed.protocol} (only http:/https: allowed)`,
    );
  }

  const policy: NetworkPolicy = ctx.networkPolicy ?? {};
  const result = await safeFetch(url, {
    policy,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.resolveHost ? { resolveHost: ctx.resolveHost } : {}),
    init: {
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
      headers: { Accept: 'image/*,application/pdf' },
    },
  });

  if (!result.ok) {
    throw new VisionInputError(
      'URL_BLOCKED',
      `network policy blocked '${result.url}' (hop ${result.hop}): ${result.reason}`,
    );
  }

  const { response } = result;
  if (!response.ok) {
    throw new VisionInputError('URL_BLOCKED', `HTTP ${response.status} ${response.statusText}`);
  }

  return await readResponseCapped(response, VISION_URL_STREAM_MAX_BYTES);
}

async function readResponseCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    // No streaming body — fall back to arrayBuffer then cap-check.
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new VisionInputError('FILE_TOO_LARGE', `downloaded file exceeds ${maxBytes} bytes`);
    }
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new VisionInputError(
          'FILE_TOO_LARGE',
          `download exceeded ${maxBytes} bytes; aborted`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

function decodeBase64(raw: string): Buffer {
  if (!raw) {
    throw new VisionInputError('INVALID_INPUT', 'file_base64 is empty');
  }
  // Strip optional data: URI prefix — `data:<mime>;base64,<payload>`.
  const stripped = raw.replace(/^data:[^;,]*;base64,/i, '');
  const buf = Buffer.from(stripped, 'base64');
  if (buf.length === 0) {
    throw new VisionInputError('INVALID_INPUT', 'file_base64 decoded to zero bytes');
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Magic-byte detection
// ---------------------------------------------------------------------------

function detectMediaType(buf: Buffer): ResolvedMediaType | null {
  if (buf.length < 4) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: GIF87a / GIF89a (47 49 46 38 ...)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }

  // WEBP: 'RIFF' .... 'WEBP'  (offsets 0-3 and 8-11)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }

  // PDF: '%PDF-' (25 50 44 46 2D). Some PDFs allow a few junk bytes before
  // the header — RFC 32000-1 §7.5.2 only requires the marker to appear in
  // the first 1024 bytes. We're stricter: require it at offset 0. Real
  // producers conform; this rules out a class of polyglot attacks.
  if (
    buf.length >= 5 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46 &&
    buf[4] === 0x2d
  ) {
    return 'application/pdf';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

function enforceSizeCap(buf: Buffer, mediaType: ResolvedMediaType): void {
  const max = visionMaxBytesFor(mediaType);
  if (buf.length > max) {
    throw new VisionInputError(
      'FILE_TOO_LARGE',
      `${mediaType} file is ${buf.length} bytes; max is ${max}`,
    );
  }
}
