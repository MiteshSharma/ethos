# Personality examples

Directory-based personality bundles — drop the subdirectory into `~/.ethos/personalities/<id>/` and restart `ethos chat`. Each example is a complete personality with `ETHOS.md` (identity), `config.yaml` (model, memory scope), and `toolset.yaml` (allowed tools).

Works alongside the five built-in personalities (`researcher`, `engineer`, `reviewer`, `coach`, `operator`) — user-defined personalities take precedence over built-ins with the same `id`.

| Example | What it's good for | Memory scope |
|---|---|---|
| [`tutor/`](./tutor/) | Learning new topics, Socratic teaching, explaining things in small steps | `per-personality` |

## How to use one

```bash
cp -r examples/personalities/tutor ~/.ethos/personalities/tutor
ethos chat
# inside chat:
/personality tutor
```

Hot-reload picks the directory up on the next turn — no restart required after the first load.

## How to fork one as a template

```bash
cp -r examples/personalities/tutor ~/.ethos/personalities/my-tutor
# Edit ETHOS.md to change the identity
# Edit toolset.yaml to add or remove tools
# Edit config.yaml to change the model or memory scope
```

## Picking a memory scope

- **`global`** (default) — the personality reads/writes `~/.ethos/MEMORY.md`, shared across all personalities. Use when continuity matters: a researcher and a coach working on the same project benefit from shared context.
- **`per-personality`** — the personality reads/writes its own isolated file at `~/.ethos/personalities/<id>/MEMORY.md`. Use when isolation matters: a reviewer should not absorb the opinions it reviews; a tutor's memory of one learner should not bleed into another.

See [What is a Personality?](https://ethosagent.ai/docs/personality/what-is-a-personality) for the full background.
