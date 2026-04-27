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


## Style

Match the existing style. The repo uses Biome (single quotes, 2-space
indent, 100-char line width). `pnpm lint:fix` auto-formats.

Extensionless TypeScript imports — `import { X } from './foo'` (no `.js`). This is the one hard rule; tsx handles resolution in dev.
