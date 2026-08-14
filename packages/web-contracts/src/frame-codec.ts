// The binary frame codec shared by every Ethos WebSocket audio lane.
//
// Two lanes speak this layout today — the browser ↔ web-api voice lane
// (`voice-socket.ts`) and the wake-satellite ↔ gateway lane
// (`satellite-socket.ts`) — and both carry the same thing: a small JSON control
// header in front of an optional slab of PCM.
//
//   ┌────────┬──────────────┬─────────────────────┬──────────────────┐
//   │ ver:u8 │ headerLen:u16│ header (UTF-8 JSON) │ payload (bytes)  │
//   └────────┴──────────────┴─────────────────────┴──────────────────┘
//        0         1..2            3..3+len            3+len..end
//
// `headerLen` is big-endian. There are no text frames: a control message is a
// frame with an empty payload, so a lane has exactly one decode path.
//
// WHY THIS IS ONE FILE AND NOT TWO COPIES: the layout is a wire contract, and a
// wire contract that exists twice drifts. The second copy is always the one that
// forgets the 64 KiB guard, or reads the length little-endian, or stops
// bounds-checking the truncated case — and the symptom is a lane that silently
// mis-frames audio rather than a compile error. The version byte stays a
// PARAMETER rather than a constant here precisely so the two lanes can version
// independently: bumping the satellite framing must not invalidate every browser
// call in flight.
//
// This file owns framing and nothing else. It never sees a schema: what a header
// is allowed to say belongs to the lane that defines it, and each lane parses
// its own union with Zod after `splitFrame` hands back the raw value.

/** Bytes before the header begins: one version byte plus a u16 length. */
export const FRAME_HEADER_OFFSET = 3;

const MAX_HEADER_BYTES = 0xffff;

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encode one length-prefixed frame. `payload` is empty for control frames.
 *
 * Throws when the serialized header exceeds the u16 length field. A header that
 * large is a caller bug (a control message is tens of bytes; audio belongs in
 * the payload) and truncating it would produce a frame that decodes to
 * plausible-looking nonsense on the far side.
 */
export function encodeFrame(version: number, header: unknown, payload?: Uint8Array): Uint8Array {
  const headerBytes = encoder.encode(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_BYTES) {
    throw new Error('Frame header exceeds 64 KiB');
  }
  const body = payload ?? EMPTY;
  const out = new Uint8Array(FRAME_HEADER_OFFSET + headerBytes.length + body.length);
  out[0] = version;
  out[1] = (headerBytes.length >> 8) & 0xff;
  out[2] = headerBytes.length & 0xff;
  out.set(headerBytes, FRAME_HEADER_OFFSET);
  out.set(body, FRAME_HEADER_OFFSET + headerBytes.length);
  return out;
}

/**
 * The outcome of splitting one frame. A DISCRIMINATED RESULT rather than
 * `T | null`, because the four ways framing fails are four different bugs — a
 * satellite built against another framing version, a proxy that truncated a
 * message, a sender that wrote text where bytes were expected — and a lane that
 * can only say "malformed" sends whoever is holding the pager to read all of
 * them. `reason` is derived from the LENGTHS and the version byte only: no
 * header text and no payload bytes ever reach it, so it is safe to log.
 */
export type FrameSplit =
  | { ok: true; header: unknown; payload: Uint8Array }
  | { ok: false; reason: string };

/**
 * Split a frame into its raw header value and payload, or say why it is not a
 * frame — too short to hold a prefix, a version byte this lane does not speak,
 * a length that claims more bytes than arrived, or a header that is not JSON.
 *
 * The header comes back as `unknown` on purpose. Framing can only tell you that
 * bytes were shaped like a frame; whether the header means anything is the
 * lane's question, answered by its own Zod union. Returning a typed value here
 * would be a cast wearing a helpful face.
 */
export function splitFrame(version: number, bytes: Uint8Array): FrameSplit {
  if (bytes.length < FRAME_HEADER_OFFSET) {
    return {
      ok: false,
      reason: `frame is ${bytes.length} bytes, shorter than the ${FRAME_HEADER_OFFSET}-byte prefix`,
    };
  }
  if (bytes[0] !== version) {
    return {
      ok: false,
      reason: `framing version ${bytes[0]}, and this lane speaks ${version}`,
    };
  }
  const headerLen = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  const headerEnd = FRAME_HEADER_OFFSET + headerLen;
  if (bytes.length < headerEnd) {
    return {
      ok: false,
      reason: `header claims ${headerLen} bytes but only ${bytes.length - FRAME_HEADER_OFFSET} arrived`,
    };
  }
  let header: unknown;
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(FRAME_HEADER_OFFSET, headerEnd)));
  } catch {
    return { ok: false, reason: `the ${headerLen}-byte header is not JSON` };
  }
  return { ok: true, header, payload: bytes.subarray(headerEnd) };
}

/**
 * Read a PCM payload as 16-bit samples. Copies: a WebSocket payload can land
 * at any byte offset in its backing buffer, and `new Int16Array(buf, offset)`
 * throws on an odd one. A trailing odd byte is dropped rather than throwing —
 * a truncated frame must not kill a live call.
 */
export function pcm16FromBytes(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (((bytes[i * 2] ?? 0) | ((bytes[i * 2 + 1] ?? 0) << 8)) << 16) >> 16;
  }
  return samples;
}

/** Serialize 16-bit samples as little-endian payload bytes. */
export function pcm16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] ?? 0;
    out[i * 2] = value & 0xff;
    out[i * 2 + 1] = (value >> 8) & 0xff;
  }
  return out;
}
