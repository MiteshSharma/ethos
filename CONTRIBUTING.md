# Contributing to Ethos

This is an opinionated codebase. Read [CLAUDE.md](./CLAUDE.md) before opening
a PR — the behavioral guidelines at the top apply to humans too.

## Setting up

```bash
make prepare        # pnpm install
pnpm dev            # interactive chat
pnpm check          # typecheck + lint + test (run before pushing)
```

## PR conventions

- Keep changes surgical. One PR, one concern. Don't refactor adjacent code.
- Run `pnpm typecheck && pnpm lint && pnpm test` locally before pushing.

## Frozen schemas

A few interfaces are frozen — adding a field requires special review.

### `PersonalityConfig`

Defined in `packages/types/src/personality.ts`. Any PR adding a top-level field requires:

1. The `personality-schema-change` label.
2. Two-maintainer approval (enforced via branch protection on `main`).
3. A bump of `.personality-field-count` at the repo root in the same
   commit. The mechanical CI gate
   (`packages/types/src/__tests__/personality-field-count.test.ts`) fails
   if the file count drifts from the schema.
4. A `CHANGELOG.md` entry justifying why the field isn't a skill, a tool, or a memory section.

The schema is intentionally narrow. Voice modes, emotion tags, mood files, and label or response templates are NOT personality concerns — they belong in skills or per-channel adapter config.

### Plugin contract

Defined in `packages/plugin-contract/src/`. Any breaking change (field
rename, field removal, required-field addition) requires:

1. Bumping `PLUGIN_CONTRACT_MAJOR` in `packages/plugin-contract/src/version.ts`.
2. Adding a migration entry to `packages/plugin-contract/MIGRATIONS.md`.

### Config surface doc-sync

Every user-facing field on `EthosConfig` (`apps/ethos/src/config.ts`) and
`PersonalityConfig` (`packages/types/src/personality.ts`) must be documented
in the corresponding doc page — `docs/content/cli-reference.md` for
`EthosConfig`, anything under `docs/content/personality/` for
`PersonalityConfig`. The CI gate
(`apps/ethos/src/__tests__/config-doc-sync.test.ts`) parses both schemas and
fails on missing or under-described fields. Bare substring match doesn't
count: the field must appear either as a markdown table row with a
populated description column, OR in a YAML/code block with a same-line
comment, section header within 3 lines, or descriptive sentence within 5
lines.

Internal/derived fields (populated by the loader, not user-set — `id`,
`ethosFile`, `skillsDirs`, `metadata` on `PersonalityConfig`) are tagged
`@internal` in source and skipped by the test. If you add a new field that
genuinely shouldn't surface in docs, add `@internal` in the same PR.


## Style

Match the existing style. The repo uses Biome (single quotes, 2-space
indent, 100-char line width). `pnpm lint:fix` auto-formats.

Extensionless TypeScript imports — `import { X } from './foo'` (no `.js`). This is the one hard rule; tsx handles resolution in dev.
