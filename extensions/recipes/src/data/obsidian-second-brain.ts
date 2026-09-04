// Obsidian second brain — authored from plan/usecases/08-obsidian-second-brain.md.
//
// Hand-authored, not generated (§6): the usecase doc's config blocks are a
// SPEC, not a source. This recipe is offered in BOTH modes, and the things
// that are deliberate about it:
//
//  * CREATE makes the doc's "Archivist": the vault folder becomes its
//    `fs_reach.workdir` (a declared workdir is always reachable read+write, so
//    the vault is not repeated in the lists), and it is installed OFFLINE —
//    `safety.network.allow: []` overrides the D15 default on purpose, because
//    every tool it holds is local and an agent with the run of your vault
//    should not also have the run of the internet. The `${self}` and skills
//    entries are kept because an explicit `fs_reach` REPLACES the defaults.
//  * ATTACH lands on a personality you already have. Its name, model and
//    network policy stay exactly as they are; the recipe adds the file tools,
//    the vault to its reach, and a marked section to its SOUL.md. Several
//    personalities can share one vault: each writes its own
//    `## Distilled by <name>` section.
//  * One set of operating rules feeds both: the create SOUL is a first-person
//    identity line plus VAULT_RULES, the attach section is a heading plus the
//    same VAULT_RULES — composed here so the two never drift.
//  * `session_search` / `session_list_by_date` from the doc are DROPPED.
//    `session_search` only reaches the current session and
//    `session_list_by_date` returns metadata, so a scheduled run could not read
//    the day's conversations through them. The honest cross-session bridge is
//    the personality's own MEMORY.md / USER.md, filled by per-turn memory
//    capture: the nightly job reads those with `memory_read` and files what it
//    finds.

import type { RecipeBothBundle } from '../schema';

const VAULT_RULES = `Your vault at {{input.vaultPath}} is a source of truth you keep dense and current.

When working with the vault:
- Follow its conventions: daily notes under Journal/YYYY-MM-DD.md unless the vault shows
  you another convention, [[wikilinks]], YAML frontmatter with tags. Read an existing note
  before inventing a format.
- When answering a question, search_files the vault first, cite the note paths you drew
  from, and say so when the vault is silent.
- Appends over rewrites: patch_file to add sections. Never clobber a note you haven't
  just read.
- Nightly distillation: distil decisions, new ideas and open todos into durable notes and
  link them from the daily note under a '## Distilled by <your name>' heading — your own
  name, so several personalities sharing one vault never write over each other.
- Keep a short changelog of every note you touched at the bottom of the daily note.
- When a scheduled run finds nothing worth filing, begin your reply with [SILENT].
- Prune nothing without asking — when a note looks stale, use clarify rather than deleting.
`;

const SOUL = `I am Archivist. Your Obsidian vault is the source of truth; my job is to keep it dense
and current.

${VAULT_RULES}`;

const SOUL_SECTION = `## Your Obsidian vault

${VAULT_RULES}`;

const TOOLS = [
  'read_file',
  'write_file',
  'patch_file',
  'search_files',
  'memory_read',
  'memory_write',
  'cron',
  'clarify',
];

export const obsidianSecondBrain: RecipeBothBundle = {
  id: 'obsidian-second-brain',
  version: 1,
  title: 'Obsidian second brain',
  summary:
    'Your Obsidian vault as an agent’s memory — a new Archivist rooted in it, or a personality you already have given the vault: it answers from your notes, files what you give it in your format, and distils what it learned each day into linked notes every night.',
  sourceDoc: 'plan/usecases/08-obsidian-second-brain.md',
  tags: ['daily', 'no-credentials', 'local-files', 'attach'],

  personality: {
    mode: 'both',
    id: 'obsidian-archivist',
    name: 'Archivist',
    description:
      'Second-brain librarian who reads, writes and nightly-consolidates your Obsidian vault.',
    soulMd: SOUL,
    provider: 'anthropic',
    model: { trivial: 'claude-haiku-4-5', default: 'claude-sonnet-4-6' },
    capabilities: ['notes', 'memory', 'writing'],
    toolset: TOOLS,
    plugins: [],
    fsReach: {
      read: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
        '${ETHOS_HOME}/personalities/${self}/',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
        '${ETHOS_HOME}/skills/',
      ],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
      write: ['${ETHOS_HOME}/personalities/${self}/'],
      // The vault IS the working directory — reachable read+write by declaration.
      workdir: '{{input.vaultPath}}',
    },
    // Offline on purpose — see the header. Overrides the D15 default. Applies
    // to the CREATED personality only; an attach never touches the target's.
    safety: { network: { allow: [] } },
    attach: {
      soulSection: SOUL_SECTION,
      toolset: TOOLS,
      plugins: [],
      fsReach: {
        read: ['{{input.vaultPath}}'],
        write: ['{{input.vaultPath}}'],
      },
    },
  },

  requires: {
    mcpServers: [],
    plugins: [],
    channels: [],
    tools: TOOLS,
    inputs: [
      {
        key: 'vaultPath',
        label: 'Vault folder',
        kind: 'path',
        required: true,
        placeholder: '/Users/you/Documents/ObsidianVault/',
        help: 'Absolute path to the vault root, with a trailing slash. In create mode this becomes Archivist\'s work directory. In attach mode it prefills from the chosen personality\'s work directory when one is set. Reach is a prefix match on this path, so "/Users/you/Vault" would also match "/Users/you/VaultOther" without the slash. ~ is not expanded.',
      },
      {
        key: 'consolidationTime',
        label: 'Nightly consolidation time',
        kind: 'cron',
        required: true,
        default: '30 23 * * *',
        help: "Cron expression in the server's local timezone. '30 23 * * *' is 23:30. If several personalities share one vault, stagger their times so two runs never edit the same daily note at once.",
      },
    ],
  },

  cronJobs: [
    {
      name: 'vault-consolidation',
      schedule: '{{input.consolidationTime}}',
      prompt:
        "Read MEMORY.md and USER.md with memory_read. Distil today's new decisions, ideas and open todos into the right notes in the vault: create Journal/YYYY-MM-DD.md for today if it is missing, append a '## Distilled by <your name>' section with wikilinks to the notes you touched or created, and finish with a one-paragraph summary of what you filed. If there is nothing worth filing, reply [SILENT].",
      missedRunPolicy: 'skip',
      deliverTo: 'inApp',
    },
  ],

  starterPrompt:
    "Read my vault's conventions — where daily notes live, how links and frontmatter are written — and tell me how you'll file things before you write anything.",
  examplePrompts: [
    "What did I decide about the pricing model? Check my vault — I think it's in a note linked from last week's daily notes.",
    "Summarize today's meeting from this transcript and file it as Meetings/2026-07-17 growth-sync.md with wikilinks to the attendees' people notes.",
    "Which notes mention 'vector memory' but aren't linked from the Memory MOC? List them so I can wire them in.",
  ],

  notes: [
    'Create mode makes a new personality, Archivist, with the vault folder as its work directory — its relative file paths land in the vault, and the Documents tab browses it. Archivist is installed with NO network access (`safety.network.allow: []`): every tool it has is local, so there is nothing for it to fetch. Widen it later in its config.yaml if you add a web tool.',
    "Attach mode lands on a personality you choose. It keeps its name, model and network policy, and gains the file tools, the vault in its filesystem reach, and a marked '## Your Obsidian vault' section in its SOUL.md. Installing again adds nothing twice.",
    "Several personalities can share one vault: attach the recipe to each (or create Archivist and attach to the others). Every one writes its own '## Distilled by <name>' section in the shared daily note, so give them staggered consolidation times.",
    "What gets distilled is what the personality itself remembered — its MEMORY.md and USER.md, filled by per-turn memory capture. Other personalities' conversations are NOT read unless the recipe is attached to them too.",
    'Reach is the whole vault subtree — there is no per-glob exclusion. Keep private material outside the vault root, or point the recipe at a narrower subfolder instead of the whole vault.',
    'No vault index is injected into the prompt: on a large vault every lookup is a `search_files` round-trip, which costs a tool call per question.',
    'If Obsidian edits a note while the agent is working, the stale-write guard makes it re-read before writing. Expect an occasional retry, never a clobbered note. Obsidian Sync / iCloud conflicts are yours to manage.',
    'Consolidation quality depends on the model following your vault conventions. Sonnet-class is fine for distillation; review the changelog at the bottom of each daily note for the first week.',
    "Optional deeper integration: set `memory: vault` plus `memoryVault.path: <your vault>` in ~/.ethos/config.yaml to root the agent's own MEMORY.md / USER.md inside the vault (prefetched into the prompt, consolidated by the nightly pass). If you do, don't also point fs_reach.write at that agentDir — two writers on one subtree is safe but noisy.",
    'The gateway or `ethos serve` must be running at the scheduled time. A missed run is skipped (`missedRunPolicy: skip`), not replayed — the next night covers two days.',
  ],

  postInstall: [],
};
