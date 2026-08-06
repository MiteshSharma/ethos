---
title: "Model Catalog"
description: "Remote model catalog — how the CLI discovers available models without upgrading."
kind: reference
audience: developer
slug: model-catalog
updated: 2026-05-17
---

# Model Catalog

Ethos ships a **remote model catalog** so new models become available without upgrading the CLI. The catalog is a static JSON file published alongside the documentation site.

## Published URL {#published-url}

```
https://ethos-agent.ai/api/model-catalog.json
```

## JSON Schema {#json-schema}

```typescript
interface ModelCatalogManifest {
  version: number;          // Always 1
  updatedAt: string;        // ISO-8601 timestamp
  providers: {
    [providerId: string]: {
      models: Array<{
        id: string;         // Model identifier (e.g. "claude-sonnet-4-6")
        label: string;      // Display label for the picker
        contextWindow: number; // Max context in tokens
        default?: boolean;  // Default model for this provider
      }>;
    };
  };
}
```

The catalog ships exactly three provider keys: `anthropic`, `openai-compat`, `azure`.

## Three-level Fallback {#three-level-fallback}

The CLI resolves models in order:

1. **Remote** — fetches the published URL (8s timeout)
2. **Cache** — `~/.ethos/cache/model-catalog.json` (24h TTL by default)
3. **Bundled** — the snapshot compiled into the CLI binary

A fresh install with no internet still works (bundled fallback). Network failures are silent — one log line at `warn` level.

## Configuration {#configuration}

In `~/.ethos/config.yaml`:

```yaml
modelCatalog.enabled: true
modelCatalog.url: https://ethos-agent.ai/api/model-catalog.json
modelCatalog.ttlHours: 24
modelCatalog.providers.anthropic.url: https://internal.example.com/anthropic.json
```

| Key | Default | Description |
|-----|---------|-------------|
| `modelCatalog.enabled` | `true` | Set to `false` to disable remote fetch entirely |
| `modelCatalog.url` | Official URL | Override the catalog URL |
| `modelCatalog.ttlHours` | `24` | Cache time-to-live in hours |
| `modelCatalog.providers.<id>.url` | — | Per-provider URL override |

## Adding a New Model {#adding-a-new-model}

1. Edit `packages/wiring/src/model-catalog.ts` — add the entry to `MODEL_CATALOG`
2. Open a PR to `main`
3. On merge, CI runs `pnpm build:model-catalog`, Docusaurus deploys, and the JSON is live
4. Existing CLIs pick it up within 24 hours (or on next cache expiry)

## Private Catalog for Operators {#private-catalog-for-operators}

Organizations can host their own catalog JSON at an internal URL:

```yaml
modelCatalog.url: https://internal.corp.example.com/model-catalog.json
```

The JSON must conform to the same schema. Per-provider overrides let you mix sources:

```yaml
modelCatalog.providers.anthropic.url: https://internal.corp.example.com/anthropic-only.json
```

## Cache Location {#cache-location}

`~/.ethos/cache/model-catalog.json` — managed via the Storage abstraction. Delete it to force a re-fetch on next CLI start.

## Source {#source}

- [`packages/wiring/src/model-catalog.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/model-catalog.ts) — the in-memory `MODEL_CATALOG` const that ships bundled with the CLI.
- [`packages/wiring/scripts/build-model-catalog.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/scripts/build-model-catalog.ts) — build script that emits the published JSON from that const.
