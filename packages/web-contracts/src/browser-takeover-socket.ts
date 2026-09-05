import { z } from 'zod';
import { encodeFrame, FRAME_HEADER_OFFSET, splitFrame } from './frame-codec';

// Wire format for the browser ↔ web-api SCREENCAST TAKEOVER lane (B3).
//
// The agent has handed its browser to a human (`browser_request_takeover`, a
// clarify of kind `browser_takeover`). On a desktop that runs the browser
// headed, the human just uses the real window. On a headless VPS there is no
// window, so this lane carries one: JPEG frames off CDP's `Page.startScreencast`
// down, pointer and key events up, and one `handback` frame that resolves the
// clarify the agent is parked on.
//
// Same frame layout as every other Ethos socket (`frame-codec.ts`): a version
// byte, a u16 header length, a UTF-8 JSON header, then an opaque payload. This
// lane's payload is a JPEG rather than PCM, which is the one thing that makes
// its size posture different from the voice lane's: the codec's 64 KiB cap is
// on the HEADER only, and a screencast frame is unbounded. Bounding it is this
// lane's job on both ends — see `MAX_TAKEOVER_FRAME_BYTES` and the quality /
// dimension caps the server hands `Page.startScreencast`.
//
// The version byte is a PARAMETER of the codec precisely so lanes version
// independently; this one starts at 1 and is unrelated to the voice lane's.

/** Path this lane is mounted at, relative to the web-api origin. */
export const BROWSER_TAKEOVER_SOCKET_PATH = '/browser/takeover/ws';

/** Framing version. Bump only for an incompatible layout change. */
export const BROWSER_TAKEOVER_VERSION = 1;

/**
 * Hard ceiling on ONE screencast frame's payload, server side.
 *
 * The server asks CDP for a bounded image (`maxWidth`/`maxHeight`/`quality`),
 * but those are a request, not a guarantee: a page that repaints a full-bleed
 * photograph can still produce a frame several times the usual size. A frame
 * over this cap is DROPPED and acked rather than sent — a dropped frame costs
 * the viewer one repaint, and an unbounded one costs the process its heap and
 * the socket its latency for as long as it takes to drain.
 */
export const MAX_TAKEOVER_FRAME_BYTES = 512 * 1024;

/**
 * Screencast dimension and quality caps handed to `Page.startScreencast`.
 * Deliberately modest: this is a remote-control view of a login form, not a
 * video call, and every byte here is one a person is waiting on.
 */
export const TAKEOVER_SCREENCAST = {
  maxWidth: 1280,
  maxHeight: 800,
  /** JPEG quality, 0-100. */
  quality: 60,
} as const;

/**
 * Longest `sessionId` or `requestId` a `hello` may carry.
 *
 * Both are opaque to this lane — it mints neither — so it declares a ceiling
 * rather than guessing their shape. Generous by an order of magnitude against
 * what the producers actually mint: a clarify id is a `randomUUID()` (36
 * chars) and a browser session id is an agent session key. The point is that
 * the ceiling EXISTS: it is what makes the client-frame bound below a
 * derivation rather than a guess.
 */
export const MAX_TAKEOVER_ID_CHARS = 256;

/**
 * Hard ceiling on ONE client-to-server frame, in bytes on the wire.
 *
 * Derived from the frame shapes below, not chosen. Every client frame on this
 * lane is a small JSON header with an EMPTY payload — hello, ack, mouse, key,
 * handback, none of which carry bytes — so the largest legitimate frame is the
 * codec's 3-byte prefix plus the largest header the schemas admit. That is a
 * `hello`: its two ids are the only unbounded-length strings in the union
 * (`key`/`code`/`text` cap at 32/32/8, every other field is a bounded number),
 * so it dominates the ~520-byte worst-case `key` frame by a wide margin.
 *
 * The per-character factor is 6, the worst case `JSON.stringify` can produce
 * for one UTF-16 code unit: a control character escapes to `\uXXXX`, six ASCII
 * bytes. Raw UTF-8 is cheaper (3 bytes for a BMP unit, 2 per unit for a
 * surrogate pair), so 6 bounds every input, not just the ASCII one.
 *
 * This is the bound the server hands `ws` as `maxPayload`. Without it the lane
 * runs on the library's multi-megabyte default while speaking in bytes, and any
 * authenticated client can make the process allocate megabytes per message.
 * `MAX_TAKEOVER_FRAME_BYTES` does not help: it bounds server-to-client JPEGs.
 */
export const MAX_TAKEOVER_CLIENT_FRAME_BYTES =
  FRAME_HEADER_OFFSET +
  // `{"t":"hello","sessionId":"","requestId":""}` — the header with both ids empty.
  new TextEncoder().encode(JSON.stringify({ t: 'hello', sessionId: '', requestId: '' })).length +
  2 * MAX_TAKEOVER_ID_CHARS * 6;

// --- client → server -------------------------------------------------------

/**
 * Opens the lane. `sessionId` names the BROWSER session the agent locked
 * (`ClarifyMeta.sessionId`); `requestId` is the clarify the agent is parked on,
 * which is what a `handback` resolves. Both come from the `clarify.request`
 * event the browser already received — this lane mints neither.
 */
const ClientHelloSchema = z.object({
  t: z.literal('hello'),
  sessionId: z.string().min(1).max(MAX_TAKEOVER_ID_CHARS),
  requestId: z.string().min(1).max(MAX_TAKEOVER_ID_CHARS),
});

/**
 * One pointer event, in CSS pixels of the SCREENCAST image. The server scales
 * them to page coordinates using the metadata CDP reported for the frame the
 * click was aimed at, so a client that renders the image at any size does not
 * have to know the page's own dimensions.
 */
const ClientMouseSchema = z.object({
  t: z.literal('mouse'),
  type: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']),
  /** Fraction of the image width/height, 0-1. Resolution-independent by
   *  construction: no client-side guess about the page's real size. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  button: z.enum(['none', 'left', 'middle', 'right']).optional(),
  clickCount: z.number().int().min(0).max(3).optional(),
  deltaX: z.number().finite().optional(),
  deltaY: z.number().finite().optional(),
  modifiers: z.number().int().min(0).max(15).optional(),
});

const ClientKeySchema = z.object({
  t: z.literal('key'),
  type: z.enum(['keyDown', 'keyUp', 'char']),
  /** `KeyboardEvent.key`. */
  key: z.string().max(32).optional(),
  /** `KeyboardEvent.code`. */
  code: z.string().max(32).optional(),
  /** The character a `char` event inserts. Bounded — this is not a paste lane. */
  text: z.string().max(8).optional(),
  keyCode: z.number().int().min(0).max(255).optional(),
  modifiers: z.number().int().min(0).max(15).optional(),
});

/**
 * The viewer has painted frame `seq` and is ready for the next one. CDP stops
 * emitting until `Page.screencastFrameAck`, which is what keeps a slow client
 * from queueing frames it will never draw.
 */
const ClientAckSchema = z.object({
  t: z.literal('ack'),
  seq: z.number().int().nonnegative(),
});

/** Done — resolve the clarify and give the browser back to the agent. */
const ClientHandbackSchema = z.object({
  t: z.literal('handback'),
});

const BrowserTakeoverClientFrameSchema = z.discriminatedUnion('t', [
  ClientHelloSchema,
  ClientMouseSchema,
  ClientKeySchema,
  ClientAckSchema,
  ClientHandbackSchema,
]);

export type BrowserTakeoverClientFrame = z.infer<typeof BrowserTakeoverClientFrameSchema>;

// --- server → client -------------------------------------------------------

const ServerReadySchema = z.object({
  t: z.literal('ready'),
  url: z.string(),
  protocolVersion: z.number().int().positive(),
});

/**
 * One screencast frame. The payload is the JPEG. `width`/`height` are the
 * page's own CSS dimensions for this frame, reported by CDP — the client sends
 * pointer positions back as fractions, so these are for display only.
 */
const ServerFrameSchema = z.object({
  t: z.literal('frame'),
  seq: z.number().int().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
});

/** The page navigated. The side column's URL follows it. */
const ServerUrlSchema = z.object({
  t: z.literal('url'),
  url: z.string(),
});

/**
 * The lane is over. `handed_back` — this viewer resolved the clarify.
 * `taken_over` — a second tab claimed the same takeover and this one is done.
 * `session_gone` — the browser session went away underneath (closed, or the
 * takeover ended somewhere else).
 */
const ServerClosedSchema = z.object({
  t: z.literal('closed'),
  reason: z.enum(['handed_back', 'taken_over', 'session_gone']),
});

const ServerErrorSchema = z.object({
  t: z.literal('error'),
  code: z.enum([
    /** No browser session with that id in THIS process — see the honest
     *  refusal in `takeover-socket.ts`. */
    'session_unavailable',
    /** A session was found but no takeover is live on it. */
    'not_in_takeover',
    /** A second tab took the lane. */
    'taken_over',
    /** The header was not a frame this lane speaks. */
    'bad_frame',
    /** CDP refused to start or keep the screencast. */
    'screencast_failed',
    /**
     * The hand-back did not resolve the clarify — expired, cancelled, already
     * settled, or the bridge refused it. The takeover is STILL LIVE: reporting
     * `closed: handed_back` here would tell the viewer they are done while the
     * agent stays parked, so the lane says so and stays open for a retry.
     */
    'handback_failed',
  ]),
  message: z.string(),
});

const BrowserTakeoverServerFrameSchema = z.discriminatedUnion('t', [
  ServerReadySchema,
  ServerFrameSchema,
  ServerUrlSchema,
  ServerClosedSchema,
  ServerErrorSchema,
]);

export type BrowserTakeoverServerFrame = z.infer<typeof BrowserTakeoverServerFrameSchema>;

/** A decoded frame: its parsed header plus the binary payload that followed. */
export interface DecodedBrowserTakeoverFrame<T> {
  header: T;
  payload: Uint8Array;
}

/** Encode one frame. `payload` is empty for everything but `frame`. */
export function encodeBrowserTakeoverFrame(
  header: BrowserTakeoverClientFrame | BrowserTakeoverServerFrame,
  payload?: Uint8Array,
): Uint8Array {
  return encodeFrame(BROWSER_TAKEOVER_VERSION, header, payload);
}

/**
 * Decode a frame sent by the browser. Null for anything off-contract — the
 * header is untrusted input off a socket, so it is parsed with Zod, never cast.
 */
export function decodeBrowserTakeoverClientFrame(
  bytes: Uint8Array,
): DecodedBrowserTakeoverFrame<BrowserTakeoverClientFrame> | null {
  const split = splitFrame(BROWSER_TAKEOVER_VERSION, bytes);
  if (!split.ok) return null;
  const parsed = BrowserTakeoverClientFrameSchema.safeParse(split.header);
  return parsed.success ? { header: parsed.data, payload: split.payload } : null;
}

/** Decode a frame sent by the server. Same untrusted-input posture. */
export function decodeBrowserTakeoverServerFrame(
  bytes: Uint8Array,
): DecodedBrowserTakeoverFrame<BrowserTakeoverServerFrame> | null {
  const split = splitFrame(BROWSER_TAKEOVER_VERSION, bytes);
  if (!split.ok) return null;
  const parsed = BrowserTakeoverServerFrameSchema.safeParse(split.header);
  return parsed.success ? { header: parsed.data, payload: split.payload } : null;
}
