// Web watchdog — authored from plan/usecases/07-web-watchdog.md.
//
// Hand-authored, not generated (§6): the usecase doc's config blocks are a
// SPEC, not a source. Three things changed on the way in, all deliberate:
//
//  * `web_search` is dropped so no API key is needed. Every target is an
//    explicit URL the user hands over; there is nothing to search for.
//  * The browser tools are KEPT — JS-heavy listings need them — which means
//    preflight blocks with `TOOL_UNAVAILABLE` until Playwright is installed
//    (`npx playwright install chromium`). That is the honest outcome: an agent
//    that installs fine and then no-ops on half its watchlist is worse than a
//    row that names the one command to run.
//  * A change alert has to reach a phone at 02:00, so delivery follows
//    morning-briefing's path: a Telegram channel with inline setup on the
//    recipe page, and the job delivers through `deliverTo: 'channel'`.
//
// `fsReach` is left unset on purpose: the default scope already covers the
// personality's own directory, which is where `state/<target-id>.json` lives.

import type { RecipeCreateBundle } from '../schema';

const SOUL = `I am Watchdog. I monitor a list of web targets and report *changes*, never repeats.

Operating rules:
- My watchlist lives in memory. Each entry: URL, what to extract, match criteria.
- Seen-state is one JSON file per target under my personality directory:
  state/<target-id>.json — a list of item keys (URL or id + price) I have already reported.
  I read it before scraping, write it after.
- Scrape order: try web_extract first (fast, static HTML). If the page needs JS, fall back
  to browse_url; only use browser_navigate / browser_scroll / browser_click for pagination
  or "load more" flows.
- After scraping, compute the diff: items not in seen-state are NEW; items whose price or
  status differs are CHANGED. If the diff is empty, I output exactly: No changes. — nothing
  else. No summaries of unchanged listings, ever.
- When there IS a diff, I report only the delta: item, what changed, link, price. Then I
  update the state file before finishing.
- If a site blocks me (Cloudflare challenge, 403, empty JS shell), I say so once per target
  and mark it \`blocked\` in the state file instead of retrying forever.
- When a scheduled run has no changes anywhere, I begin my reply with [SILENT] followed by
  No changes. — so nothing is delivered on a quiet night.
`;

export const webWatchdog: RecipeCreateBundle = {
  id: 'web-watchdog',
  version: 1,
  title: 'Web watchdog',
  summary:
    'Scrapes the pages you watch on a schedule, diffs against what it has already seen, and messages you only when something new or changed appears.',
  sourceDoc: 'plan/usecases/07-web-watchdog.md',
  tags: ['scheduled', 'needs-channel', 'no-credentials'],

  personality: {
    mode: 'create',
    id: 'web-watchdog',
    name: 'Watchdog',
    description:
      'Silent site monitor — scrapes watched targets on schedule, diffs against seen-state, speaks only when something changed.',
    soulMd: SOUL,
    provider: 'anthropic',
    model: { trivial: 'claude-haiku-4-5', default: 'claude-sonnet-4-6' },
    capabilities: ['web', 'monitoring'],
    toolset: [
      'cron',
      'web_extract',
      'browse_url',
      'browser_navigate',
      'browser_scroll',
      'browser_click',
      'browser_type',
      'browser_back',
      'browser_screenshot',
      'read_file',
      'write_file',
      'search_files',
      'memory_read',
      'memory_write',
      'session_search',
    ],
    plugins: [],
  },

  requires: {
    mcpServers: [],
    plugins: [],
    channels: [
      {
        platform: 'telegram',
        why: 'Change alerts are delivered to a Telegram chat when the scheduled check finds something new.',
        deliversCron: true,
        inlineSetup: true,
      },
    ],
    tools: [
      'cron',
      'web_extract',
      'browse_url',
      'browser_navigate',
      'browser_scroll',
      'browser_click',
      'browser_type',
      'browser_back',
      'browser_screenshot',
      'read_file',
      'write_file',
      'search_files',
      'memory_read',
      'memory_write',
      'session_search',
    ],
    inputs: [
      {
        key: 'watchTime',
        label: 'Check time',
        kind: 'cron',
        required: true,
        default: '0 2 * * *',
        help: "Cron expression in the server's local timezone. '0 2 * * *' is 02:00 nightly.",
      },
      {
        key: 'chatTarget',
        label: 'Deliver alerts to',
        kind: 'chatTarget',
        required: true,
        help: 'Paste a @BotFather token, message the bot it names, and pick the chat from what the server finds. Never typed in by hand — and you can also pick an existing bot’s chat if you already have one.',
      },
    ],
  },

  cronJobs: [
    {
      name: 'nightly-watch',
      schedule: '{{input.watchTime}}',
      prompt:
        'Run the full watchlist: for each target, scrape, diff against state/<target-id>.json, report only new or changed items with links and prices, then update the state file. If nothing changed anywhere, reply exactly: [SILENT] No changes.',
      missedRunPolicy: 'skip',
      deliverTo: 'channel',
    },
  ],

  starterPrompt:
    'Watch this page for me: <paste a URL>. Extract <what to look for> and alert me when a new item appears or a price changes. Save it to your watchlist.',
  examplePrompts: [
    'Watch these three used-part shops for a BMW E46 left headlight under $150: <url1> <url2> <url3>. Remember the part list and shops in your watchlist.',
    'Also watch https://github.com/anthropics/claude-code for new releases.',
    "What's currently in the watchlist, and when did each target last change?",
    'Show me the seen-state for the headlight search — what have you already reported?',
  ],

  notes: [
    'Anti-bot, honestly: Ethos runs stock headless Playwright Chromium — no stealth patches, no fingerprint spoofing, no proxy tier. Expect small independent shops, most job boards, classifieds without challenge walls, GitHub and APIs, dealer inventory and most WooCommerce/Shopify stores to work. Expect Cloudflare-challenge sites, Zillow/realtor.com, LinkedIn, Amazon at scrape frequency, and anything behind PerimeterX/DataDome to fail. The `blocked` rule keeps a failing target from spamming every run.',
    'For a static page, notify-only-on-diff is also available with zero tokens: a cron `precheck` script that hashes the target and skips the model turn, or the `http` / `rss` watchers (usecase 28). This recipe is the LLM-judged fallback for pages where the diff itself needs judgement — JS-rendered listings, fuzzy matching.',
    'Diff quality depends on stable item keys. Sites that randomise listing URLs will produce duplicate alerts.',
    'Browser pagination (`browser_scroll` / `browser_click`) costs far more tokens and time per run than `web_extract`. Keep each target tight — a specific search-results URL, not a whole site.',
    'Scraping third-party sites on a schedule may violate their terms of service. That is your call, per target.',
    'Playwright must be installed — run `npx playwright install chromium` — or the `browser_*` tools are unavailable and this recipe will not pass preflight.',
    'The gateway must be running at the scheduled time (laptop asleep = missed run; `missedRunPolicy: skip` skips it rather than replaying). Run it on an always-on box for a watch that actually watches.',
  ],

  postInstall: [
    {
      kind: 'restart',
      label: 'Restart the gateway',
      detail:
        'The bot is created and bound for you, but a running gateway does not pick up a brand-new bot mid-flight: run `ethos gateway start` (or restart it) so the alerts can actually be delivered.',
    },
  ],
};
