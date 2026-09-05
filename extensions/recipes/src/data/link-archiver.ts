// Link archiver — authored from plan/usecases/02-link-archiver.md.
//
// Hand-authored, not generated (§6): the usecase doc's config blocks are a
// SPEC, not a source. Four things changed on the way in, all deliberate:
//
//  * The doc's toolset lists `fetch`. There is no registered `fetch` tool —
//    `fetch` is an MCP PRESET (`uvx mcp-server-fetch`,
//    extensions/tools-mcp/src/presets.ts), the same finding morning-briefing
//    made. Dropped; `web_extract` is the fetcher.
//  * `web_search` is dropped so the recipe installs with no API key at all.
//    `web_extract` fetches the forwarded URL, and the SOUL's `unread` fallback
//    covers the pages that will not fetch. Enrichment of bare links was the
//    only thing search bought, and it is not worth a credential gate.
//  * `send_message` is dropped. The weekly digest is delivered by the cron job
//    itself (`deliverTo`), so the doc's step 6 — a CLI-only messaging allowlist
//    edit — is retired along with the tool that needed it.
//  * The Telegram bot for forwarding links from a phone is OPTIONAL and is a
//    post-install step, not a requirement: the recipe works immediately in web
//    chat, and the bot is added later in Communications.

import type { RecipeCreateBundle } from '../schema';

const SOUL = `I am Archiver, a personal librarian. When I receive a link, I fetch it with web_extract,
write a 3-5 sentence summary, assign 2-4 lowercase tags, and file it — no chit-chat, just a
one-line confirmation with the tags I chose.

Filing rules:
- Each capture becomes archive/YYYY/MM/<slug>.md with frontmatter: url, title, date, tags,
  source.
- After every capture I append one line to archive/INDEX.md
  (\`- YYYY-MM-DD [title](path) #tag1 #tag2\`) and mirror the same line into memory with
  memory_write, so recall works even without file search.
- If a page won't fetch (paywall, anti-bot), I archive the URL plus whatever the user
  pasted, tag it \`unread\`, and say so honestly.

Recall rules: when asked "what did I send you about X?", I search the index in memory
first, then search_files over the archive, then session_search — and I answer with links,
never vibes.

Weekly digest: I read archive/INDEX.md, take every entry from the last 7 days, group by
tag, and write a short digest — title, one-line summary and link for each. If nothing was
archived that week, I say so in one line.
`;

export const linkArchiver: RecipeCreateBundle = {
  id: 'link-archiver',
  version: 1,
  title: 'Link archiver',
  summary:
    'Paste or forward any link; it is fetched, summarised, tagged and filed into a markdown archive you can ask about months later, with a weekly digest.',
  sourceDoc: 'plan/usecases/02-link-archiver.md',
  tags: ['daily', 'no-credentials'],

  personality: {
    mode: 'create',
    id: 'archiver',
    name: 'Archiver',
    description:
      'Personal link curator — captures, summarises, tags and recalls anything you forward.',
    soulMd: SOUL,
    provider: 'anthropic',
    model: { trivial: 'claude-haiku-4-5', default: 'claude-sonnet-4-6' },
    capabilities: ['research', 'web'],
    toolset: [
      'web_extract',
      'write_file',
      'read_file',
      'search_files',
      'memory_read',
      'memory_write',
      'session_search',
      'cron',
    ],
    plugins: [],
    // Explicit, so the default CWD write grant is dropped: the archive lives
    // under the personality's own directory and nowhere else.
    fsReach: {
      read: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
        '${ETHOS_HOME}/personalities/${self}/',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
        '${ETHOS_HOME}/skills/',
      ],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
      write: ['${ETHOS_HOME}/personalities/${self}/'],
    },
  },

  requires: {
    mcpServers: [],
    plugins: [],
    channels: [],
    tools: [
      'web_extract',
      'write_file',
      'read_file',
      'search_files',
      'memory_read',
      'memory_write',
      'session_search',
      'cron',
    ],
    inputs: [
      {
        key: 'digestTime',
        label: 'Weekly digest time',
        kind: 'cron',
        required: true,
        default: '0 9 * * 0',
        help: "Cron expression in the server's local timezone. '0 9 * * 0' is Sunday 09:00.",
      },
    ],
  },

  cronJobs: [
    {
      name: 'weekly-digest',
      schedule: '{{input.digestTime}}',
      prompt:
        'Read archive/INDEX.md, take every entry from the last 7 days, group by tag, and write a short digest (title + one-line summary + link each). If nothing was archived, say so in one line.',
      missedRunPolicy: 'run-once',
      deliverTo: 'inApp',
    },
  ],

  starterPrompt:
    'Initialize your archive: create archive/INDEX.md with a "# Index" heading, then tell me you are ready for links.',
  examplePrompts: [
    'https://arstechnica.com/some-article — save this',
    'archive this, tag it homelab: https://github.com/example/repo',
    'what did I send you about vector databases a couple of months ago?',
    'list everything tagged #health from June',
  ],

  notes: [
    'Anti-bot and paywalled pages (Twitter/X, Medium, most news sites) defeat `web_extract`. The `unread` fallback keeps the capture — URL plus whatever you pasted — but not the content.',
    'The dual index (archive/INDEX.md plus one line per capture in MEMORY.md) is deliberate redundancy: memory gives cheap always-in-prompt recall, `search_files` gives exhaustive recall. MEMORY.md grows with every link; eventually ask Archiver to prune index lines older than about six months (they stay findable via `search_files`).',
    'The weekly digest lands in the web notifications feed. To forward links from your phone — and receive the digest there — bind a Telegram bot to Archiver in Communications after install.',
    '`missedRunPolicy: run-once` covers restarts: a digest missed while the gateway was down runs once when it comes back, rather than being skipped.',
    'Cost is modest: one summarisation turn per link on a Sonnet-class model. Recall is grep and FTS before any model synthesis.',
  ],

  postInstall: [
    {
      kind: 'manual',
      label: 'Optional — forward links from your phone',
      detail:
        'Bind a Telegram bot to Archiver in Communications (paste a @BotFather token), then restart the gateway so it picks up the new bot. Until then, paste links into the web chat.',
      href: '/communications',
    },
  ],
};
