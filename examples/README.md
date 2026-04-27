# Examples

Working examples for everything you can build with Ethos. Each subdirectory is a category — copy the closest one, adapt, ship.

| Directory | What lives here |
|---|---|
| [`plugins/`](./plugins/) | npm-publishable plugin packages (tools, hooks, injectors). Five worked examples covering the main extension surfaces. |
| [`personalities/`](./personalities/) | Directory-based personality bundles you drop into `~/.ethos/personalities/<id>/`. Ready to use as-is or fork as templates. |
| [`skills/`](./skills/) | Skill files in the format that `ethos skills install` and the OpenClaw-compat layer consume. |

---

## How to use these

**To use one as-is:**

- **A plugin:** add the directory path to your `~/.ethos/config.yaml` `plugins:` list, then list its tool names in your active personality's `toolset.yaml`.
- **A personality:** copy the whole subdirectory (e.g., `tutor/`) into `~/.ethos/personalities/`. Restart `ethos chat`. Switch with `/personality tutor`.
- **A skill:** copy the `.md` file into `~/.ethos/skills/`, or run `ethos skills install <slug>` if it's published.

**To use one as a template:**

Fork the directory, change the `name`/`id` fields, and tailor it to your needs. The examples are intentionally small and free of cleverness — they're starter material, not production-grade.

---

## What's missing? Contribute one.

The point of `examples/` is breadth. If you built something and the closest example didn't help, that's signal to add yours. Suggested categories that aren't filled out yet:

- **`recipes/`** — multi-component setups (e.g., "research agent on Telegram with cron summaries"). A whole `~/.ethos/` skeleton you can drop in.
- **`tools/`** — single-file tool examples that don't warrant a full plugin package.
- **`adapters/`** — custom `PlatformAdapter` implementations beyond the bundled five.
- **`memory-providers/`** — custom `MemoryProvider` implementations (vector store, Redis, S3, etc.).

If you start one of these, drop a subdirectory README explaining what each example demonstrates, and add a row to the table above.

---

## Development

The plugin examples in `plugins/` are pnpm workspace packages — running `pnpm install` from the repo root links them together. Each one builds independently with `pnpm --filter <package-name> build`. They are listed in `pnpm-workspace.yaml` under `examples/plugins/*`.

Personality and skill examples are static files — no build step.
