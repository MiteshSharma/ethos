---
title: "Configure local model serving"
description: "Serving flags for llama.cpp, Ollama, and vLLM that make local Ethos agents work: context length, prefix cache, tool-call parsers, KV quantization."
kind: how-to
audience: user
slug: configure-local-serving
time: "15 min"
updated: 2026-08-06
---

## Task

Configure llama.cpp, Ollama, or vLLM so a local model serves Ethos agent turns with a real context window, a working prefix cache, and tool calls that arrive as tool calls.

## Result

The server keeps the model resident, reuses the prompt prefix between turns, accepts a context large enough for your [personality](../../getting-started/glossary.md#personality) (the directory of files that decides an agent's tools, memory, and model) — and you verify all of it with `ollama ps`, `ethos bench context`, and `ethos personality show`.

This page is about making *Ethos* work well on a local server. For general local-LLM setup, use the runtime's own docs: [llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server), [Ollama](https://docs.ollama.com), [vLLM](https://docs.vllm.ai).

## Prereqs

- A local endpoint wired as the provider — `provider: ollama` or `provider: vllm` per [Configure an LLM provider](configure-providers).
- Enough VRAM for the model *at the context length you configure*. KV cache is real memory: tens of thousands of context tokens can cost several GB on top of the weights.

## Steps

### 1. Pick the model family for tool discipline, not parameter count

Tool-calling reliability tracks the model *family*, not the parameter count. In Docker's 21-model, 3,570-case tool-calling evaluation (third-party numbers — not Ethos measurements), `qwen3:8B` scored **0.933 F1** while `llama3.3:70B` scored **0.607** — an 8B model beating a 70B one by half again, on tool calling specifically. If your agent fumbles tool calls, try a different family before trying a bigger model.

Then check the context window the model *natively* supports — advertised context is not native context:

| Model | Advertised | Native | How the gap is bridged |
|---|---|---|---|
| Qwen3 | 131,072 | 32,768 | YaRN rope scaling — quality degrades past native |
| gpt-oss | 131,072 | 4,096 | Extension over a 4k native window |

Configure your serving context from the **native** column. A 131k context on a 32k-native model accepts your tokens and quietly degrades on them.

### 2. Configure the runtime

Pick one runtime. Ollama is the recommended path — it needs two environment variables and nothing else; choose llama.cpp when you want direct control over cache and quantization flags, vLLM when you need throughput under concurrent requests.

#### Option A — Ollama (Recommended)

Ollama's default context is small (4,096 on most setups, tiered by VRAM) — far below what an agent turn needs. Raise it and keep the model resident:

```bash
OLLAMA_CONTEXT_LENGTH=64000 OLLAMA_KEEP_ALIVE=-1 ollama serve
```

- `OLLAMA_CONTEXT_LENGTH` ≥ 64000 — the setting that fixes the 4,096 default. Ethos system prompts plus tool definitions plus history do not fit in 4k.
- `OLLAMA_KEEP_ALIVE=-1` — never unload the model, so the prefix cache survives between turns instead of dying with the process's idle timeout.

Verify the context length took effect — do not assume it:

```bash
ollama ps
```

```
NAME        ID            SIZE     PROCESSOR    CONTEXT    UNTIL
qwen3:8b    500a1f067a9f  6.5 GB   100% GPU     64000      Forever
```

`CONTEXT` must show your configured value and `UNTIL` must show `Forever`. If `CONTEXT` still shows 4096, the variable did not reach the server process — restart `ollama serve` with the variable in its environment, not the client's.

#### Option B — llama.cpp

```bash
llama-server -m <model>.gguf -c 64000 --jinja --cache-reuse 256 --checkpoint-min-step 2048
```

| Flag | Default | Why it matters for agents |
|---|---|---|
| `--jinja` | off | Applies the model's chat template. Without it, chat formatting — and therefore tool calling — is wrong. |
| `--cache-reuse 256` | `0` (off) | Prefix reuse does nothing until this is set. The default silently recomputes the whole prompt every turn. |
| `--checkpoint-min-step 2048` | `8192` | Checkpoints are only written every N tokens. Agent turns are usually shorter than the 8192 default, so with the default they get no checkpoint at all. Set it below your typical turn size. This is the single most commonly-missed llama.cpp setting for agent workloads. |

Expected startup output includes the listen line:

```
main: server is listening on http://127.0.0.1:8080 - starting the main loop
```

Point Ethos at it with `provider: vllm` semantics — any OpenAI-compatible `baseUrl` works: `baseUrl: http://localhost:8080/v1`.

#### Option C — vLLM

```bash
vllm serve Qwen/Qwen3-8B --enable-prefix-caching --enable-auto-tool-choice --tool-call-parser hermes
```

- `--enable-prefix-caching` — reuses the byte-stable prompt prefix Ethos maintains across turns. The repo's [CLAUDE.md local-serving note](https://github.com/MiteshSharma/ethos/blob/main/CLAUDE.md) covers why the prefix stays byte-identical; this flag is the serving side of that contract.
- `--enable-auto-tool-choice --tool-call-parser <parser>` — the parser must match the model family:

| Model family | `--tool-call-parser` |
|---|---|
| Qwen2.5 / Qwen3 | `hermes` |
| Llama 3.x | `llama3_json` |
| Mistral | `mistral` |

Run `vllm serve --help` for the full parser list. **The wrong parser fails soft:** tool calls arrive as plain text in the response body, so the model appears to *narrate* JSON instead of calling tools, and every tool-dependent turn dead-ends.

### 3. Quantize the KV cache — K needs ≥q8, V tolerates coarser

If context memory does not fit, quantize the KV cache asymmetrically (llama.cpp flags shown; the rule is runtime-independent):

```bash
llama-server -m <model>.gguf -c 64000 --jinja --cache-reuse 256 \
  -ctk q8_0 -ctv q4_0 -fa on
```

The rule, with its numbers (measured on Qwen2.5-7B with llama.cpp, third-party): **K needs ≥q8 — `q8_0` keys preserved 98.02% top-p match, while `q4_0` keys collapsed to 11.75%. V tolerates coarser quantization.** The keys carry the attention geometry, so they degrade first; the values carry content, and content survives a coarser representation.

Do not confuse KV quantization with *weight* quantization. **Weight quantization is safe for tool calling** — a q4 GGUF calls tools fine. The failure people attribute to "4-bit models can't call tools" is usually a quantized K cache, not quantized weights. Conflating the two leads people to run unnecessarily large models.

### 4. Optional — speculative decoding

If your runtime supports a draft model (llama.cpp `--model-draft`, vLLM speculative config), turn it on. It is **output-identical** — the target model verifies every draft token, so quality is unchanged — and delivers 2–3× throughput at concurrency 1–4, which is exactly the single-user local regime. Zero Ethos configuration is involved; it is purely a serving-side win.

## Verify

Close the loop against your actual personality, not a synthetic prompt.

Measure what one turn really costs on your setup:

```bash
ethos bench context
```

```
personality      static-context   per-turn tax
researcher       11,842 tokens    13,205 tokens
```

Then check the personality against the window you just configured:

```bash
ethos personality show researcher
```

The character sheet ([`ethos personality`](../reference/cli#ethos-personality) in the CLI reference) prints the personality's identity, routing, memory scope, and toolset — the inputs that make up the static context you just sized the server for. If you raised `OLLAMA_CONTEXT_LENGTH` for a personality that didn't fit, `ethos bench context` followed by `ethos personality show <id>` is the "does it fit now?" answer.

## Troubleshoot

- **Model replies but never calls tools (vLLM).** Wrong `--tool-call-parser`, or `--enable-auto-tool-choice` missing. The tool call is in the response *text* — check the raw completion. Match the parser to the model family per the table above.
- **Every turn is slow, even short ones (llama.cpp).** `--cache-reuse` is unset (defaults to 0) or turns are shorter than `--checkpoint-min-step` (defaults to 8192). Set both.
- **`ollama ps` shows `CONTEXT 4096` after configuring 64000.** The env var was set in the client shell, not the server's. Stop the server, `export OLLAMA_CONTEXT_LENGTH=64000`, start `ollama serve` in that shell (or set it in the service unit).
- **Garbage output after enabling KV quantization.** You quantized K below q8 (`-ctk q4_0`). Keep K at `q8_0` or above; push V down instead.
- **Model answers degrade on long sessions despite a 131k window.** You are past the model's *native* window (step 1). Reduce the configured context to the native value, or pick a model whose native window fits your workload.

## Numbers and provenance

Serving flags drift with upstream releases — this page's facts are pinned:

| Fact | Source | Checked |
|---|---|---|
| 0.933 vs 0.607 F1 | Docker's tool-calling evaluation, 21 models / 3,570 cases (third-party; not reproduced by Ethos) | 2026-08 |
| 98.02% / 11.75% top-p match | llama.cpp KV-cache quantization measurement on Qwen2.5-7B (third-party) | 2026-08 |
| `--cache-reuse` default 0, `--checkpoint-min-step` default 8192 | llama.cpp server flags current at 2026-08 | 2026-08 |
| Ollama 4,096 default context, `ollama ps` CONTEXT column | Ollama releases current at 2026-08 | 2026-08 |
| Qwen3 32k native / 131k YaRN; gpt-oss 4k native / 131k advertised | Model cards, current at 2026-08 | 2026-08 |

If a number no longer matches your runtime's `--help` output, trust the runtime and [file a docs issue](https://github.com/MiteshSharma/ethos/issues).
