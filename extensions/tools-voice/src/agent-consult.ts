// `agent_consult` — the one door between a hosted realtime voice session and
// the Ethos agent (voice V1b §"Personality mapping and the consult boundary").
//
// THE SHAPE OF THE THING. A realtime provider (OpenAI Realtime, Gemini Live) is
// a SURFACE: it owns the microphone, the VAD, the barge-in and the voice. It is
// NOT the agent. The agent stays exactly what it is everywhere else — a
// text-only `AgentLoop` with this deployment's personality, memory, toolset,
// approval surface and budget — and the realtime model reaches it through one
// tool. That split is the whole design: without it, "the agent" on a phone call
// is a different agent with different memory and different permissions than the
// one in the chat window, which is how two systems that share a name drift into
// disagreeing about what they are allowed to do.
//
// It lives here rather than in `tools-delegation` because it is not delegation:
// there is no child personality, no depth budget, no spawn semantics. It is the
// voice surface's ONE call back into the agent it is a surface for, and its
// neighbours are the other voice tools (`voice_session`, `call`). Like the
// delegation tools it is loop-bearing, so it is registered AFTER loop
// construction (`packages/wiring/src/build-agent-loop.ts`) — the tool registry
// is populated before the loop exists, and this tool needs the loop.

import type { AgentLoop } from '@ethosagent/core';
import type {
  RealtimeToolDefinition,
  Tool,
  ToolContext,
  ToolRegistry,
  ToolResult,
  VoiceTurnOrigin,
} from '@ethosagent/types';

/** Tool name. Exported so the realtime seam never spells it by hand. */
export const AGENT_CONSULT_TOOL = 'agent_consult';

/**
 * Cap on the consulted answer. Far below `delegate_task`'s 20k: this text is
 * about to be SPOKEN, and a realtime model handed four pages will either read
 * them for six minutes or silently invent a précis. A tight cap makes the
 * truncation visible to the model instead.
 */
export const AGENT_CONSULT_MAX_RESULT_CHARS = 4_000;

/**
 * The boundary policy, appended to every realtime session's instructions.
 *
 * This is the load-bearing prose of the whole tier, so it is written as
 * instructions a model will actually follow — concrete verbs, a worked
 * boundary, and an explicit "when in doubt" tiebreak — and exported as a
 * constant so it can be asserted on rather than read.
 *
 * It does NOT go in the agent's system prompt. The agent is not the one being
 * constrained; the realtime model is, and it is configured over a different
 * wire (`RealtimeSessionOptions.instructions`). Putting it in an injector would
 * also break the static-prefix rule that prefix caching depends on
 * (`packages/core/src/__tests__/prompt-prefix-stability.test.ts`).
 */
export const REALTIME_BOUNDARY_POLICY = `## How you work

You are the VOICE of this assistant, not its mind. The assistant itself is a separate
agent that has the memory, the files, the tools and the permissions. You reach it with
the ${AGENT_CONSULT_TOOL} tool.

Answer directly, without calling ${AGENT_CONSULT_TOOL}, ONLY for conversational glue:
- greetings, small talk, and sign-offs
- asking the person to repeat or clarify something you did not hear
- repeating or rephrasing something already said in THIS conversation

Call ${AGENT_CONSULT_TOOL} for everything else. In particular, always call it for:
- any question of fact, including ones you think you know
- anything about this person, their files, their projects, their calendar, their past
  conversations, or anything they told you before this call
- anything that changes something, sends something, runs something, or looks something up
- any question you would answer with "I think" or "probably"

Example. "Hey, are you there?" — answer directly. "What did we decide about the
migration?" — call ${AGENT_CONSULT_TOOL}, even though it sounds like something you
should remember, because you do not have that memory and the assistant does.

When you are unsure which side of the line a request falls on, call ${AGENT_CONSULT_TOOL}.
Guessing out loud is the one failure that is expensive here: the person cannot see that
you guessed.

Before you call ${AGENT_CONSULT_TOOL}, say one short sentence out loud telling the person
you are checking. Then call it. Do not narrate the tool itself, and never say the words
"${AGENT_CONSULT_TOOL}", "tool" or "function" out loud.

When the result comes back, speak it as speech: short sentences, no markdown, no lists
read out as bullet characters, no file paths, no URLs read character by character. If the
result is long, say the answer first and offer the detail second.`;

/**
 * Build the session instructions for one realtime call.
 *
 * `soul` is the personality's SOUL.md — its identity, verbatim, first, because
 * that is what the personality IS everywhere else in this system. The boundary
 * policy is appended rather than prepended so a personality that opens with
 * "You are …" still opens with it.
 */
export function buildRealtimeInstructions(soul: string | null | undefined): string {
  const identity = (soul ?? '').trim();
  return identity ? `${identity}\n\n${REALTIME_BOUNDARY_POLICY}` : REALTIME_BOUNDARY_POLICY;
}

/**
 * Tools a realtime session may call DIRECTLY, without going through the agent.
 *
 * Empty, and that is a decision rather than a stub. Every candidate we looked
 * at falls on the far side of the boundary policy above: a lookup is factual, a
 * memory read is personal, anything that writes is actional — all three MUST go
 * through `agent_consult`, where the personality's toolset, the approval hooks
 * and the spoken-confirmation gate apply. A tool advertised here would be a
 * tool executed with none of that, which is precisely the hole the tier exists
 * to avoid.
 *
 * The mechanism is real and derived (see {@link deriveRealtimeToolset}) so a
 * later phase — V4's call path is the expected one — can add a name here and
 * get advertising, gating and dispatch without touching the seam. What it may
 * NOT do is add a name without a handler: the advertised == handled test is
 * what enforces that.
 */
export const REALTIME_SAFE_TOOLS: ReadonlySet<string> = new Set<string>();

export interface DeriveRealtimeToolsetOptions {
  /** The registry the agent itself runs on — "what is actually wired". */
  registry: ToolRegistry;
  /** The speaking personality's toolset. A safe tool it does not have is not offered. */
  personalityToolset?: readonly string[];
  /** Override the direct-call allowlist. Defaults to {@link REALTIME_SAFE_TOOLS}. */
  safeTools?: ReadonlySet<string>;
}

/**
 * The tools this realtime session advertises, generated from what is wired.
 *
 * Generated, never hand-listed: a session that offers a tool it cannot service
 * is a model announcing a capability out loud, mid-conversation, to someone who
 * then waits for it. `toDefinitions` only returns tools the registry actually
 * holds, so an `agent_consult` that failed to register produces a session that
 * does not claim to have one.
 *
 * `agent_consult` is offered unconditionally — it is the surface's reason to
 * exist and is not subject to the personality's own toolset, because what it
 * opens is an agent turn that applies that toolset itself.
 */
export function deriveRealtimeToolset(
  opts: DeriveRealtimeToolsetOptions,
): RealtimeToolDefinition[] {
  const safe = opts.safeTools ?? REALTIME_SAFE_TOOLS;
  const personality = opts.personalityToolset;
  const allowed = new Set([
    AGENT_CONSULT_TOOL,
    ...[...safe].filter((name) => !personality || personality.includes(name)),
  ]);
  // Structurally identical types (`RealtimeToolDefinition` is an alias of
  // `ToolDefinitionLite`) — no adapter, and therefore no drift between the
  // tools the model sees over text and the ones it sees over voice.
  //
  // Intersected with `allowed` AFTERWARDS, not just passed in. `toDefinitions`
  // treats its allowlist as a gate on BUILT-IN tools only: an `alwaysInclude`
  // tool, every MCP tool and every plugin tool come back regardless, because on
  // the text path those are gated by `mcp_servers` / `plugins` instead. That is
  // right for a text turn and wrong here — it would hand a realtime session the
  // whole MCP surface to call directly, with none of the personality gating a
  // consulted turn applies. The realtime allowlist is exact.
  return opts.registry.toDefinitions([...allowed]).filter((tool) => allowed.has(tool.name));
}

export interface AgentConsultOptions {
  /**
   * How the audio reached this agent, stamped on every consulted turn.
   *
   * Required, with no default, because the spoken-confirmation gate's second
   * rule keys on it: a far-end caller's voice can never satisfy an owner
   * confirmation. A default would make the safe value the one you get by
   * forgetting, and `owner` is not a safe default to forget your way into.
   */
  voiceOrigin: VoiceTurnOrigin;
  /**
   * Pin the consulted turn to a specific personality, ignoring
   * `ToolContext.personalityId`.
   *
   * This is how the RESTRICTED RECEPTIONIST SCOPE is expressed (voice V4,
   * eng-review D12), and it deliberately reuses the mechanisms this repo
   * already has rather than inventing a parallel restriction system: a turn's
   * memory scope is `personality:<id>` and its tool allowlist is that
   * personality's `toolset` (both resolved in
   * `packages/core/.../stages/turn-setup.ts`), so running a non-allowlisted
   * caller's consult AS the receptionist personality is what makes owner memory
   * and privileged tools unreachable — not a flag anyone has to remember to
   * check.
   *
   * Absent → the caller's own personality, which is what the owner's browser
   * talk-mode consult wants.
   */
  personalityId?: string;
}

/**
 * `agent_consult(prompt) -> text`. One agent turn, its text back.
 *
 * Modelled on `runSubAgent` in `@ethosagent/tools-delegation`: drive
 * `loop.run`, accumulate `text_delta`, throw on `error`, stop at `done`.
 */
export function createAgentConsultTool(loop: AgentLoop, opts: AgentConsultOptions): Tool {
  return {
    name: AGENT_CONSULT_TOOL,
    description:
      'Ask the assistant. Runs one full agent turn — it has the memory, the files, the ' +
      'tools and the permissions that you do not — and returns its answer as text for you ' +
      'to speak. Use it for anything factual, anything about this person, and anything ' +
      'that changes or looks up something.',
    toolset: 'voice',
    maxResultChars: AGENT_CONSULT_MAX_RESULT_CHARS,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'What to ask the assistant, as a complete question in the person’s own words. ' +
            'Include anything from the conversation it would need and cannot see.',
        },
      },
      required: ['prompt'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const prompt =
        typeof (args as { prompt?: unknown }).prompt === 'string'
          ? (args as { prompt: string }).prompt.trim()
          : '';
      if (!prompt) {
        return {
          ok: false,
          code: 'input_invalid',
          error: 'prompt is required — say what to ask the assistant.',
          field: 'prompt',
        };
      }
      // Re-entrancy guard. The consulted turn runs with `agentId` set below, so
      // an agent that somehow has this tool in its own toolset cannot consult
      // itself into a loop the caller pays for and nobody hears.
      if (ctx.agentId === CONSULT_AGENT_ID) {
        return {
          ok: false,
          code: 'not_available',
          error: 'agent_consult is the voice surface’s call into the agent; it cannot nest.',
        };
      }
      try {
        return { ok: true, value: await runConsult(loop, prompt, ctx, opts) };
      } catch (err) {
        return {
          ok: false,
          code: 'execution_failed',
          error: err instanceof Error ? err.message : String(err),
          cause: err,
        };
      }
    },
  };
}

/** `ToolContext.agentId` of the consulted turn. See the re-entrancy guard. */
const CONSULT_AGENT_ID = 'voice-consult';

async function runConsult(
  loop: AgentLoop,
  prompt: string,
  ctx: ToolContext,
  opts: AgentConsultOptions,
): Promise<string> {
  // The pin wins over the context. A receptionist consult that fell back to the
  // caller's context personality on a missing id would be the owner's scope,
  // which is the one outcome this must never produce.
  const personalityId = opts.personalityId ?? ctx.personalityId;
  let output = '';
  for await (const event of loop.run(prompt, {
    // The consult runs on the CALLER's session key — the talk-session lane. A
    // fresh key per consult would give the agent amnesia between one spoken
    // question and the next, which is the opposite of what a conversation is.
    sessionKey: ctx.sessionKey,
    ...(personalityId ? { personalityId } : {}),
    abortSignal: ctx.abortSignal,
    agentId: CONSULT_AGENT_ID,
    voiceOrigin: opts.voiceOrigin,
  })) {
    if (event.type === 'text_delta') output += event.text;
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'done') break;
  }
  return output.trim();
}
