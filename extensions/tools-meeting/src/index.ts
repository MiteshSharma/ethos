// @ethosagent/tools-meeting — the `meet_join` tool (transcribe-only Google Meet
// presence, plan/phases/gap-voice-realtime.md §4 Phase D).
//
// `meet_join` joins a Meet via the injected `MeetingClient` boundary
// (`@ethosagent/platform-meeting`), scrapes live captions through the pure
// `CaptionParser`, and writes a markdown transcript + summary through the
// memory-backed transcript writer — the "searchable knowledge base" outcome.
// The concrete Playwright/browser binding is supplied at the app layer; this
// package binds ONLY to interfaces, so it typechecks and unit-tests against a
// fake meeting client + a fake memory.
//
// TRANSCRIBE-ONLY: there is deliberately no speak-into-meeting path (`meet_say`
// is deferred, plan §3(d)/§4).
//
// APPROVAL: joining a meeting is an outward action, so the tool is marked
// `requiresApproval: true` — AgentLoop gates it on the approval surface (the
// same mechanism the outbound `call` tool uses) before any meeting is joined.

import {
  buildTranscriptArtifact,
  CaptionParser,
  createMemoryTranscriptWriter,
  type MeetingClient,
} from '@ethosagent/platform-meeting';
import type {
  MemoryContext,
  MemoryProvider,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';

export interface MeetingToolsOptions {
  /**
   * Meeting boundary used to join and scrape captions. Optional: default
   * installs wire no meeting client (the Playwright/browser binding is
   * app-layer/manual), so `meet_join` reports itself unavailable until one is
   * configured.
   */
  meetingClient?: MeetingClient;
  /** Store the transcript is written to (via `MemoryProvider.sync`). */
  memory?: MemoryProvider;
  /** Display name the bot shows in the meeting roster. Defaults to `Ethos`. */
  displayName?: string;
}

export function createMeetingTools(opts: MeetingToolsOptions = {}): Tool[] {
  return [makeMeetJoinTool(opts)];
}

interface MeetJoinArgs {
  meeting_url: string;
}

const MEET_URL_RE = /^https:\/\/meet\.google\.com\/[a-z0-9-]+(?:\?.*)?$/i;

function makeMeetJoinTool(opts: MeetingToolsOptions): Tool {
  return {
    name: 'meet_join',
    description:
      'Join a Google Meet as a transcribe-only bot participant, capture the live captions, ' +
      'and save a markdown transcript with a short summary to memory. This joins a real ' +
      'meeting and always requires explicit approval. Capture runs until the turn is stopped.',
    toolset: 'meeting',
    maxResultChars: 1024,
    capabilities: {},
    requiresApproval: true,
    outputIsUntrusted: true,
    isAvailable: () => opts.meetingClient !== undefined && opts.memory !== undefined,
    schema: {
      type: 'object',
      properties: {
        meeting_url: {
          type: 'string',
          description: 'Google Meet URL, e.g. https://meet.google.com/abc-defg-hij.',
        },
      },
      required: ['meeting_url'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      return await executeMeetJoin(args as MeetJoinArgs, ctx, opts);
    },
  };
}

async function executeMeetJoin(
  args: MeetJoinArgs,
  ctx: ToolContext,
  opts: MeetingToolsOptions,
): Promise<ToolResult> {
  if (!opts.meetingClient || !opts.memory) {
    return {
      ok: false,
      code: 'not_available',
      error: 'Meeting attendance is not configured — no meeting client is wired.',
    };
  }
  const meetingClient = opts.meetingClient;
  const memory = opts.memory;
  const url = args.meeting_url?.trim();
  if (!url || !MEET_URL_RE.test(url)) {
    return {
      ok: false,
      code: 'input_invalid',
      error: `meeting_url must be a Google Meet URL (e.g. https://meet.google.com/abc-defg-hij), got: ${args.meeting_url ?? '(missing)'}`,
      field: 'meeting_url',
    };
  }

  const parser = new CaptionParser();
  const unsubscribe = meetingClient.onCaption((fragment) => parser.push(fragment));

  try {
    await meetingClient.join({ url, displayName: opts.displayName ?? 'Ethos' });
    // Transcribe until the turn is stopped (abortSignal) — the honest signal a
    // meeting has ended / the agent should leave. The injected transport can
    // also drain and let this resolve immediately (see FakeMeetingClient).
    await waitForAbort(ctx.abortSignal);
  } catch (err) {
    return {
      ok: false,
      code: 'execution_failed',
      error: `Failed to join meeting ${url}: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    };
  } finally {
    unsubscribe();
    await meetingClient.leave();
  }

  const entries = parser.transcript();
  const artifact = buildTranscriptArtifact({ meetingUrl: url, entries });
  const writer = createMemoryTranscriptWriter(memory, buildMeetingMemoryContext(ctx));
  await writer.write(artifact);

  return {
    ok: true,
    value: `Left ${url}. Saved transcript to ${artifact.key} — ${artifact.summary}`,
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function buildMeetingMemoryContext(ctx: ToolContext): MemoryContext {
  return {
    scopeId: ctx.memoryScopeId ?? 'global',
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    platform: ctx.platform,
    workingDir: ctx.workingDir,
  };
}
