---
sidebar_position: 8
title: Image generation
description: "image_generate tool reference — text-to-image via DALL-E 3 or Replicate Flux with cost tracking and automatic provider selection."
kind: reference
audience: developer
slug: image-tools
updated: 2026-05-13
---

# Image generation {#image-generation}

The `image_generate` [tool](../../getting-started/glossary.md#tool) generates PNG images from text prompts using cloud providers (OpenAI DALL-E 3, Replicate Flux). It writes the image to disk via `Storage.writeAtomic`, reports cost on `ToolResult.cost_usd`, and surfaces the provider's revised prompt when applicable.

## Source {#source}

[`extensions/tools-image/src/index.ts`](https://github.com/ethosagent/ethos/tree/main/extensions/tools-image/src/index.ts). Factory: `createImageTools(): Tool[]`.

## Tool surface {#tool-surface}

| Field | Value |
|---|---|
| **Name** | `image_generate` |
| **Toolset** | `image` |
| **maxResultChars** | 1 000 |

### Parameters {#parameters}

| Param | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | `string` | yes | — | Text description of the image to generate. |
| `output_path` | `string` | no | `~/.ethos/generated/<timestamp>.png` | File path to save the PNG. |
| `size` | `string` | no | `1024x1024` | One of `512x512` (Flux only), `1024x1024`, `1024x1792`, `1792x1024`. |
| `quality` | `string` | no | `standard` | `standard` or `hd`. |
| `provider` | `string` | no | `auto` | `openai-dalle`, `replicate-flux`, or `auto`. |

### Return shape {#return-shape}

On success, `ToolResult.value` is a JSON string:

```json
{
  "path": "/home/user/.ethos/generated/1715600000000.png",
  "dimensions": { "width": 1024, "height": 1024 },
  "cost_usd": 0.04,
  "provider": "openai-dalle",
  "prompt_used": "A photorealistic cat sitting on a windowsill..."
}
```

`ToolResult.cost_usd` is set at the top level so `AgentLoop` aggregates it into session spend.

`prompt_used` returns the provider's revised prompt (DALL-E 3 rewrites prompts for quality). For Replicate Flux, `prompt_used` echoes the input prompt unchanged.

## Provider matrix {#provider-matrix}

| Provider | Env var | Model | Supported sizes | Quality | Cost model |
|---|---|---|---|---|---|
| `openai-dalle` | `OPENAI_API_KEY` | DALL-E 3 | 1024x1024, 1024x1792, 1792x1024 | standard, hd | Per-size/quality table below |
| `replicate-flux` | `REPLICATE_API_TOKEN` | Flux Schnell | All sizes (including 512x512) | quality param ignored | $0.003 flat per image |

### DALL-E 3 pricing {#dalle-pricing}

| Size | Standard | HD |
|---|---|---|
| 1024x1024 | $0.04 | $0.08 |
| 1024x1792 | $0.08 | $0.12 |
| 1792x1024 | $0.08 | $0.12 |

### Auto-pick logic {#auto-pick}

When `provider` is `auto` (default) or omitted, the tool selects the first available provider in order: `openai-dalle`, then `replicate-flux`. A provider is available when its env var is set. If neither key is set, the tool returns `IMAGE_GEN_NO_PROVIDER`.

## Error codes {#error-codes}

| Code | ToolResult.code | Meaning |
|---|---|---|
| `IMAGE_GEN_NO_PROVIDER` | `not_available` | Neither `OPENAI_API_KEY` nor `REPLICATE_API_TOKEN` is set. |
| `INVALID_SIZE_FOR_PROVIDER` | `input_invalid` | The chosen provider does not support the size/quality combination. |
| `IMAGE_GEN_REJECTED` | `execution_failed` | Provider refused the prompt (content policy or safety filter). |
| `IMAGE_GEN_QUOTA_EXCEEDED` | `execution_failed` | Rate limit or quota exceeded (HTTP 429 or equivalent). |
| `IMAGE_GEN_PROVIDER_UNAVAILABLE` | `execution_failed` | Provider returned a server error or timed out. |
| `OUTPUT_PATH_DENIED` | `execution_failed` | Output path is outside the [personality](../../getting-started/glossary.md#personality)'s `fs_reach` allowlist. |

## Examples {#examples}

### Basic generation {#example-basic}

```ts
// In a personality's toolset.yaml, include:
// - image_generate

// The agent calls:
image_generate({ prompt: 'A watercolor painting of a mountain lake at dawn' })
// → { path: '~/.ethos/generated/1715600000000.png', dimensions: { width: 1024, height: 1024 },
//    cost_usd: 0.04, provider: 'openai-dalle', prompt_used: 'A serene watercolor...' }
```

### HD portrait with explicit provider {#example-hd}

```ts
image_generate({
  prompt: 'Professional headshot, studio lighting, neutral background',
  size: '1024x1792',
  quality: 'hd',
  provider: 'openai-dalle',
  output_path: '/tmp/headshot.png',
})
// → { path: '/tmp/headshot.png', dimensions: { width: 1024, height: 1792 },
//    cost_usd: 0.12, provider: 'openai-dalle', prompt_used: '...' }
```

## Known limitations {#known-limitations}

- **No editing, inpainting, or variations.** Generation from text prompt only.
- **No local Stable Diffusion.** Cloud providers (OpenAI, Replicate) only.
- **No auto-retry on policy rejection.** A rejected prompt fails; the agent must rephrase.
- **PNG only.** Output is always PNG regardless of the `output_path` extension.
- **Replicate polling.** Flux uses HTTP polling with a 120 s timeout.

## See also {#see-also}

- [Tool interface](./tool-interface.md) -- `Tool`, `ToolResult`, and `ToolContext` contracts.
- [Tool registry](./tool-registry.md) -- `executeParallel` and toolset gating.
- [Tool-result budget](../explanation/tool-result-budget.md) -- how `maxResultChars` interacts with the turn budget.
