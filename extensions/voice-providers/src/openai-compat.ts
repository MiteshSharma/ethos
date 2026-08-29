// Shared OpenAI-compatible voice transport.
//
// Both the cloud `openai-*` providers and the self-hosted `local-*` providers
// speak the same HTTP protocol: STT via `POST {baseUrl}/audio/transcriptions`
// (multipart file + model) and TTS via `POST {baseUrl}/audio/speech` (json).
// The only axis that differs is authentication: cloud endpoints require an API
// key; local servers (Kokoro, faster-whisper) usually need none. The API key is
// therefore OPTIONAL here — the `Authorization` header is sent only when a key
// is present and omitted entirely when absent.

import type { SttAudio } from '@ethosagent/types';

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Audio MIME → file extension. Covers the formats the browser records and
 * OpenAI-compatible servers accept. Strict servers (Speaches / faster-whisper)
 * reject an upload with 415 unless the multipart part carries a plausible
 * filename and content-type, so the declared MIME is honoured here.
 */
export const AUDIO_EXT_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
};

/**
 * Normalize a declared MIME: drop codec/charset parameters and lowercase, so
 * `audio/webm;codecs=opus` (what MediaRecorder reports) matches the table.
 */
export function baseMimeType(mimeType: string | undefined): string | undefined {
  const base = mimeType?.split(';')[0]?.trim().toLowerCase();
  return base ? base : undefined;
}

/**
 * Derive the multipart `file` part (filename + content-type) from the declared
 * MIME. Unknown/missing MIME → best-effort octet-stream under a bare `audio`
 * filename, which is what the previous path-based derivation did for an
 * unrecognized extension.
 */
export function audioFilePart(mimeType: string | undefined): {
  filename: string;
  contentType: string;
} {
  const base = baseMimeType(mimeType);
  const ext = base ? AUDIO_EXT_BY_MIME[base] : undefined;
  if (!base || !ext) return { filename: 'audio', contentType: 'application/octet-stream' };
  return { filename: `audio.${ext}`, contentType: base };
}

/** STT — POST {baseUrl}/audio/transcriptions, multipart `file` + `model`, returns `{ text }`. */
export async function transcribeOpenAiCompat(opts: {
  baseUrl: string;
  model: string;
  /** The captured utterance, in memory. No temp file is written. */
  audio: SttAudio;
  /** Optional bearer key. When absent, no `Authorization` header is sent. */
  apiKey?: string;
  /** Prefix for the thrown error message, e.g. `'OpenAI STT'` / `'Local STT'`. */
  label: string;
  /** BCP-47 hint, forwarded as the multipart `language` part when present. */
  language?: string;
  /** Aborts the upload when the caller/UI times out. Absent → no timeout here. */
  signal?: AbortSignal;
}): Promise<string> {
  const { filename, contentType } = audioFilePart(opts.audio.mimeType);
  // Re-wrap into a fresh Uint8Array: `Blob` requires an `ArrayBuffer`-backed
  // view, and an `SttAudio` may carry any `ArrayBufferLike` (e.g. a Node
  // Buffer slice). Blob copies its input regardless, so this costs nothing
  // beyond what the constructor already does.
  const blob = new Blob([new Uint8Array(opts.audio.data)], { type: contentType });
  const formData = new FormData();
  formData.append('file', blob, filename);
  formData.append('model', opts.model);
  if (opts.language) formData.append('language', opts.language);

  const res = await fetch(`${opts.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: authHeaders(opts.apiKey),
    body: formData,
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${opts.label} failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { text: string };
  return json.text;
}

export interface SpeechRequestOptions {
  baseUrl: string;
  model: string;
  voice: string;
  input: string;
  /** Optional bearer key. When absent, no `Authorization` header is sent. */
  apiKey?: string;
  speed?: number;
  /** Prefix for the thrown error message, e.g. `'OpenAI TTS'` / `'Local TTS'`. */
  label: string;
  /** Aborts the request when the caller/UI times out. Absent → no timeout here. */
  signal?: AbortSignal;
}

/** POST {baseUrl}/audio/speech. Throws on a non-2xx, with the server's body. */
async function speechResponse(opts: SpeechRequestOptions): Promise<Response> {
  const res = await fetch(`${opts.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      ...authHeaders(opts.apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      input: opts.input,
      voice: opts.voice,
      speed: opts.speed ?? 1.0,
      response_format: 'opus',
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${opts.label} failed (${res.status}): ${body}`);
  }
  return res;
}

/** TTS — POST {baseUrl}/audio/speech, json body, returns opus audio bytes. */
export async function synthesizeOpenAiCompat(
  opts: SpeechRequestOptions,
): Promise<{ audio: Uint8Array; format: 'opus' }> {
  const res = await speechResponse(opts);
  const buffer = await res.arrayBuffer();
  return { audio: new Uint8Array(buffer), format: 'opus' };
}

/**
 * Streaming TTS — the SAME request as {@link synthesizeOpenAiCompat}, consumed
 * as the chunked response body arrives instead of buffered whole. Both OpenAI
 * and Kokoro stream `/audio/speech` as chunked transfer, so the first bytes of
 * a sentence are playable long before the request completes.
 *
 * A server (or a test double) that hands back a fully-buffered response with no
 * readable body degrades to a single chunk — same bytes, same order.
 */
export async function* streamOpenAiCompat(
  opts: SpeechRequestOptions,
): AsyncIterable<{ audio: Uint8Array; format: 'opus' }> {
  const res = await speechResponse(opts);
  const body = res.body;
  if (!body) {
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 0) yield { audio: new Uint8Array(buffer), format: 'opus' };
    return;
  }

  const reader = body.getReader();
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      const value = chunk.value;
      if (value && value.byteLength > 0) yield { audio: value, format: 'opus' };
      chunk = await reader.read();
    }
  } finally {
    // Barge-in breaks out of this generator mid-stream; releasing the reader
    // hands the socket back instead of leaking it until GC.
    await reader.cancel().catch(() => {});
  }
}
