// Voice-native `clarify`: when a call is up, the agent's mid-turn question is
// SPOKEN and the user's spoken reply answers it.
//
// The card is unchanged and stays on screen the whole time. It is the visual
// record of what was asked, the fallback when the tier cannot speak or
// synthesis fails, and the way to answer for anyone who would rather click than
// talk. Whichever lands first wins: the bridge swallows a second response for a
// request that is already resolved, and the `clarify.resolved` SSE event is
// what collapses the card either way — there is no second teardown path.
//
// Pure and transport-free on purpose: `ask` is the voice seam
// (`VoiceCallClient.ask`, null when the call cannot speak) and `respond` is the
// clarify RPC, so every decision below is testable without a call, a DOM, or a
// server.

/** The parts of a pending clarify this needs. Structurally a `ClarifyRequestEvent`. */
export interface VoiceClarifyQuestion {
  requestId: string;
  question: string;
  options?: string[] | undefined;
}

/**
 * What happened to the question.
 *
 * `card-only` covers every route to "nothing was answered out loud" — no call,
 * a tier that cannot speak, synthesis that failed, an abort because the card
 * was answered first, or an answer the server would not take. They collapse
 * into one outcome because they have one consequence: the card, which never
 * left, is how this gets answered.
 */
export type VoiceClarifyOutcome = 'answered' | 'card-only';

/**
 * The sentence to speak. Options are read out — a spoken multiple-choice
 * question with the choices left on screen is a question the listener cannot
 * answer without looking.
 */
export function spokenClarify(request: VoiceClarifyQuestion): string {
  const question = request.question.trim();
  const options = request.options?.filter((option) => option.trim().length > 0) ?? [];
  if (options.length === 0) return question;
  return `${question} You can say: ${options.join(', ')}.`;
}

export interface RunVoiceClarifyOptions {
  request: VoiceClarifyQuestion;
  /** Speak the question, resolve the spoken answer. Null → nothing was asked. */
  ask: (question: string, signal: AbortSignal) => Promise<string | null>;
  /** `clarify.respond` for this request, with `source: 'user'`. */
  respond: (answer: string) => Promise<void>;
  /** Aborted when the clarify resolves — on the card, by timeout, or by cancel. */
  signal: AbortSignal;
}

/**
 * Ask a pending clarify out loud and route the spoken answer back to the tool
 * that is blocking the turn — NOT into a new chat turn.
 *
 * Never throws: every failure is an outcome, because the caller is an effect
 * and the fallback is already rendered.
 */
export async function runVoiceClarify(opts: RunVoiceClarifyOptions): Promise<VoiceClarifyOutcome> {
  if (opts.signal.aborted) return 'card-only';

  let spoken: string | null;
  try {
    spoken = await opts.ask(spokenClarify(opts.request), opts.signal);
  } catch {
    // The tier could not speak it. Entering "the next thing you say answers
    // this" here would eat a sentence the user never heard a question for.
    return 'card-only';
  }

  const answer = spoken?.trim();
  // Aborted mid-ask means the clarify resolved without us — a click, a typed
  // answer, the timeout. Responding now would be answering a resolved request.
  if (!answer || opts.signal.aborted) return 'card-only';

  try {
    await opts.respond(answer);
  } catch {
    return 'card-only';
  }
  return 'answered';
}
