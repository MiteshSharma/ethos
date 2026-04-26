# Ethos

**The TypeScript AI agent framework where personality is architecture.**

Each personality is a structural component, not a prompt: a curated toolset, a first-person identity, and a memory scope. Specialists ship by default — researcher, engineer, reviewer, coach, operator. Bring your own.

## Install

### One-liner (recommended)

```bash
curl -fsSL https://ethosagent.ai/install.sh | bash
```

Detects platform, installs Node 24 if missing, then runs `npm install -g @ethosagent/cli`. macOS and Linux only.

### npm

```bash
npm install -g @ethosagent/cli
```

Requires Node 24+.

### From source

```bash
git clone https://github.com/ethosagent/ethos.git
cd ethos
pnpm install
pnpm dev    # tsx apps/ethos/src/index.ts
```

## Quick start

```bash
ethos setup    # one-time wizard: pick provider + key + personality
ethos chat     # start the REPL
ethos cron list
ethos personality list
```

See [ethosagent.ai](https://ethosagent.ai) for full docs, tutorials, and the plugin SDK.

## What's in this package

This is the `ethos` CLI binary. The other public packages plugin authors use:

- [`@ethosagent/types`](https://www.npmjs.com/package/@ethosagent/types) — interface contracts (zero deps)
- [`@ethosagent/core`](https://www.npmjs.com/package/@ethosagent/core) — `AgentLoop`, registries, defaults
- [`@ethosagent/plugin-sdk`](https://www.npmjs.com/package/@ethosagent/plugin-sdk) — tool, hook, memory, and adapter helpers + testing utilities
- [`@ethosagent/plugin-contract`](https://www.npmjs.com/package/@ethosagent/plugin-contract) — marketplace validation schema

## License

MIT — see [LICENSE](./LICENSE).
