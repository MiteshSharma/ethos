import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';
import { getAccessToken, REDDIT_USER_AGENT, refreshAccessToken } from './auth';
import {
  DEFAULT_CLIENT_ID_REF,
  DEFAULT_CLIENT_SECRET_REF,
  HELP_TEXT,
  SEARCH_HOST,
  TOKEN_HOST,
} from './constants';

export { createRedditThreadTool, parseRedditPostId, redditThreadTool } from './thread';

// ---------------------------------------------------------------------------
// reddit_search — Reddit's official OAuth API
// (GET https://oauth.reddit.com/{r/<subreddit>/}search). See
// plan/phases/reddit-research-tool.md for the full design. Single provider
// (Reddit) — no backend-selection layer, same shape as x_search
// (extensions/tools-x-search/src/index.ts) rather than web_search's
// multi-backend indirection.
// ---------------------------------------------------------------------------

const NO_CREDENTIALS_MESSAGE =
  "Reddit credentials are not configured — bind client_id and client_secret in this personality's Tool settings section (Settings > Named Secrets, then bind to reddit_search). In the meantime, web_search with a site:reddit.com query works with no setup.";

const DEFAULT_TIME_FILTER = 'week';
const DEFAULT_SORT = 'relevance';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

const SNIPPET_MAX_CHARS = 400;

export type RedditTimeFilter = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
export type RedditSort = 'relevance' | 'hot' | 'top' | 'new' | 'comments';

export interface RedditSearchArgs {
  query: string;
  subreddit?: string;
  time_filter?: RedditTimeFilter;
  sort?: RedditSort;
  limit?: number;
}

interface RedditPostData {
  title?: string;
  selftext?: string;
  subreddit?: string;
  author?: string;
  score?: number;
  num_comments?: number;
  created_utc?: number;
  permalink?: string;
}

interface RedditSearchResponse {
  data?: {
    children?: Array<{ data?: RedditPostData }>;
  };
}

function buildSearchUrl(args: RedditSearchArgs): string {
  const subreddit = args.subreddit?.trim();
  const base = subreddit
    ? `https://${SEARCH_HOST}/r/${encodeURIComponent(subreddit)}/search`
    : `https://${SEARCH_HOST}/search`;

  const params = new URLSearchParams({
    q: args.query,
    sort: args.sort ?? DEFAULT_SORT,
    t: args.time_filter ?? DEFAULT_TIME_FILTER,
    limit: String(Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT)),
  });
  if (subreddit) params.set('restrict_sr', '1');

  return `${base}?${params.toString()}`;
}

function formatResult(post: RedditPostData, index: number): string {
  const title = post.title ?? 'Untitled';
  const subreddit = post.subreddit ? `r/${post.subreddit}` : 'r/unknown';
  const score = post.score ?? 0;
  const comments = post.num_comments ?? 0;
  const permalink = post.permalink ? `https://reddit.com${post.permalink}` : '';
  const created = post.created_utc
    ? new Date(post.created_utc * 1000).toISOString().slice(0, 10)
    : 'unknown date';
  const snippet = post.selftext?.trim().slice(0, SNIPPET_MAX_CHARS) ?? '';

  const lines = [
    `${index + 1}. **${title}**`,
    `   ${subreddit} | ${score} points, ${comments} comments | ${created}`,
    `   ${permalink}`,
  ];
  if (snippet) lines.push(`   ${snippet}`);
  return lines.join('\n');
}

async function fetchSearchResults(url: string, token: string, ctx: ToolContext): Promise<Response> {
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

export function createRedditSearchTool(): Tool {
  return {
    name: 'reddit_search',
    description:
      "Search Reddit via its official OAuth API. Returns post titles, subreddits, engagement counts, permalinks, and snippets. Supports subreddit scoping and a native time filter ('week' = past 7 days). Requires a Reddit client_id/client_secret.",
    toolset: 'web',
    maxResultChars: 15_000,
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
    // web_search / x_search.
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        subreddit: {
          type: 'string',
          description: 'Restrict the search to this subreddit (without the r/ prefix)',
        },
        time_filter: {
          type: 'string',
          enum: ['hour', 'day', 'week', 'month', 'year', 'all'],
          description: `Time window for results (default '${DEFAULT_TIME_FILTER}')`,
        },
        sort: {
          type: 'string',
          enum: ['relevance', 'hot', 'top', 'new', 'comments'],
          description: `Sort order (default '${DEFAULT_SORT}')`,
        },
        limit: {
          type: 'number',
          description: `Number of results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
        },
      },
      required: ['query'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const { query, subreddit, time_filter, sort, limit } = args as RedditSearchArgs;

      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };

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

      const url = buildSearchUrl({ query, subreddit, time_filter, sort, limit });

      try {
        let token = await getAccessToken(
          clientId,
          clientSecret,
          net.fetch.bind(net),
          ctx.abortSignal,
        );
        let response = await fetchSearchResults(url, token, ctx);

        if (response.status === 401) {
          token = await refreshAccessToken(
            clientId,
            clientSecret,
            net.fetch.bind(net),
            ctx.abortSignal,
          );
          response = await fetchSearchResults(url, token, ctx);
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            ok: false,
            error: `Reddit API error ${response.status}: ${body}`,
            code: 'execution_failed',
          };
        }

        const data = (await response.json()) as RedditSearchResponse;
        const posts = (data.data?.children ?? [])
          .map((c) => c.data)
          .filter((p): p is RedditPostData => Boolean(p));

        if (posts.length === 0) {
          return { ok: true, value: `No results found for: ${query}` };
        }

        const formatted = posts.map((p, i) => formatResult(p, i)).join('\n\n');
        return { ok: true, value: `Reddit search results for "${query}":\n\n${formatted}` };
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

export const redditSearchTool = createRedditSearchTool();
