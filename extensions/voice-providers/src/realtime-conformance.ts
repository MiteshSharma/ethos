// The shared realtime contract suite — the sibling of `./conformance`.
//
// `./conformance` validates a provider's STATIC shape (caps and method
// presence). A realtime provider's contract is almost entirely BEHAVIOURAL: an
// event stream that must terminate, events that must carry the right role and
// finality, a socket that must not turn a provider error into a thrown
// exception. So this module keeps the same idiom — plain functions returning
// arrays of error strings, no test-framework import — and adds a scripted
// drive-through against an in-memory fake socket.
//
// The point of the suite is the acceptance criterion "the contract is provably
// not OpenAI-shaped": every check below runs identically for `openai-realtime`
// and `gemini-live`, and the ONLY per-provider input is the wire vocabulary in
// `RealtimeConformanceTarget`. If a check could not be written for both, the
// contract would be leaking one provider's model — and that is exactly what a
// third-party provider would hit later.

import type {
  RealtimeEvent,
  RealtimeSession,
  RealtimeVoiceCapabilities,
  RealtimeVoiceProvider,
} from '@ethosagent/types';
import { REALTIME_CONTRACT_VERSION } from '@ethosagent/types';
import type {
  RealtimeSocket,
  RealtimeSocketFactory,
  RealtimeSocketHandlers,
  RealtimeSocketInit,
} from './realtime/socket';

// ---------------------------------------------------------------------------
// Static validation — the direct mirror of `validateSttProvider`
// ---------------------------------------------------------------------------

export function validateRealtimeCaps(caps: RealtimeVoiceCapabilities): string[] {
  const errors: string[] = [];
  if (caps.kind !== 'realtime') errors.push(`Invalid kind: ${caps.kind}`);
  if (!Number.isFinite(caps.sampleRate) || caps.sampleRate <= 0) {
    errors.push('sampleRate must be a positive number of Hz');
  }
  if (caps.contractVersion !== REALTIME_CONTRACT_VERSION) {
    errors.push(
      `contractVersion must be ${REALTIME_CONTRACT_VERSION}, got ${caps.contractVersion}`,
    );
  }
  if (caps.voices !== undefined && caps.voices.length === 0) {
    errors.push('voices, when declared, must be non-empty');
  }
  if (caps.languages !== undefined && caps.languages.length === 0) {
    errors.push('languages, when declared, must be non-empty');
  }
  return errors;
}

export function validateRealtimeProvider(provider: RealtimeVoiceProvider): string[] {
  const errors = validateRealtimeCaps(provider.caps);
  if (!provider.name) errors.push('name must be a non-empty string');
  if (typeof provider.open !== 'function') errors.push('open(opts) must be implemented');
  const mints = typeof provider.mintEphemeralToken === 'function';
  if (provider.caps.ephemeralToken === true && !mints) {
    errors.push('caps.ephemeralToken is true but mintEphemeralToken(opts) is missing');
  }
  if (provider.caps.ephemeralToken !== true && mints) {
    errors.push('mintEphemeralToken(opts) is implemented but caps.ephemeralToken is not true');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The fake socket both providers are driven against
// ---------------------------------------------------------------------------

export interface FakeRealtimeServer {
  /** Hand this to the provider in place of the real `ws` transport. */
  readonly factory: RealtimeSocketFactory;
  /** Every frame the provider wrote, JSON-parsed, in order. */
  readonly sent: unknown[];
  /** What the provider asked the transport for (url, headers, subprotocols). */
  readonly init: RealtimeSocketInit | undefined;
  /** True once the provider closed the socket. */
  readonly clientClosed: boolean;
  /** Push a provider → client frame. */
  deliver(frame: unknown): void;
  /** Abrupt transport close, e.g. the network went away. */
  drop(reason: string): void;
  /** Transport-level error, e.g. a TLS failure mid-session. */
  fail(message: string): void;
}

/**
 * An in-memory stand-in for the provider's WebSocket. No network, no
 * credentials, no timers beyond the microtask that reports the socket open.
 */
export function createFakeRealtimeServer(): FakeRealtimeServer {
  const sent: unknown[] = [];
  let handlers: RealtimeSocketHandlers | undefined;
  let init: RealtimeSocketInit | undefined;
  let clientClosed = false;

  const factory: RealtimeSocketFactory = (socketInit, socketHandlers): RealtimeSocket => {
    init = socketInit;
    handlers = socketHandlers;
    queueMicrotask(() => socketHandlers.onOpen());
    return {
      send: (data: string) => {
        sent.push(JSON.parse(data));
      },
      // Deliberately does NOT echo `onClose`: a real socket reports its close
      // asynchronously, and a session whose terminal event depended on that
      // echo would hang when the socket is already gone.
      close: () => {
        clientClosed = true;
      },
    };
  };

  return {
    factory,
    sent,
    get init() {
      return init;
    },
    get clientClosed() {
      return clientClosed;
    },
    deliver: (frame) => handlers?.onMessage(JSON.stringify(frame)),
    drop: (reason) => handlers?.onClose(reason),
    fail: (message) => handlers?.onError(message),
  };
}

// ---------------------------------------------------------------------------
// Target description — the only per-provider input
// ---------------------------------------------------------------------------

export interface TranscriptScript {
  /** A frame carrying an incremental transcript. */
  partial: unknown;
  /** The text that frame must surface. */
  partialText: string;
  /** A frame that settles the transcript, delivered after `partial`. */
  final: unknown;
  /** The text the settled event must carry. */
  finalText: string;
}

export interface RealtimeConformanceTarget {
  /** Provider label, used in reported errors. */
  label: string;
  /** Build the provider bound to the fake transport. No network, no real key. */
  createProvider(
    socketFactory: RealtimeSocketFactory,
  ): RealtimeVoiceProvider | Promise<RealtimeVoiceProvider>;
  /** Frames that make the provider treat its session as established. */
  confirmSession: unknown[];
  /** A frame carrying `pcmBase64` as output speech. */
  audioDelta(pcmBase64: string): unknown;
  userTranscript: TranscriptScript;
  assistantTranscript: TranscriptScript;
  /** A frame asking for `name(args)` under `callId`. */
  toolCall(callId: string, name: string, args: Record<string, unknown>): unknown;
  /** The frame that means "the user started speaking over the model". */
  speechStarted: unknown;
  /** A recoverable provider-level error frame and the event it must become. */
  providerError: { frame: unknown; error: string; code: string };
  /** Assert the wire shape written for one `sendAudio(pcm)`. */
  expectAudioWrite(sent: unknown[], pcm: Uint8Array): string[];
  /** Assert the wire shape written for one `sendToolResult(callId, output)`. */
  expectToolResultWrite(sent: unknown[], callId: string, output: string): string[];
  /**
   * Assert what `interrupt()` wrote. Providers differ here on purpose: OpenAI
   * needs an explicit cancel, Gemini has already cancelled server-side and
   * writes nothing. The CONTRACT obligation is only "interrupt() resolves";
   * the wire is the target's to describe.
   */
  expectInterruptWrite(sent: unknown[]): string[];
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export const REALTIME_CONTRACT_CHECKS = [
  'caps and provider shape',
  'session opens and the event stream terminates on close',
  'output audio delta becomes one audio event at the declared sample rate',
  'user transcript deltas carry role=user with correct finality',
  'assistant transcript deltas carry role=assistant with correct finality',
  'tool call parses args and sendToolResult writes the provider shape',
  'speech_started fires and interrupt() writes the provider cancel shape',
  'a provider error becomes an error event without killing the stream',
  'an abrupt socket close becomes a closed event with a reason',
  'audio sent before the session is confirmed is buffered, not dropped',
] as const;

export type RealtimeContractCheckName = (typeof REALTIME_CONTRACT_CHECKS)[number];

export interface RealtimeConformanceCheck {
  name: RealtimeContractCheckName;
  errors: string[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/** One macrotask boundary drains every microtask the socket callbacks queued. */
function settle(): Promise<void> {
  return delay(0);
}

interface Collector {
  events: RealtimeEvent[];
  done: Promise<void>;
}

function collect(session: RealtimeSession): Collector {
  const events: RealtimeEvent[] = [];
  const done = (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return { events, done };
}

function must(errors: string[], condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function transcripts(
  events: RealtimeEvent[],
  role: 'user' | 'assistant',
  isFinal: boolean,
): string[] {
  return events
    .filter((e) => e.type === 'transcript' && e.role === role && e.isFinal === isFinal)
    .map((e) => (e.type === 'transcript' ? e.text : ''));
}

interface Harness {
  server: FakeRealtimeServer;
  provider: RealtimeVoiceProvider;
  session: RealtimeSession;
  collector: Collector;
}

async function openHarness(target: RealtimeConformanceTarget): Promise<Harness> {
  const server = createFakeRealtimeServer();
  const provider = await target.createProvider(server.factory);
  const session = await provider.open({ instructions: 'You are under test.' });
  const collector = collect(session);
  await settle();
  return { server, provider, session, collector };
}

async function confirm(target: RealtimeConformanceTarget, harness: Harness): Promise<void> {
  for (const frame of target.confirmSession) harness.server.deliver(frame);
  await settle();
}

async function runCheck(
  name: RealtimeContractCheckName,
  body: () => Promise<string[]>,
): Promise<RealtimeConformanceCheck> {
  try {
    return { name, errors: await body() };
  } catch (err) {
    return { name, errors: [`threw: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/**
 * Drive `target` through every contract check. Returns one entry per check in
 * {@link REALTIME_CONTRACT_CHECKS} with the errors that check found; an empty
 * `errors` array is a pass. Never throws.
 */
export async function runRealtimeContractSuite(
  target: RealtimeConformanceTarget,
): Promise<RealtimeConformanceCheck[]> {
  return [
    await runCheck('caps and provider shape', async () => {
      const provider = await target.createProvider(createFakeRealtimeServer().factory);
      return validateRealtimeProvider(provider);
    }),

    await runCheck('session opens and the event stream terminates on close', async () => {
      const errors: string[] = [];
      const harness = await openHarness(target);
      await confirm(target, harness);
      must(
        errors,
        harness.collector.events.some((e) => e.type === 'session_open'),
        'no session_open event after the provider confirmed the session',
      );

      await harness.session.close();
      await settle();

      const last = harness.collector.events.at(-1);
      must(
        errors,
        last?.type === 'closed',
        `expected the last event to be closed, got ${last?.type ?? 'nothing'}`,
      );
      must(
        errors,
        (await Promise.race([
          harness.collector.done.then(() => 'done'),
          delay(250).then(() => 'hung'),
        ])) === 'done',
        'the events iterable did not complete within 250ms of close()',
      );

      const countAtClose = harness.collector.events.length;
      harness.server.deliver(target.audioDelta(Buffer.from([1, 2, 3, 4]).toString('base64')));
      for (const frame of target.confirmSession) harness.server.deliver(frame);
      await settle();
      must(
        errors,
        harness.collector.events.length === countAtClose,
        'events were still delivered after close()',
      );
      must(errors, harness.server.clientClosed, 'close() did not close the transport');
      return errors;
    }),

    await runCheck(
      'output audio delta becomes one audio event at the declared sample rate',
      async () => {
        const errors: string[] = [];
        const harness = await openHarness(target);
        await confirm(target, harness);
        const before = harness.collector.events.length;

        const pcm = new Uint8Array([0x01, 0x02, 0xfe, 0xff, 0x10, 0x20]);
        harness.server.deliver(target.audioDelta(Buffer.from(pcm).toString('base64')));
        await settle();

        const audio = harness.collector.events.slice(before).filter((e) => e.type === 'audio');
        if (audio.length !== 1) {
          errors.push(`expected exactly 1 audio event, got ${audio.length}`);
        } else {
          const event = audio[0];
          if (event.type === 'audio') {
            must(
              errors,
              event.sampleRate === harness.provider.caps.sampleRate,
              `audio event sampleRate ${event.sampleRate} != caps.sampleRate ${harness.provider.caps.sampleRate}`,
            );
            must(
              errors,
              Buffer.from(event.pcm).equals(Buffer.from(pcm)),
              'audio event pcm bytes do not match the delivered frame',
            );
          }
        }
        await harness.session.close();
        return errors;
      },
    ),

    await runCheck('user transcript deltas carry role=user with correct finality', async () => {
      return transcriptCheck(target, 'user');
    }),

    await runCheck(
      'assistant transcript deltas carry role=assistant with correct finality',
      async () => {
        return transcriptCheck(target, 'assistant');
      },
    ),

    await runCheck(
      'tool call parses args and sendToolResult writes the provider shape',
      async () => {
        const errors: string[] = [];
        const harness = await openHarness(target);
        await confirm(target, harness);
        const before = harness.collector.events.length;

        harness.server.deliver(target.toolCall('call-1', 'lookup', { query: 'weather', n: 2 }));
        await settle();

        const calls = harness.collector.events.slice(before).filter((e) => e.type === 'tool_call');
        if (calls.length !== 1) {
          errors.push(`expected exactly 1 tool_call event, got ${calls.length}`);
        } else {
          const call = calls[0];
          if (call.type === 'tool_call') {
            must(errors, call.callId === 'call-1', `tool_call callId was "${call.callId}"`);
            must(errors, call.name === 'lookup', `tool_call name was "${call.name}"`);
            must(
              errors,
              JSON.stringify(call.args) === JSON.stringify({ query: 'weather', n: 2 }),
              `tool_call args were ${JSON.stringify(call.args)}`,
            );
          }
        }

        const baseline = harness.server.sent.length;
        await harness.session.sendToolResult('call-1', '{"temp":21}');
        await settle();
        errors.push(
          ...target.expectToolResultWrite(
            harness.server.sent.slice(baseline),
            'call-1',
            '{"temp":21}',
          ),
        );
        await harness.session.close();
        return errors;
      },
    ),

    await runCheck(
      'speech_started fires and interrupt() writes the provider cancel shape',
      async () => {
        const errors: string[] = [];
        const harness = await openHarness(target);
        await confirm(target, harness);
        const before = harness.collector.events.length;

        harness.server.deliver(target.speechStarted);
        await settle();
        must(
          errors,
          harness.collector.events.slice(before).some((e) => e.type === 'speech_started'),
          'the provider speech signal did not produce a speech_started event',
        );

        const baseline = harness.server.sent.length;
        await harness.session.interrupt();
        await settle();
        errors.push(...target.expectInterruptWrite(harness.server.sent.slice(baseline)));
        await harness.session.close();
        return errors;
      },
    ),

    await runCheck(
      'a provider error becomes an error event without killing the stream',
      async () => {
        const errors: string[] = [];
        const harness = await openHarness(target);
        await confirm(target, harness);
        const before = harness.collector.events.length;

        harness.server.deliver(target.providerError.frame);
        await settle();

        const errorEvents = harness.collector.events
          .slice(before)
          .filter((e) => e.type === 'error')
          .map((e) => (e.type === 'error' ? e : undefined));
        const first = errorEvents[0];
        if (!first) {
          errors.push('the provider error frame produced no error event');
        } else {
          must(
            errors,
            first.error === target.providerError.error,
            `error event message was "${first.error}"`,
          );
          must(
            errors,
            first.code === target.providerError.code,
            `error event code was "${first.code}"`,
          );
        }
        must(
          errors,
          harness.collector.events.every((e) => e.type !== 'closed'),
          'a recoverable provider error closed the session',
        );

        const afterError = harness.collector.events.length;
        harness.server.deliver(target.audioDelta(Buffer.from([9, 9]).toString('base64')));
        await settle();
        must(
          errors,
          harness.collector.events.slice(afterError).some((e) => e.type === 'audio'),
          'the event stream stopped delivering after a recoverable error',
        );
        await harness.session.close();
        return errors;
      },
    ),

    await runCheck('an abrupt socket close becomes a closed event with a reason', async () => {
      const errors: string[] = [];
      const harness = await openHarness(target);
      await confirm(target, harness);

      harness.server.drop('upstream reset the connection');
      await settle();

      const last = harness.collector.events.at(-1);
      if (last?.type !== 'closed') {
        errors.push(`expected a closed event after an abrupt drop, got ${last?.type ?? 'nothing'}`);
      } else {
        must(errors, last.reason.length > 0, 'the closed event carried an empty reason');
      }
      must(
        errors,
        (await Promise.race([
          harness.collector.done.then(() => 'done'),
          delay(250).then(() => 'hung'),
        ])) === 'done',
        'the events iterable did not complete after an abrupt drop',
      );
      return errors;
    }),

    await runCheck(
      'audio sent before the session is confirmed is buffered, not dropped',
      async () => {
        const errors: string[] = [];
        const harness = await openHarness(target);
        const baseline = harness.server.sent.length;

        // Defined behaviour: frames captured before the provider confirms the
        // session are HELD and flushed in order on confirmation. Neither provider
        // accepts media before its handshake completes, and dropping the frames
        // would clip the first word of the first utterance.
        const pcm = new Uint8Array([
          0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04, 0x00, 0x05, 0x00, 0x06,
        ]);
        await harness.session.sendAudio(pcm);
        await settle();
        must(
          errors,
          harness.server.sent.length === baseline,
          'audio was written to the wire before the provider confirmed the session',
        );
        must(
          errors,
          harness.collector.events.every((e) => e.type !== 'error'),
          'buffering pre-confirmation audio raised an error event',
        );

        await confirm(target, harness);
        errors.push(...target.expectAudioWrite(harness.server.sent.slice(baseline), pcm));
        await harness.session.close();
        return errors;
      },
    ),
  ];
}

async function transcriptCheck(
  target: RealtimeConformanceTarget,
  role: 'user' | 'assistant',
): Promise<string[]> {
  const errors: string[] = [];
  const script = role === 'user' ? target.userTranscript : target.assistantTranscript;
  const harness = await openHarness(target);
  await confirm(target, harness);
  const before = harness.collector.events.length;

  harness.server.deliver(script.partial);
  await settle();
  harness.server.deliver(script.final);
  await settle();

  const emitted = harness.collector.events.slice(before);
  const other = role === 'user' ? 'assistant' : 'user';
  must(
    errors,
    transcripts(emitted, role, false).includes(script.partialText),
    `no partial transcript for role=${role} carrying "${script.partialText}"`,
  );
  must(
    errors,
    transcripts(emitted, role, true).includes(script.finalText),
    `no final transcript for role=${role} carrying "${script.finalText}"`,
  );
  must(
    errors,
    !transcripts(emitted, other, false).includes(script.partialText) &&
      !transcripts(emitted, other, true).includes(script.partialText),
    `the ${role} transcript was also attributed to role=${other}`,
  );
  await harness.session.close();
  return errors;
}
