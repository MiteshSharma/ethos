import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// x_search — xAI's Responses API (`POST https://api.x.ai/v1/responses`) with
// the `x_search` tool type. xAI's backend performs the actual X/Twitter
// search server-side and returns results as `citations` on the response
// object; this is NOT a call to X/Twitter's own search API. See
// plan/phases/x-search-tool.md for the full design and the "Why" section's
// table distinguishing this from X's native `/2/tweets/search/recent`.
//
// Unlike `web_search` (extensions/tools-web/), there is exactly one provider
// (xAI) — no backend-selection layer, no provider enum in settingsSchema.
// ---------------------------------------------------------------------------

const X_API_URL = 'https://api.x.ai/v1/responses';
const X_API_HOST = 'api.x.ai';

/**
 * Default secretRef — what `execute()` resolves when no personality binding
 * names a secret. A binding (see `XSearchSetting`) resolves
 * `providers/xai/<name>` instead, following `web_search`'s 4-step resolution
 * (extensions/tools-web/src/index.ts).
 */
const DEFAULT_SECRET_REF = 'providers/xai/apiKey';
const SECRET_PREFIX = 'providers/xai/';

const NO_KEY_MESSAGE =
  "No xAI key configured — add an xAI key in Settings → Security → Named Secrets (provider xAI), then bind it to x_search in the personality's tool settings, or set XAI_API_KEY.";

/**
 * Default Grok model. Confirmed against xAI's own docs (docs.x.ai/developers/tools/x-search
 * and docs.x.ai/docs/guides/live-search, re-fetched during implementation): "grok-4.6" is
 * used throughout xAI's `x_search`/web-search examples and described as the reasoning
 * model with tool access. Overridable per-process via the `XAI_X_SEARCH_MODEL` env var, or
 * per-instance via `createXSearchTool({ model })` — never hardcoded with no escape hatch,
 * since xAI's recommended model will move on before this file does.
 */
const DEFAULT_MODEL = 'grok-4.6';

/**
 * Client-side cap on how many citation entries are formatted into the tool
 * result. xAI's `x_search` tool type has no server-side "number of results"
 * parameter (confirmed: docs.x.ai/developers/tools/x-search's request shape
 * has no such field) — `citations` on the response is xAI's own trimmed list.
 * `num_results` here trims OUR formatted output, the same role `web_search`'s
 * `num_results` plays over Exa/Tavily/Brave hits (extensions/tools-web/src/index.ts).
 * Default/cap are scaled up from web_search's 5/10 because citations are bare
 * URLs (cheap to list) rather than full title+snippet hits.
 */
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 25;

const MAX_HANDLES = 20;

export interface XSearchArgs {
  query: string;
  num_results?: number;
  from_date?: string;
  to_date?: string;
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
}

// ---------------------------------------------------------------------------
// Response parsing
//
// GENUINELY UNVERIFIED AGAINST A LIVE RESPONSE — no XAI_API_KEY was available
// to test against during implementation. Built from xAI's documented
// behavior only (re-fetched during implementation):
//
//   - docs.x.ai/developers/tools/citations states `response.citations` is a
//     top-level array of plain URL strings, e.g.
//     `['https://x.com/i/user/...', 'https://x.ai/news', ...]`. It also
//     mentions a SEPARATE inline-citation shape (annotation objects with
//     `url`/`start_index`/`end_index`/`title`) used for positional citations
//     within message text — a different field, not `response.citations`.
//   - docs.x.ai/docs/api-reference shows the general Responses API envelope:
//     `output` is an array of items; a message item has
//     `{ type: 'message', role, content: [{ type: 'output_text', text }] }`.
//
// Neither fetch produced a full example response FOR an `x_search` call
// specifically, so `normalizeCitations` below handles citations as either
// plain URL strings (documented shape) or `{ url, title? }` objects
// (defensive, in case `x_search` citations carry titles the way inline
// citations do) rather than assuming one narrow shape. Sanity-check this
// against a real API response before shipping to production traffic.
// ---------------------------------------------------------------------------

interface XResponseOutputContent {
  type?: string;
  text?: string;
}

interface XResponseOutputItem {
  type?: string;
  role?: string;
  content?: XResponseOutputContent[];
}

interface XSearchApiResponse {
  output?: XResponseOutputItem[];
  citations?: unknown;
}

interface Citation {
  url: string;
  title?: string;
}

function extractAnswerText(output: XResponseOutputItem[] | undefined): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (c?.type === 'output_text' && typeof c.text === 'string' && c.text.length > 0) {
        parts.push(c.text);
      }
    }
  }
  return parts.join('\n\n').trim();
}

function normalizeCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ url: item });
      continue;
    }
    if (item && typeof item === 'object' && 'url' in item) {
      const url = (item as { url?: unknown }).url;
      if (typeof url === 'string') {
        const title = (item as { title?: unknown }).title;
        out.push({ url, title: typeof title === 'string' ? title : undefined });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/**
 * A resolved per-personality x_search binding. `secret` is a NAME only (e.g.
 * `xai-main`) — never a value — that resolves to `providers/xai/<name>` in the
 * vault. Absent → `providers/xai/apiKey`.
 */
export interface XSearchSetting {
  secret?: string;
}

export interface CreateXSearchToolOptions {
  /** Overrides DEFAULT_MODEL / XAI_X_SEARCH_MODEL. See DEFAULT_MODEL's comment. */
  model?: string;
  /** Personality-owned binding (source of truth), resolved by personalityId. */
  resolvePersonalitySetting?: (personalityId: string) => XSearchSetting | undefined;
  /** Global FALLBACK map keyed by personalityId or `_default`. */
  toolSettings?: Record<string, { x_search?: XSearchSetting } | undefined>;
}

export function createXSearchTool(opts: CreateXSearchToolOptions = {}): Tool {
  const model = opts.model ?? process.env.XAI_X_SEARCH_MODEL ?? DEFAULT_MODEL;
  const { resolvePersonalitySetting, toolSettings } = opts;

  // Same resolution order as web_search: personality tools.yaml → global
  // toolSettings[pid] → global toolSettings._default → the default-named key.
  function selectSecretRef(ctx: ToolContext): string {
    const pid = ctx.personalityId;
    const setting =
      (pid ? resolvePersonalitySetting?.(pid) : undefined) ??
      (pid ? toolSettings?.[pid]?.x_search : undefined) ??
      toolSettings?._default?.x_search;
    const name = setting?.secret?.trim();
    return name ? `${SECRET_PREFIX}${name}` : DEFAULT_SECRET_REF;
  }

  return {
    name: 'x_search',
    description:
      "Search X (Twitter) posts via xAI's Grok search. Returns a synthesized answer plus source citations. Requires an xAI API key.",
    toolset: 'web',
    maxResultChars: 15_000,
    capabilities: {
      network: { allowedHosts: [X_API_HOST] },
      // Prefix grant over the xAI namespace: any personality binding is
      // `providers/xai/<name>`, so it always falls inside this static allowlist.
      secrets: [`${SECRET_PREFIX}*`],
    },
    outputIsUntrusted: true,
    // Per-personality config contract. The settings UI renders a secret picker
    // over `x-search` named secrets; only the secret NAME is ever stored.
    settingsSchema: {
      fields: [
        {
          kind: 'secret-binding',
          key: 'secret',
          label: 'xAI API key (X search)',
          secretKind: 'x-search',
        },
      ],
    },
    // Always registered, same reasoning as web_search
    // (extensions/tools-web/src/index.ts:120-126): a key can arrive from the
    // named-secrets vault, which isAvailable() cannot see (no ToolContext at
    // filter time). execute() surfaces a clear "no key configured" error.
    isAvailable() {
      return true;
    },
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: {
          type: 'number',
          description: `Number of source citations to include (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS})`,
        },
        from_date: {
          type: 'string',
          description: 'Only include posts on/after this date (YYYY-MM-DD)',
        },
        to_date: {
          type: 'string',
          description: 'Only include posts on/before this date (YYYY-MM-DD)',
        },
        allowed_x_handles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only search these X handles (max 20). Mutually exclusive with excluded_x_handles.',
        },
        excluded_x_handles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Exclude these X handles from the search (max 20). Mutually exclusive with allowed_x_handles.',
        },
        enable_image_understanding: {
          type: 'boolean',
          description: 'Let the search model interpret images in matched posts',
        },
        enable_video_understanding: {
          type: 'boolean',
          description: 'Let the search model interpret videos in matched posts',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const {
        query,
        num_results,
        from_date,
        to_date,
        allowed_x_handles,
        excluded_x_handles,
        enable_image_understanding,
        enable_video_understanding,
      } = args as XSearchArgs;

      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };

      if (
        allowed_x_handles &&
        allowed_x_handles.length > 0 &&
        excluded_x_handles &&
        excluded_x_handles.length > 0
      ) {
        return {
          ok: false,
          error:
            'allowed_x_handles and excluded_x_handles are mutually exclusive — set at most one.',
          code: 'input_invalid',
        };
      }
      if (allowed_x_handles && allowed_x_handles.length > MAX_HANDLES) {
        return {
          ok: false,
          error: `allowed_x_handles supports at most ${MAX_HANDLES} handles`,
          code: 'input_invalid',
        };
      }
      if (excluded_x_handles && excluded_x_handles.length > MAX_HANDLES) {
        return {
          ok: false,
          error: `excluded_x_handles supports at most ${MAX_HANDLES} handles`,
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

      try {
        const apiKey = await secrets.get(selectSecretRef(ctx));
        if (!apiKey) {
          return { ok: false, error: NO_KEY_MESSAGE, code: 'not_available' as const };
        }

        const xSearchToolEntry: Record<string, unknown> = { type: 'x_search' };
        if (from_date) xSearchToolEntry.from_date = from_date;
        if (to_date) xSearchToolEntry.to_date = to_date;
        if (allowed_x_handles && allowed_x_handles.length > 0) {
          xSearchToolEntry.allowed_x_handles = allowed_x_handles;
        }
        if (excluded_x_handles && excluded_x_handles.length > 0) {
          xSearchToolEntry.excluded_x_handles = excluded_x_handles;
        }
        if (enable_image_understanding !== undefined) {
          xSearchToolEntry.enable_image_understanding = enable_image_understanding;
        }
        if (enable_video_understanding !== undefined) {
          xSearchToolEntry.enable_video_understanding = enable_video_understanding;
        }

        const response = await net.fetch(X_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            input: [{ role: 'user', content: query }],
            tools: [xSearchToolEntry],
          }),
          signal: ctx.abortSignal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            ok: false,
            error: `xAI API error ${response.status}: ${body}`,
            code: 'execution_failed',
          };
        }

        const data = (await response.json()) as XSearchApiResponse;
        const answer = extractAnswerText(data.output);
        const cap = Math.min(num_results ?? DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
        const citations = normalizeCitations(data.citations).slice(0, cap);

        if (!answer && citations.length === 0) {
          return { ok: true, value: `No results found for: ${query}` };
        }

        const sourceLines = citations
          .map((c, i) => (c.title ? `${i + 1}. ${c.title}\n   ${c.url}` : `${i + 1}. ${c.url}`))
          .join('\n');

        const parts: string[] = [];
        if (answer) parts.push(answer);
        if (sourceLines) parts.push(`Sources:\n${sourceLines}`);

        return { ok: true, value: parts.join('\n\n') };
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

export const xSearchTool = createXSearchTool();
