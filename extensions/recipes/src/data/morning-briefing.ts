// Morning briefing — authored from plan/usecases/01-morning-briefing.md.
//
// Hand-authored, not generated (§6): the usecase doc's config blocks are a
// SPEC, not a source. Two things had to change on the way in, and both are
// deliberate:
//
//  * The doc's toolset lists `fetch`. There is no registered `fetch` tool —
//    `fetch` is an MCP PRESET (`uvx mcp-server-fetch`,
//    extensions/tools-mcp/src/presets.ts). Keyless weather is read with
//    `web_extract`, which already fetches a URL and is already in the toolset.
//    The toolset-name test is exactly the check that caught this.
//  * The doc's first limitation ("the cron enable prompt must be sent via
//    Telegram") is retired by §1's `deliverTo` union: the job is created by the
//    installer with an explicit, server-validated channel target.

import type { RecipeBundle } from '../schema';

const SOUL = `I am Briefer. I prepare one tight morning digest — never a wall of text.
My sections, in this order: Weather (2 lines), Calendar (today's events, times first),
News (3-5 headlines with one-line why-it-matters), Todos (open items from memory).
Weather, News and Todos are always there. Calendar is there only when a calendar tool
is connected — when none is, I leave that section out entirely and say nothing about
it. A briefing is for what I can see, not a daily apology for what I cannot.
I read weather from open-meteo/wttr.in with web_extract, calendar from the Google
Calendar MCP when it is connected, news via web_search + web_extract limited to the
user's stated interests in USER.md.
I respect preferences stored in memory (city, units, news topics, quiet topics) and
update them when the user tells me. I keep the whole briefing under 3500 characters
so it lands as a single Telegram message. If a source fails, I say so in one line
and move on — a late briefing is worse than a partial one. When a scheduled run
produces nothing worth saying, I begin my reply with [SILENT].

My starting preferences, set when this recipe was installed — city: {{input.city}};
units: {{input.units}}; news topics: {{input.topics}}. Anything the user tells me later
wins over these: I store it with memory_write and read it back with memory_read.
`;

export const morningBriefing: RecipeBundle = {
  id: 'morning-briefing',
  version: 4,
  title: 'Morning briefing',
  summary:
    'A digest of weather, news and todos — plus your calendar if you connect one — in your chat before you wake up.',
  sourceDoc: 'plan/usecases/01-morning-briefing.md',
  tags: ['daily', 'needs-channel', 'optional-oauth'],

  personality: {
    id: 'briefer',
    name: 'Briefer',
    description:
      'Concise morning-briefing agent — assembles weather, news, todos, and (optionally) your calendar into one scannable digest.',
    soulMd: SOUL,
    provider: 'anthropic',
    model: { trivial: 'claude-haiku-4-5', default: 'claude-sonnet-4-6' },
    capabilities: ['research', 'web'],
    toolset: [
      'web_search',
      'web_extract',
      'memory_read',
      'memory_write',
      'session_search',
      'cron',
      'todo_add',
      'todo_list',
      'todo_update',
    ],
    mcpServers: ['google-calendar'],
    plugins: [],
  },

  requires: {
    mcpServers: [
      {
        name: 'google-calendar',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@cocal/google-calendar-mcp'],
        envKeys: ['GOOGLE_OAUTH_CREDENTIALS'],
        auth: 'oauth',
        optional: true,
        why: "Adds today's agenda via list-events / search-events. Without it the briefing is weather, news and todos.",
      },
    ],
    plugins: [],
    channels: [
      {
        platform: 'telegram',
        why: 'The briefing is delivered to a Telegram chat every morning.',
        deliversCron: true,
        // Set up on the recipe page, not in Communications. A Telegram bot
        // binds to a PERSONALITY, and `briefer` does not exist until this
        // recipe installs — so "bind a bot to this agent first" was a
        // requirement that could never be met. The install does it instead.
        inlineSetup: true,
      },
    ],
    tools: [
      'web_search',
      'web_extract',
      'memory_read',
      'memory_write',
      'session_search',
      'cron',
      'todo_add',
      'todo_list',
      'todo_update',
    ],
    // `web_search` needs a provider key, and nothing else in preflight can see
    // that: `isAvailable()` returns true unconditionally (the key may live in
    // Named Secrets, unreachable at filter time), so the tool installs fine and
    // fails at 6:20am with "No web search provider is configured". Which of Exa
    // / Tavily / Brave satisfies it is read off `web_search`'s own
    // `settingsSchema`, not repeated here.
    secrets: [
      {
        toolName: 'web_search',
        label: 'Web search API key',
        why: 'The News section searches the web; without a provider key the briefing has no headlines.',
      },
    ],
    inputs: [
      {
        key: 'city',
        label: 'Your city',
        kind: 'text',
        required: true,
        placeholder: 'Bengaluru',
        help: 'Used for the weather line, and stored as the starting preference in the SOUL.',
      },
      {
        key: 'units',
        label: 'Units',
        kind: 'choice',
        required: true,
        options: ['metric', 'imperial'],
        default: 'metric',
        help: 'Temperature and wind units.',
      },
      {
        key: 'topics',
        label: 'News topics',
        kind: 'text',
        required: true,
        placeholder: 'AI infra, Indian startups, F1',
        help: 'Comma-separated. The briefing limits its headlines to these.',
      },
      {
        key: 'briefingTime',
        label: 'Briefing time',
        kind: 'cron',
        required: true,
        default: '20 6 * * *',
        help: "Cron expression, evaluated in the server's local timezone. '20 6 * * *' is 06:20.",
      },
      {
        key: 'chatTarget',
        label: 'Deliver to',
        kind: 'chatTarget',
        required: true,
        help: 'Paste a @BotFather token, message the bot it names, and pick the chat from what the server finds. Never typed in by hand — and you can also pick an existing bot’s chat if you already have one.',
      },
    ],
  },

  cronJobs: [
    {
      name: 'morning briefing',
      schedule: '{{input.briefingTime}}',
      prompt:
        "Assemble my morning briefing — today's weather for my saved city, 5 news headlines for my saved topics with one-line summaries, and my open todos from memory. If a calendar tool is connected, add today's events after the weather; if none is, leave the calendar section out without remarking on it. Keep it under 3500 characters.",
      missedRunPolicy: 'skip',
      deliverTo: 'channel',
    },
  ],

  starterPrompt: 'Give me my briefing for today.',
  examplePrompts: [
    "I'm in Bengaluru, metric units. News topics: AI infra, Indian startups, F1. Remember that.",
    'Give me my briefing for today.',
    "Add 'renew passport' to my todos.",
  ],

  notes: [
    'Setting up the Telegram bot happens here, on this page: create a bot with @BotFather, paste its token, message the bot once, and pick the chat the server finds. The bot is bound to Briefer by the install — Communications cannot do it beforehand, because Briefer does not exist yet.',
    "Delivery goes to the one chat you pick at install time. Changing it later means editing the job's delivery target, not the prompt.",
    "Timezone: schedules are evaluated by `croner` in the gateway server's local timezone (no per-job tz option in `extensions/cron/src/schedule.ts`). `20 6 * * *` means 06:20 server time.",
    'The gateway must be running at the scheduled hour (laptop asleep = missed run; the default `missedRunPolicy: skip` skips runs missed by more than one tick). Run the gateway on an always-on box for a true before-you-wake briefing.',
    'Google Calendar is OPTIONAL. Install without it and the briefing is weather, news and todos — nothing else changes and no setup is needed. Add it later with `ethos mcp add google-calendar --env GOOGLE_OAUTH_CREDENTIALS=<path-to-oauth-client.json> --command npx --args -y @cocal/google-calendar-mcp`; it cannot be added from the web UI, because stdio MCP servers run an arbitrary local command and are deliberately CLI-only.',
    'Google Calendar MCP OAuth is a one-time interactive browser flow needing a Google Cloud OAuth client; the community server is well-maintained but not Google-official.',
    "Network reach: this agent is installed with `safety.network.allow: '*'` — the open public internet, which is what a briefing that reads weather and news needs. Cloud-metadata endpoints and private/RFC1918 addresses stay blocked regardless, and only http/https are allowed. Narrow it later in the agent's config.yaml if you want it reading fewer hosts.",
    'News quality depends on your `web_search` provider config; paywalled sources reduce `web_extract` fidelity. Cost: one Sonnet-class multi-tool turn per day is cheap; Haiku-class models tend to produce flabbier digests.',
    'Output starting with [SILENT] is persisted and audited but not delivered — useful for "nothing new" days.',
  ],

  postInstall: [
    {
      kind: 'manual',
      label: 'Optional — add Google Calendar for the calendar section',
      detail:
        'Skip this and the briefing still runs: weather, news and todos, with no calendar section. To add it, run `ethos mcp add google-calendar --env GOOGLE_OAUTH_CREDENTIALS=<path-to-oauth-client.json> --command npx --args -y @cocal/google-calendar-mcp` in a terminal (stdio servers cannot be added from the web UI), then authorise it once in the browser and tick the list/search events tools.',
    },
    {
      kind: 'restart',
      label: 'Restart the gateway',
      detail:
        'The bot is created and bound for you, but a running gateway does not pick up a brand-new bot mid-flight: run `ethos gateway start` (or restart it) so the briefing can actually be delivered.',
    },
  ],
};
