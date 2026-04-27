# @ethosagent/tools-web

Web search and URL fetch tools with built-in SSRF protection.

## Why this exists

Agents that can browse the public web also need to be stopped from probing private networks (cloud metadata, RFC1918, loopback). This package provides one search tool, one extract tool, and a reusable `checkSsrf` helper that the browser package also consumes.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `web_search` | `web` | Query the Exa search API and return ranked snippets. |
| `web_extract` | `web` | Fetch a URL and convert HTML to plain text. |

Also exported: `checkSsrf(url)` — async predicate returning `{ blocked: false }` or `{ blocked: true; reason }`.

## How it works

`web_search` posts to `https://api.exa.ai/search`. It is gated by `isAvailable()` checking `process.env.ETHOS_EXA_API_KEY` — if the key is missing the tool is hidden from the personality's tool list. Default 5 results, capped at 10, each truncated to 1500 characters of body text. `maxResultChars: 15_000`. Honors `ctx.abortSignal` for cancellation.

`web_extract` only accepts `http:`/`https:` URLs. Before fetching, it runs `checkSsrf` and refuses private addresses. HTML responses are stripped of `<script>`, `<style>`, `<noscript>`, all tags, and a small set of common entities are decoded — see `htmlToText` at `src/index.ts:8`. Non-HTML content types are returned as-is. `maxResultChars: 20_000`.

`checkSsrf` (`src/ssrf.ts`) blocks:

- Hostnames `localhost`, `0.0.0.0`, `metadata.google.internal`
- Any IPv4 in RFC1918, loopback (127/8), link-local (169.254/16, includes AWS/GCP metadata), CGNAT (100.64/10), benchmarking (198.18/15), reserved (240/4), or 0/8
- IPv6 loopback `::1`, link-local `fe80::/10`, unique-local `fc00::/7`, and IPv4-mapped variants in both decimal and hex form (`::ffff:c0a8:101`)
- Hostnames whose DNS lookup resolves to any of the above (rebinding defense, single resolution per call)

DNS-lookup failures fall through and let the underlying `fetch` fail naturally.

## Gotchas

- `web_search` is Exa-only. There is no fallback provider; without `ETHOS_EXA_API_KEY` the tool is simply unavailable.
- `htmlToText` is intentionally naive — no DOM parsing, no readability extraction. JS-rendered SPAs return shell HTML.
- `checkSsrf` is best-effort: a single DNS lookup is performed before `fetch`, so a determined DNS-rebinding attacker could theoretically race the resolution. Network egress filtering is the only complete defense.
- `isValidIpv6` is a coarse heuristic (any string containing `:`); do not reuse it outside this module.
- The `User-Agent` is hardcoded to a fake Mozilla string at `src/index.ts:151`.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `webSearchTool`, `webExtractTool`, `htmlToText`, `createWebTools()`. |
| `src/ssrf.ts` | IPv4/IPv6 private-range tables, `checkSsrf` entry point. |
| `src/__tests__/` | Tests for search, extract, HTML stripping, and SSRF coverage. |
