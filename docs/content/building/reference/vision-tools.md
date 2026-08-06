---
sidebar_position: 8
title: Vision
description: One-shot image and PDF question-answering via vision_analyze. Capability table, model fallback chain, and the auxiliary.vision.* config block.
kind: reference
audience: developer
slug: vision-tools
updated: 2026-05-13
---

# Vision — `vision_analyze`

`vision_analyze` is a single-shot [tool](../../getting-started/glossary.md#tool) that answers a prompt about one image (PNG / JPEG / GIF / WEBP) or one PDF. The active [personality](../../getting-started/glossary.md#personality)'s LLM — or a separately configured auxiliary vision model — returns the text answer plus token usage and dollar cost.

It is intentionally **not** a streaming chat surface. Each call returns one envelope. Multi-turn vision conversations layer on top by repeating calls.

## Source {#source}

The tool factory lives in [`extensions/tools-vision/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-vision/src/index.ts) (`createVisionTools`). The capability table lives in [`extensions/tools-vision/src/pricing.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-vision/src/pricing.ts). Wiring registers the tool in [`packages/wiring/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts), mirroring the `auxiliary.compression` pattern.

## Opting in {#opting-in}

Add `vision_analyze` to the personality's `toolset.yaml`:

```yaml
# ~/.ethos/personalities/<id>/toolset.yaml
- read_file
- vision_analyze
```

The wiring registers the tool unconditionally; the personality `toolset` allowlist is what gates which personalities can see it. See [Personality config reference](../../using/reference/personality-yaml.md#toolset-yaml).

## Signature {#signature}

```
vision_analyze({
  file_path?:   string,
  file_url?:    string,
  file_base64?: string,
  prompt:       string,
  model?:       string,
  format?: { type: 'json_schema', schema: { type: 'object', ... } },
}) → JSON envelope
```

Exactly one of `file_path` / `file_url` / `file_base64` must be set.

| Field | Type | Required | Description |
|---|---|---|---|
| `file_path` | absolute path | one-of | Local file. Must lie inside the personality's `fs_reach` allowlist. |
| `file_url` | HTTPS URL | one-of | Fetched through the [`@ethosagent/safety-network`](https://github.com/ethosagent/ethos/blob/main/extensions/safety-network) SSRF gate. Max 32 MB. |
| `file_base64` | base64 string | one-of | Raw bytes. Optional `data:<mime>;base64,` prefix accepted. |
| `prompt` | string | yes | Question or instruction for the model. |
| `model` | string | no | Override; otherwise follows the model fallback chain below. |
| `format.type` | `'json_schema'` | no | Ask the model for parseable JSON. |
| `format.schema` | JSON Schema | no | Top-level `type` must be `'object'` in v1. |

### Return envelope (success) {#return-envelope-success}

```json
{
  "text": "the model's answer",
  "parsed": { "...": "..." },
  "model": "claude-opus-4-7",
  "cost_usd": 0.0034,
  "input_tokens": 1287,
  "output_tokens": 48
}
```

`parsed` is present only when `format.json_schema` was supplied. `ToolResult.cost_usd` matches `envelope.cost_usd` so the framework's per-session cost counter rendered by [`/usage`](../../using/reference/slash-commands.md#slash-usage) increments correctly.

`maxResultChars`: `8_000` — long transcripts get clipped, with the per-call truncation marker `DefaultToolRegistry` appends to every over-budget result.

## Model fallback chain {#model-fallback-chain}

Per call, the resolved model is:

1. `args.model` (caller override) — useful for "use `gpt-5` for this one".
2. `auxiliaryVisionModel` — from `auxiliary.vision.model` in [`~/.ethos/config.yaml`](../../using/reference/config-yaml.md).
3. `defaultModel` — the active personality's main model.

First non-null wins. The capability table then gates whichever model the chain returned. The `LLMProvider` that serves the resolved model is looked up via a `resolveProvider` callback wired at registration time — when wiring has no provider for the resolved id, the tool fails with `VISION_NOT_SUPPORTED`.

## Capability table {#capability-table}

Two flags per model — `vision` and `pdf`. Unknown models default to **both flags false**, which surfaces as a `VISION_NOT_SUPPORTED` or `PDF_NOT_SUPPORTED` error.

| Model | `vision` | `pdf` |
|---|---|---|
| `claude-opus-4-7` | yes | yes |
| `claude-sonnet-4-6` | yes | yes |
| `gpt-5` | yes | yes |
| `gpt-5-mini` | yes | yes |
| `gemini-2.5-pro` | yes | yes |
| `gemini-2.5-flash` | yes | yes |

Helpers: `supportsVision(model)` and `supportsPdf(model)` (both exported from `@ethosagent/tools-vision`). Adding a model is a one-row edit in `pricing.ts`. Aliases (dated suffixes) are not inferred — every model id is listed explicitly to keep the gate deterministic.

## Configuration {#configuration}

```yaml
# ~/.ethos/config.yaml

# Primary chat config (existing) — vision_analyze defaults to this model
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-...

# Optional auxiliary vision routing. Useful when the personality's main
# model is non-vision (e.g. a local llama) but you still want PDF/image
# Q&A available via a cloud model.
auxiliary.vision.model:    claude-sonnet-4-6
auxiliary.vision.provider: anthropic         # defaults to top-level provider
auxiliary.vision.apiKey:   sk-ant-vision-... # defaults to top-level apiKey
auxiliary.vision.baseUrl:  https://...       # defaults to top-level baseUrl
```

Mirrors the [`auxiliary.compression`](../../using/reference/config-yaml.md) shape. The config type is `AuxiliaryVisionConfig` in [`packages/config/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/config/src/index.ts).

## Examples {#examples}

**Image:**

```
vision_analyze({
  file_path: "/Users/me/code/repo/screenshots/error.png",
  prompt:    "What error is shown here? Be specific about the file and line."
})
```

**PDF + structured output:**

```
vision_analyze({
  file_path: "/Users/me/docs/invoice.pdf",
  prompt:    "Extract the total amount and the vendor name.",
  format: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        total:  { type: "string" },
        vendor: { type: "string" }
      },
      required: ["total", "vendor"]
    }
  }
})
```

**Remote URL:**

```
vision_analyze({
  file_url: "https://example.com/diagram.png",
  prompt:   "Describe the architecture diagram."
})
```

## Error codes {#error-codes}

Tool failures carry a domain-code prefix in the `error` string so callers can pattern-match without parsing the framework's `code`.

| Prefix | `code` | Cause |
|---|---|---|
| `INVALID_INPUT` | `input_invalid` | Missing prompt, wrong format shape, or zero / multiple file keys. |
| `FILE_NOT_FOUND` | `input_invalid` | `file_path` is outside the `fs_reach` allowlist or does not exist. |
| `URL_BLOCKED` | `input_invalid` | `file_url` is non-HTTPS, points at a private network, or fails the SSRF gate. |
| `FILE_TOO_LARGE` | `input_invalid` | Image > 5 MB or PDF > 32 MB. |
| `UNSUPPORTED_FILE_TYPE` | `input_invalid` | Magic-byte check did not match PNG / JPEG / GIF / WEBP / PDF. |
| `VISION_NOT_SUPPORTED` | `not_available` | Resolved model is not vision-capable, or no `LLMProvider` is configured for it. |
| `PDF_NOT_SUPPORTED` | `not_available` | Input is a PDF but the resolved model does not support PDF. |
| `PDF_TOO_MANY_PAGES` | `execution_failed` | Provider rejected the document on page-count grounds. |
| `LLM_ERROR` | `execution_failed` | Any other provider failure (rate-limit, network, auth). |
| `RESPONSE_NOT_JSON` | `execution_failed` | `format.json_schema` requested but the model returned non-JSON or omitted a required field. |

## Limitations {#limitations}

- **One file per call.** No multi-image batching, no document + image mixed prompts.
- **No auto-downscale or paging.** Pre-process oversized inputs before calling.
- **No caching.** Each call pays the input-token cost.
- **`format.json_schema` is a tiny validator.** Top-level `type` must be `'object'`; only `required` field presence is checked. Full JSON-schema validation is out of scope for v1.
- **No streaming.** The tool buffers the full response before returning.

## Video — `video_analyze` {#video-analyze}

Companion tool that analyses a video accessible via HTTPS URL. Same provider plumbing as `vision_analyze`; the model fetches the video itself (Claude / GPT-4o vision endpoints support video-via-URL today).

### Source {#video-source}

[`extensions/tools-vision/src/video.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-vision/src/video.ts) (`createVideoAnalyzeTool`). Capability column lives in the same pricing table: [`extensions/tools-vision/src/pricing.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-vision/src/pricing.ts) — providers without video support refuse with `VIDEO_NOT_SUPPORTED`.

### Schema {#video-schema}

| Field | Type | Required | Description |
|---|---|---|---|
| `file_url` | string | yes | HTTPS URL to the video. SSRF-checked through the same safety pipeline as `vision_analyze`. |
| `prompt` | string | no | Question or instruction. Default: `"Describe this video in detail."` |
| `model` | string | no | Override the resolved model. Must be video-capable. |

Tool metadata: `toolset: 'vision'` (same bucket — a personality with `vision_analyze` typically lists `video_analyze` alongside), `maxResultChars: 30_000`, `capabilities: { network: { allowedHosts: ['*'] } }`, `outputIsUntrusted: true`.

### Limitations {#video-limitations}

- **URL only.** No `file_path` / `file_base64` — the type system has no video-content block for base64 inlining, so local files aren't supported. Upload to an HTTPS-reachable host first.
- **Provider-dependent.** Anthropic and OpenAI's vision-capable chat models accept videos via URL today; refuse with `VIDEO_NOT_SUPPORTED` on other providers.
- **No frame-by-frame extraction.** The model summarises; it doesn't return timestamps or per-frame data structure.
- **Cost.** Video is significantly more expensive per call than images — token accounting flows through the same usage / cost envelope.

### Example {#video-example}

```text
video_analyze({
  file_url: "https://example.com/demo.mp4",
  prompt: "What is the user trying to do in this screen recording? Identify any errors shown."
})
```

Returns the model's text answer plus token usage and dollar cost in the standard envelope.

## See also {#see-also}

- [`extensions/tools-vision/README.md`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-vision/README.md) — package-level reference with the same surface plus the file map.
- [`browser-tools`](browser-tools.md) — pair `browser_screenshot` with `vision_analyze` for vision-on-page.
- [Personality config reference](../../using/reference/personality-yaml.md#toolset-yaml) — how `toolset.yaml` gates which personalities see `vision_analyze`.
- [`config.yaml` reference](../../using/reference/config-yaml.md) — every field these subcommands read, including `auxiliary.*`.
