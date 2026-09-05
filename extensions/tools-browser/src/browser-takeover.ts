// ---------------------------------------------------------------------------
// browser_request_takeover (B1/B2)
// ---------------------------------------------------------------------------
//
// The agent has hit something it cannot get past on its own — a login, an MFA
// prompt, a bot wall — and asks the human to drive the browser for a moment.
// The tool blocks until they hand it back, exactly like `clarify`: the request
// IS a clarify, carrying `kind: 'browser_takeover'` so surfaces draw a panel
// with a Hand back button instead of an answer box (D3).
//
// The one invariant this file exists to hold: the takeover lock is cleared on
// EVERY exit. While `session.takeover` is set the idle sweeper skips the
// session and every other browser tool refuses, so a lock leaked on any path
// wedges browsing for the rest of the process. Hence the `finally` — not four
// clear-calls that a fifth exit path could later slip past.

import type { ClarifyBridge } from '@ethosagent/core';
import { ClarifyNoSurfaceError, ClarifyTimedOutNoDefaultError } from '@ethosagent/core';
import type { ClarifySurfaceType, Tool, ToolResult } from '@ethosagent/types';
import {
  claimTakeoverLease,
  findActiveSession,
  isPlaywrightInstalled,
  notifyTakeoverSettled,
} from './sessions';

const DEFAULT_TIMEOUT_S = 900; // 15 min — same window as `clarify`
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 86_400;
const MAX_RESULT_CHARS = 2_000;

const DESCRIPTION = [
  'Hand the live browser session to the user so they can do one step themselves, then wait for them to hand it back.',
  '',
  'WHEN TO USE',
  '- A login, MFA prompt or consent screen the agent cannot complete',
  '- A CAPTCHA or bot wall that blocked a navigation',
  '- Anything where acting on the page needs a human decision',
  '',
  'WHILE IT WAITS every other browser tool refuses — the browser belongs to the user until they hand it back.',
].join('\n');

interface TakeoverArgs {
  reason?: unknown;
  timeout_s?: unknown;
}

function errorResult(error: string, code: Extract<ToolResult, { ok: false }>['code']): ToolResult {
  return { ok: false, error, code };
}

export function createBrowserTakeoverTool(bridge: ClarifyBridge): Tool<TakeoverArgs> {
  return {
    name: 'browser_request_takeover',
    description: DESCRIPTION,
    toolset: 'browser',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {},
    isAvailable: isPlaywrightInstalled,
    schema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: {
          type: 'string',
          description:
            'What the user needs to do, in one sentence — shown to them verbatim ("log in to example.com").',
        },
        timeout_s: {
          type: 'number',
          description: `Seconds to wait for the hand-back. Default ${DEFAULT_TIMEOUT_S} (15 min).`,
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      if (!reason) {
        return errorResult(
          'browser_request_takeover requires a non-empty `reason`',
          'input_invalid',
        );
      }

      // Capture the SESSION REFERENCE, once. A re-lookup after the human is
      // done can hand back a different object: `getOrCreateSession` tears down
      // and replaces a session whose policy fingerprint changed, so the lock
      // would be cleared on a session that never held it and left set on the
      // one that did.
      const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
      if (!session) {
        return errorResult('No active browser session. Call browse_url first.', 'execution_failed');
      }
      if (session.takeover) {
        return errorResult(
          'This browser session is already handed to a human — wait for that takeover to finish.',
          'not_available',
        );
      }

      const timeoutRaw =
        typeof args.timeout_s === 'number' && Number.isFinite(args.timeout_s)
          ? args.timeout_s
          : DEFAULT_TIMEOUT_S;
      const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Math.round(timeoutRaw)));

      const url = session.page.url();

      // The lock goes on FIRST, before the id exists: every other browser tool
      // has to be refused from this instant, not from whenever the bridge gets
      // around to minting a request id. `onRequestId` below then stamps the id
      // onto this same object, which is what binds the screencast lane to THIS
      // request — see the field's comment in sessions.ts.
      const lock: { requestId?: string } = {};
      session.takeover = lock;
      // ...and the exclusive lease, claimed in the same uninterrupted step. The
      // flag stops the NEXT tool call; the lease waits out the one already
      // running. `drain` is null when nothing was in flight, which is the
      // common case and adds no await — the tool reaches the bridge exactly as
      // promptly as it did before.
      const lease = claimTakeoverLease(ctx.sessionId);
      try {
        if (lease.drain && !(await lease.drain)) {
          return errorResult(
            'The agent is still finishing a browser operation on this session — it did not finish in time to hand the browser over. Try again.',
            'not_available',
          );
        }

        // B2 — a headed session has a real window somewhere behind the user's
        // other windows. Raise it before asking them to use it; a headless
        // session has nothing to raise.
        if (session.headed) await session.page.bringToFront();

        const response = await bridge.request({
          question: `Take over the browser at ${url} — ${reason}`,
          timeoutMs: timeoutS * 1000,
          // Stays `'anyone'`, deliberately, now that it means something narrower
          // than it used to. `answerableBy` is read by exactly one thing — the
          // channel surfaces' `gateAnswerer` — and a channel can no longer
          // ANSWER a takeover at all (`isClarifyAnswerableOn`, enforced in
          // `ClarifyBridge.respond()`). So the only decision left for it to gate
          // on a channel is `cancel`, and cancel is how a person who is not the
          // originator gives up on a browser nobody is going to reach. Narrowing
          // this to `'originator'` would buy nothing on the surfaces that CAN
          // hand back (web/tui/cli never consult it) and would silently strand
          // a background job's takeover, whose row carries no originator stamp
          // at all, on its full 15-minute timeout.
          answerableBy: 'anyone',
          sessionId: ctx.sessionId,
          ...(ctx.jobId !== undefined ? { jobId: ctx.jobId } : {}),
          surfaceType: ctx.platform as ClarifySurfaceType,
          kind: 'browser_takeover',
          // `handbackUrl` is filled in by the bridge from the deployment's
          // configured web address — the tool does not know one.
          meta: { url, sessionId: ctx.sessionId },
          abortSignal: ctx.abortSignal,
          onRequestId: (requestId) => {
            lock.requestId = requestId;
          },
        });

        // The session may have been closed under us — a `/new`, an abort
        // handler, an operator closing the window. `page` is the session's
        // CURRENT page, which is not the one captured above if the session was
        // relaunched mid-takeover.
        const page = session.page;
        if (page.isClosed()) {
          return errorResult(
            'The browser session was closed during the takeover — nothing was handed back.',
            'execution_failed',
          );
        }

        return {
          ok: true,
          value: JSON.stringify(
            {
              // Only a real hand-back is a hand-back. A cancelled takeover
              // reported as `true` would tell the agent the login it is about
              // to depend on has happened.
              handed_back: response.source === 'user',
              outcome: response.source,
              url: page.url(),
            },
            null,
            2,
          ),
        };
      } catch (err) {
        if (err instanceof ClarifyTimedOutNoDefaultError) {
          return errorResult(
            `No one took over the browser within ${timeoutS}s. The page is unchanged; report the blockage.`,
            'execution_failed',
          );
        }
        if (err instanceof ClarifyNoSurfaceError) {
          return errorResult(
            `CLARIFY_NO_SURFACE: ${err.message}. Nobody can be handed this browser — report the blockage instead.`,
            'not_available',
          );
        }
        return errorResult(err instanceof Error ? err.message : String(err), 'execution_failed');
      } finally {
        // Every exit above, plus any future one. Leaving this set makes the
        // session unsweepable and every other browser tool refuse forever.
        // The lease is released from the SAME finally, so the two can never
        // drift: a hand-back, a timeout, a cancel, an abort and a throw all
        // free both. There is no path out of this tool that skips it, which is
        // how an abandoned takeover — nobody ever presses Hand back — releases:
        // the clarify's own 15-minute timeout rejects, and this runs.
        lease.release();
        session.takeover = undefined;
        // ...and tell whoever is watching. A screencast viewer holds a CDP
        // session and keeps dispatching input until something stops it; the
        // clearing above is invisible to it, so a hand-back from the chat
        // card, a timeout or a cancelled turn would leave a human and the
        // resumed agent driving the same page. Fired for every exit path for
        // the same reason the clear is.
        if (lock.requestId) notifyTakeoverSettled(ctx.sessionId, lock.requestId);
      }
    },
  };
}
