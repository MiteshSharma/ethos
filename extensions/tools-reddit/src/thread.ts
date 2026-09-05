import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { getAccessToken, REDDIT_USER_AGENT, refreshAccessToken } from './auth';
import {
  DEFAULT_CLIENT_ID_REF,
  DEFAULT_CLIENT_SECRET_REF,
  HELP_TEXT,
  SEARCH_HOST,
  TOKEN_HOST,
} from './constants';

// ---------------------------------------------------------------------------
// reddit_thread — fetch one post plus its comment tree via Reddit's official
// OAuth API (GET https://oauth.reddit.com/comments/<id>). Companion to
// reddit_search (index.ts): same credentials flow, same 401-retry, same error
// shapes. See plan/phases/marketing-team.md D9/T4.
// ---------------------------------------------------------------------------

const NO_CREDENTIALS_MESSAGE =
  "Reddit credentials are not configured — bind client_id and client_secret in this personality's Tool settings section (Settings > Named Secrets, then bind to reddit_thread). In the meantime, web_search with a site:reddit.com query works with no setup.";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 5;

const SELFTEXT_MAX_CHARS = 2_000;
const COMMENT_MAX_CHARS = 600;

export interface RedditThreadArgs {
  permalink: string;
  limit?: number;
  depth?: number;
}

interface RedditThreadPostData {
  title?: string;
  selftext?: string;
  subreddit?: string;
  author?: string;
  score?: number;
  upvote_ratio?: number;
  num_comments?: number;
  created_utc?: number;
  permalink?: string;
  url?: string;
  link_flair_text?: string | null;
  over_18?: boolean;
  locked?: boolean;
}

interface RedditCommentData {
  author?: string;
  body?: string;
  score?: number;
  created_utc?: number;
  depth?: number;
  replies?: RedditListing | '';
  distinguished?: string | null;
  stickied?: boolean;
  is_submitter?: boolean;
  /** Present on `kind: 'more'` nodes — how many comments were not loaded. */
  count?: number;
}

interface RedditListing {
  data?: {
    children?: Array<{ kind?: string; data?: RedditCommentData }>;
  };
}

interface RedditPostListing {
  data?: {
    children?: Array<{ kind?: string; data?: RedditThreadPostData }>;
  };
}

type RedditThreadResponse = [RedditPostListing?, RedditListing?];

/**
 * Extracts the base36 post id from any of the forms an agent is likely to
 * hand over: a full reddit.com / old.reddit.com URL, a bare `/r/.../comments/<id>/...`
 * path, a bare id, or a `t3_<id>` fullname. Returns null when no id can be
 * found.
 */
export function parseRedditPostId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const fullname = /^t3_([a-z0-9]+)$/i.exec(trimmed);
  if (fullname?.[1]) return fullname[1].toLowerCase();

  if (/^[a-z0-9]{1,16}$/i.test(trimmed)) return trimmed.toLowerCase();

  const path = /\/comments\/([a-z0-9]+)(?:[/?#]|$)/i.exec(trimmed);
  if (path?.[1]) return path[1].toLowerCase();

  return null;
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

function buildThreadUrl(id: string, limit: number, depth: number): string {
  const params = new URLSearchParams({
    limit: String(limit),
    depth: String(depth),
    sort: 'top',
    raw_json: '1',
  });
  return `https://${SEARCH_HOST}/comments/${encodeURIComponent(id)}?${params.toString()}`;
}

function formatDate(createdUtc: number | undefined): string {
  return createdUtc ? new Date(createdUtc * 1000).toISOString().slice(0, 10) : 'unknown date';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} [truncated]` : text;
}

function isDeleted(comment: RedditCommentData): boolean {
  const author = comment.author ?? '';
  const body = comment.body ?? '';
  return (
    author === '[deleted]' ||
    author === '[removed]' ||
    body === '[deleted]' ||
    body === '[removed]' ||
    !body.trim()
  );
}

function formatComment(comment: RedditCommentData, level: number): string {
  const tags = [`${comment.score ?? 0} pts`];
  if (comment.is_submitter) tags.push('OP');
  if (comment.distinguished === 'moderator') tags.push('mod');
  else if (comment.distinguished === 'admin') tags.push('admin');
  if (comment.stickied) tags.push('stickied');

  const body = truncate(
    (comment.body ?? '').replace(/\s*\r?\n\s*/g, ' ').trim(),
    COMMENT_MAX_CHARS,
  );
  const indent = '  '.repeat(level);
  return `${indent}- u/${comment.author ?? 'unknown'} (${tags.join(', ')}) ${formatDate(comment.created_utc)}: ${body}`;
}

interface CommentCounts {
  shown: number;
  more: number;
}

function walkComments(
  listing: RedditListing | '' | undefined,
  level: number,
  maxDepth: number,
  out: string[],
  counts: CommentCounts,
): void {
  if (!listing || typeof listing === 'string') return;
  for (const child of listing.data?.children ?? []) {
    if (child.kind === 'more') {
      counts.more += child.data?.count ?? 0;
      continue;
    }
    if (child.kind !== 't1' || !child.data) continue;
    const comment = child.data;
    if (isDeleted(comment)) continue;

    out.push(formatComment(comment, level));
    counts.shown += 1;
    if (level + 1 < maxDepth) walkComments(comment.replies, level + 1, maxDepth, out, counts);
  }
}

function formatThread(
  post: RedditThreadPostData,
  comments: RedditListing | undefined,
  maxDepth: number,
): string {
  const subreddit = post.subreddit ? `r/${post.subreddit}` : 'r/unknown';
  const ratio =
    typeof post.upvote_ratio === 'number'
      ? ` (${Math.round(post.upvote_ratio * 100)}% upvoted)`
      : '';
  const permalink = post.permalink ? `https://reddit.com${post.permalink}` : '';

  const flags: string[] = [];
  if (post.locked) flags.push('locked');
  if (post.over_18) flags.push('NSFW');

  const lines = [
    `# ${post.title ?? 'Untitled'}`,
    `${subreddit} | u/${post.author ?? 'unknown'} | ${post.score ?? 0} points${ratio} | ${post.num_comments ?? 0} comments | ${formatDate(post.created_utc)}`,
  ];
  if (post.link_flair_text) lines.push(`Flair: ${post.link_flair_text}`);
  if (flags.length > 0) lines.push(`Flags: ${flags.join(', ')}`);
  if (permalink) lines.push(permalink);
  if (post.url && post.permalink && !post.url.endsWith(post.permalink)) {
    lines.push(`Link: ${post.url}`);
  }

  const selftext = post.selftext?.trim() ?? '';
  if (selftext) lines.push('', truncate(selftext, SELFTEXT_MAX_CHARS));

  const rendered: string[] = [];
  const counts: CommentCounts = { shown: 0, more: 0 };
  walkComments(comments, 0, maxDepth, rendered, counts);

  lines.push('');
  if (rendered.length === 0) {
    lines.push('## Comments', 'No comments yet.');
  } else {
    const notLoaded = counts.more > 0 ? `, ${counts.more} more not loaded` : '';
    lines.push(`## Comments (${counts.shown} shown${notLoaded})`, ...rendered);
  }

  return lines.join('\n');
}

async function fetchThread(url: string, token: string, ctx: ToolContext): Promise<Response> {
  const net = ctx.scopedFetch;
  if (!net) throw new Error('scopedFetch not configured');
  return net.fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': REDDIT_USER_AGENT,
    },
    signal: ctx.abortSignal,
  });
}

function describeApiError(status: number, body: string): string {
  const base = `Reddit API error ${status}: ${body}`;
  if (status === 403) {
    return `${base} (the client may not be approved yet or the subreddit is private/quarantined)`;
  }
  if (status === 429) {
    return `${base} (rate limited — Reddit allows 100 requests/min per client)`;
  }
  return base;
}

export function createRedditThreadTool(): Tool {
  return {
    name: 'reddit_thread',
    description:
      'Fetch a single Reddit post and its comment tree via the official OAuth API. Accepts a full reddit.com URL, a /r/.../comments/<id>/ path, or a bare post id. Returns the post body plus top comments, nested by depth. Requires a Reddit client_id/client_secret.',
    toolset: 'web',
    maxResultChars: 20_000,
    capabilities: {
      network: { allowedHosts: [SEARCH_HOST, TOKEN_HOST] },
      secrets: [DEFAULT_CLIENT_ID_REF, DEFAULT_CLIENT_SECRET_REF],
    },
    outputIsUntrusted: true,
    settingsSchema: {
      fields: [
        {
          kind: 'secret-binding',
          key: 'client_id',
          label: 'Reddit client ID',
          secretKind: 'reddit-client-id',
          required: true,
          helpText: HELP_TEXT,
        },
        {
          kind: 'secret-binding',
          key: 'client_secret',
          label: 'Reddit client secret',
          secretKind: 'reddit-client-secret',
          required: true,
          helpText: HELP_TEXT,
        },
      ],
    },
    // Always registered — a key can arrive from the named-secrets vault, which
    // isAvailable() cannot see (no ToolContext at filter time). execute()
    // surfaces a clear "no credentials configured" error. Same reasoning as
    // web_search / x_search / reddit_search.
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        permalink: {
          type: 'string',
          description:
            'The post to fetch: a full reddit.com or old.reddit.com URL, a /r/<sub>/comments/<id>/... path, a bare post id, or a t3_<id> fullname',
        },
        limit: {
          type: 'number',
          description: `Number of top-level comments to request (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
        },
        depth: {
          type: 'number',
          description: `How many reply levels to include (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH})`,
        },
      },
      required: ['permalink'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const { permalink, limit, depth } = args as RedditThreadArgs;

      if (!permalink || typeof permalink !== 'string') {
        return { ok: false, error: 'permalink is required', code: 'input_invalid' };
      }
      const id = parseRedditPostId(permalink);
      if (!id) {
        return {
          ok: false,
          error: `Could not find a Reddit post id in "${permalink}" — pass a reddit.com post URL, a /r/<sub>/comments/<id>/ path, or a bare post id`,
          code: 'input_invalid',
        };
      }

      const secrets = ctx.secretsResolver;
      const net = ctx.scopedFetch;
      if (!secrets || !net) {
        return {
          ok: false,
          error: 'Capability backends not configured',
          code: 'not_available' as const,
        };
      }

      const [clientId, clientSecret] = await Promise.all([
        secrets.get(DEFAULT_CLIENT_ID_REF),
        secrets.get(DEFAULT_CLIENT_SECRET_REF),
      ]);
      if (!clientId || !clientSecret) {
        return { ok: false, error: NO_CREDENTIALS_MESSAGE, code: 'not_available' as const };
      }

      const maxDepth = clampInt(depth, DEFAULT_DEPTH, MAX_DEPTH);
      const url = buildThreadUrl(id, clampInt(limit, DEFAULT_LIMIT, MAX_LIMIT), maxDepth);

      try {
        let token = await getAccessToken(
          clientId,
          clientSecret,
          net.fetch.bind(net),
          ctx.abortSignal,
        );
        let response = await fetchThread(url, token, ctx);

        if (response.status === 401) {
          token = await refreshAccessToken(
            clientId,
            clientSecret,
            net.fetch.bind(net),
            ctx.abortSignal,
          );
          response = await fetchThread(url, token, ctx);
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            ok: false,
            error: describeApiError(response.status, body),
            code: 'execution_failed',
          };
        }

        const data = (await response.json()) as RedditThreadResponse;
        const post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : undefined;
        if (!post) {
          return {
            ok: false,
            error: `Reddit API returned no post for id ${id}`,
            code: 'execution_failed',
          };
        }

        return { ok: true, value: formatThread(post, data[1], maxDepth) };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

export const redditThreadTool = createRedditThreadTool();
