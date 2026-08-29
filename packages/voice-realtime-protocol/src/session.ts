// A `RealtimeSession` built from a codec and a transport — the whole of what a
// provider implementation has left to do once its wire vocabulary is a
// `RealtimeProtocolCodec`.
//
// Both shipped providers and the browser-direct client construct sessions from
// here, so the buffering, the exactly-once terminal `closed`, and the
// after-close silence are the SAME behaviour everywhere rather than three
// implementations of it that only the OpenAI one gets exercised.

import type { RealtimeEvent, RealtimeSession } from '@ethosagent/types';
import type { RealtimeProtocolCodec } from './codec';
import { RealtimeSessionCore } from './session-core';
import type { RealtimeSocketFactory, RealtimeSocketInit } from './socket';

export interface RealtimeProtocolSessionOptions {
  socketFactory: RealtimeSocketFactory;
  init: RealtimeSocketInit;
  codec: RealtimeProtocolCodec;
  /**
   * Frame written the moment the transport opens. Omit to write nothing —
   * the browser-direct OpenAI path, whose session configuration was baked into
   * the ephemeral token when the server minted it.
   */
  handshake?: unknown;
  signal?: AbortSignal;
}

/** A {@link RealtimeSession} that has not been dialled yet. */
export interface UnconnectedRealtimeSession extends RealtimeSession {
  /** Open the transport and send the handshake. Rejects if the socket never opens. */
  connect(): Promise<void>;
}

export function createRealtimeProtocolSession(
  opts: RealtimeProtocolSessionOptions,
): UnconnectedRealtimeSession {
  const codec = opts.codec;
  const core: RealtimeSessionCore = new RealtimeSessionCore({
    socketFactory: opts.socketFactory,
    init: opts.init,
    handshake: () => {
      if (opts.handshake !== undefined) core.sendJson(opts.handshake);
    },
    decode: (raw) => {
      const decoded = codec.decode(raw);
      // Ready FIRST: a provider that confirms and speaks in the same frame must
      // flush the caller's buffered audio before the events it carried land.
      if (decoded.ready) core.markReady();
      for (const event of decoded.events) core.emit(event);
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const encodeSay = codec.encodeSay?.bind(codec);

  return {
    connect: () => core.connect(),

    get events(): AsyncIterable<RealtimeEvent> {
      return core.events;
    },

    async sendAudio(pcm: Uint8Array): Promise<void> {
      core.sendWhenReady(codec.encodeAudio(pcm));
    },

    async sendToolResult(callId: string, output: string): Promise<void> {
      for (const frame of codec.encodeToolResult(callId, output)) core.sendJson(frame);
    },

    async interrupt(): Promise<void> {
      for (const frame of codec.encodeInterrupt()) core.sendJson(frame);
    },

    // Present only when the codec can express it — `say` is optional on the
    // contract precisely so a caller can feature-detect rather than call into
    // a method that silently does nothing.
    ...(encodeSay
      ? {
          async say(text: string): Promise<void> {
            for (const frame of encodeSay(text)) core.sendJson(frame);
          },
        }
      : {}),

    close(): Promise<void> {
      return core.close();
    },
  };
}
