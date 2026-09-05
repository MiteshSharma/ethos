// Bolt wiring for `link_shared` — when an Ethos web UI URL is pasted into
// Slack, we unfurl it into a rich Block Kit card. Mirrors `events/messages.ts`
// and `home/handlers.ts`: `registerLinkEvents(app, deps)` registers the event,
// gathers data from the injected lookup readers, and calls `chat.unfurl`.
//
// Three URL types unfurl: `/sessions/<id>`, `/kanban/<ticket>`, and
// `/personalities/<id>` — all id-addressed metadata.
//
// `matchEthosUrl` is the pure, testable core: it answers "is this shared URL
// under our configured web UI base, and what does its path point to?". Matching
// strictly against the configured origin is also the cross-workspace guard —
// we never fetch data for a URL that isn't under our own base, so an unfurl can
// never leak one workspace's session/ticket/personality into another.
//
// An unfurl is all-or-nothing per URL: when a needed reader is unwired or the
// id isn't found, that URL is skipped entirely rather than rendered as a hollow
// card. Reader failures and `chat.unfurl` failures are swallowed — Slack and the
// readers are things we don't control, and a bad event must never crash Bolt's
// event loop.

import type { App } from '@slack/bolt';
import type { SlackBlock } from '../blocks/shared';
import {
  type KanbanUnfurlData,
  kanbanUnfurlBlocks,
  type PersonalityUnfurlData,
  personalityUnfurlBlocks,
  type SessionUnfurlData,
  sessionUnfurlBlocks,
} from '../blocks/unfurl';
import { canSpeakInChannel } from '../routing/triage';

/** Lookup-by-id readers the unfurl handler needs. A `link_shared` URL carries a
 *  specific id, so unlike the list-oriented readers used by `/ethos` commands
 *  and the App Home tab, these are point lookups. All optional and injected by
 *  the wiring layer — the Slack package never imports the sibling extensions.
 *  A lookup returns `null` when the id doesn't exist; the handler then skips
 *  that URL rather than posting an empty card. */
export interface SessionUnfurlReader {
  lookupSession(id: string): Promise<SessionUnfurlData | null>;
}
export interface KanbanUnfurlReader {
  lookupTicket(id: string): Promise<KanbanUnfurlData | null>;
}
export interface PersonalityUnfurlReader {
  lookupPersonality(id: string): Promise<PersonalityUnfurlData | null>;
}

export interface LinkEventDeps {
  /** Ethos web UI origin (already normalized — canonicalized, no trailing
   *  slash). When absent, the adapter can't recognize Ethos URLs and the
   *  `link_shared` handler is never registered. */
  webUiBaseUrl?: string;
  /** Resolves the active channel mode for a channel id. `string`, not
   *  `ChannelMode` — a stored override this build's enum cannot read reaches
   *  here verbatim, and `canSpeakInChannel` fails closed on it.
   *
   *  REQUIRED, unlike every other dep on this interface. The readers below are
   *  optional because an absent one degrades to a skipped unfurl, which is
   *  safe; an absent mode resolver would degrade to unfurling into a room that
   *  asked for silence, which is the bug this dep exists to close. A caller
   *  that cannot supply it has no business registering this handler. */
  resolveChannelMode: (channel: string) => string;
  session?: SessionUnfurlReader;
  kanban?: KanbanUnfurlReader;
  personality?: PersonalityUnfurlReader;
}

/** The one Bolt `client` capability the link handler uses. Narrowed at the call
 *  site for the same reason `home/handlers.ts` narrows `views.publish` — keep
 *  the single method type-checked without a direct `@slack/web-api` dependency.
 *  `chat.unfurl` takes a `unfurls` map keyed by the shared URL. */
type LinkClient = {
  chat: {
    unfurl: (args: {
      channel: string;
      ts: string;
      unfurls: Record<string, { blocks: SlackBlock[] }>;
    }) => Promise<unknown>;
  };
};

/** A recognized Ethos web UI URL — each variant is an id-addressed resource. */
export type EthosUrlMatch =
  | { kind: 'session'; id: string }
  | { kind: 'kanban'; id: string }
  | { kind: 'personality'; id: string };

/**
 * Match a shared URL against the configured Ethos web UI base. Returns the
 * recognized resource, or `null` when the URL is malformed, on a different
 * origin, outside the base path, or on an unrecognized path. Strict by design:
 * only URLs whose origin AND path-prefix equal the configured base are
 * matched, which is what keeps one workspace's bot from unfurling another
 * workspace's links.
 */
export function matchEthosUrl(
  sharedUrl: string,
  webUiBaseUrl: string | undefined,
): EthosUrlMatch | null {
  if (!webUiBaseUrl) return null;
  let base: URL;
  let url: URL;
  try {
    base = new URL(webUiBaseUrl);
    url = new URL(sharedUrl);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;

  // Strip the base's path prefix so path-prefixed deployments
  // (`https://host/app`) work — the resource path is whatever follows it.
  // The match must respect a path-segment boundary: a bare `startsWith`
  // would let base `/app` also match `/appmemory` or `/appsessions/abc`,
  // unfurling same-domain links that aren't under the configured base.
  // Require the path to equal the prefix or continue with a `/`. An empty
  // `basePath` (no prefix) trivially passes — every path starts with `/`.
  const basePath = base.pathname.replace(/\/+$/, '');
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    return null;
  }
  const rest = url.pathname.slice(basePath.length);

  const segments = rest.split('/').filter((s) => s.length > 0);

  if (segments.length === 2) {
    const [collection, rawId] = segments;
    // `decodeURIComponent` throws `URIError` on malformed percent-encoding
    // (e.g. `/sessions/%E0%A4%A`) — a same-origin URL that parses fine as a
    // `URL`. This function is contractually total, so a bad encoding is just
    // "no match", never a throw that escapes into the Bolt event loop.
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return null;
    }
    if (collection === 'sessions') return { kind: 'session', id };
    if (collection === 'kanban') return { kind: 'kanban', id };
    if (collection === 'personalities') return { kind: 'personality', id };
  }
  return null;
}

/** Upper bound on Ethos URLs resolved per `link_shared` event — caps the
 *  reader fan-out so a message spamming links can't trigger an unbounded
 *  burst of lookups. A single Slack message rarely carries more than a
 *  handful of links worth unfurling. */
const MAX_UNFURLS_PER_EVENT = 10;

export function registerLinkEvents(app: App, deps: LinkEventDeps): void {
  // No configured web UI base → we can't recognize any Ethos URL, so there is
  // nothing for the handler to do. Don't register it at all.
  if (!deps.webUiBaseUrl) return;

  app.event('link_shared', async ({ event, client }) => {
    const evt = event as {
      channel?: string;
      message_ts?: string;
      links?: Array<{ url?: string }>;
    };
    if (!evt.channel || !evt.message_ts || !evt.links) return;

    // An unfurl is content posted into the channel — a card with our data in
    // it, attached to someone's message, visible to everyone in the room. It
    // had no mode check at all, so a room set to `observe` still got one
    // whenever anybody pasted an Ethos link. Checked before the reader fan-out
    // as well as before `chat.unfurl`: a silent room should not even cost the
    // lookups.
    if (!canSpeakInChannel(deps.resolveChannelMode(evt.channel))) return;

    // Match first, then resolve concurrently. Each `buildUnfurl` hits a
    // backing reader; serializing them would make the handler's latency the
    // sum of every lookup, and a slow event handler is what Slack retries.
    // The per-event cap bounds the fan-out — a message spamming Ethos links
    // can't trigger an unbounded burst of reader calls.
    const matched: Array<{ url: string; match: EthosUrlMatch }> = [];
    for (const link of evt.links) {
      const url = link.url;
      if (!url) continue;
      const match = matchEthosUrl(url, deps.webUiBaseUrl);
      if (match) matched.push({ url, match });
      if (matched.length >= MAX_UNFURLS_PER_EVENT) break;
    }

    const unfurls: Record<string, { blocks: SlackBlock[] }> = {};
    const resolved = await Promise.all(
      matched.map(async ({ url, match }) => ({ url, blocks: await buildUnfurl(match, deps) })),
    );
    for (const { url, blocks } of resolved) {
      // An unfurl is all-or-nothing: only add a URL once we have real data.
      if (blocks) unfurls[url] = { blocks };
    }

    if (Object.keys(unfurls).length === 0) return;
    try {
      await (client as LinkClient).chat.unfurl({
        channel: evt.channel,
        ts: evt.message_ts,
        unfurls,
      });
    } catch {
      // Slack is the one thing we don't control — a `chat.unfurl` failure or
      // Bolt API drift must not throw inside the event loop.
    }
  });
}

/** Resolve one matched URL to its unfurl blocks, or `null` when the backing
 *  reader is unwired, the id isn't found, or the reader throws. */
async function buildUnfurl(
  match: EthosUrlMatch,
  deps: LinkEventDeps,
): Promise<SlackBlock[] | null> {
  try {
    switch (match.kind) {
      case 'session': {
        if (!deps.session) return null;
        const data = await deps.session.lookupSession(match.id);
        return data ? sessionUnfurlBlocks(data) : null;
      }
      case 'kanban': {
        if (!deps.kanban) return null;
        const data = await deps.kanban.lookupTicket(match.id);
        return data ? kanbanUnfurlBlocks(data) : null;
      }
      case 'personality': {
        if (!deps.personality) return null;
        const data = await deps.personality.lookupPersonality(match.id);
        return data ? personalityUnfurlBlocks(data) : null;
      }
    }
  } catch {
    // A reader failure for one URL must not crash the whole event.
    return null;
  }
}
