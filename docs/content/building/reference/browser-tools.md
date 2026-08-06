---
title: Browser tools
description: "Twelve browser tools for navigation, interaction, accessibility snapshots, screenshots, and vision-click. Capability gates and session lifecycle."
kind: reference
audience: developer
slug: browser-tools
updated: 2026-05-17
---

# Browser tools

Ethos ships a Playwright-backed browser surface with **twelve tools** covering navigation, interaction by accessibility ref, vision-click, page-state introspection, and headless-browser session management. Personality lockdown gates which tools are visible per personality via the `toolset.yaml` allowlist.

## Source {#source}

Factory: [`extensions/tools-browser/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/index.ts) — `createBrowserTools`. Per-tool implementations split across `browser-actions.ts`, `browser-screenshot.ts`, `browser-vision-click.ts`, `browser-vision-type.ts`, `snapshot.ts`, `sessions.ts`, `a11y.ts`. Wiring at [`packages/wiring/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts).

## Tools {#tools}

| Tool | Purpose | Capability |
|---|---|---|
| `browse_url` | Legacy single-shot load + extract. Prefer `browser_navigate` for new code. | `network: { allowedHosts: ['*'] }` |
| `browser_navigate` | Load a URL; canonical first call in any workflow. Returns the post-load accessibility snapshot. | `network: { allowedHosts: ['*'] }` |
| `browser_snapshot` | Get an accessibility-tree snapshot with stable `@e<n>` ref IDs for subsequent click/type calls. | none — operates on current page state |
| `browser_click` | Click an element by accessibility ref (`@e3`) from a snapshot. | none |
| `browser_type` | Type text into an element by ref. | none |
| `browser_press` | Send a keyboard key (`Enter`, `Tab`, `Escape`, `Control+A`). | none |
| `browser_scroll` | Scroll viewport (`up` / `down` / to a specific element by ref). | none |
| `browser_back` | Navigate browser history back one step. Returns updated snapshot. | none |
| `browser_console` | Dump recent console messages and JS errors collected since session start. | none |
| `browser_get_images` | List every `<img>` on the page with `src` + `alt` text. | none |
| `browser_dialog` | Accept / dismiss / answer a JS alert / confirm / prompt that's blocking the page. | none |
| `browser_screenshot` | Capture the viewport as a base64 JPEG. Use for `vision_analyze` composition. | none |
| `browser_vision_click` | Single tool that screenshots → vision model identifies the element → clicks. For pages with poor accessibility trees. | `vision: true` (transitively via `vision_analyze`) |
| `browser_vision_type` | Same idea: vision finds the input, then types. | `vision: true` |

All tools share `toolset: 'browser'`, so a personality opting in lists individual tools in `toolset.yaml` — they're not grouped under a single toolset name in the registry filter.

## Accessibility-ref workflow {#a11y-workflow}

Most interaction work follows snapshot → click-by-ref:

```text
1. browser_navigate("https://example.com")
   → returns: accessibility snapshot with refs @e1, @e2, @e3, ...
2. browser_click("@e7")        # element 7 from the snapshot
3. browser_snapshot()          # fresh snapshot reflecting post-click DOM
4. browser_type("@e3", "hello world")
```

Refs are stable within a single page-state but invalidate after navigation, click, or any DOM mutation. Take a fresh snapshot after every interaction. The accessibility tree is what the model reasons over, not the rendered DOM — this gives stable element identity and avoids brittle CSS-selector authoring.

## Vision-click fallback {#vision-fallback}

Pages with poor accessibility (Canvas-rendered SPAs, JS-heavy widgets, custom roles) produce sparse snapshots. `browser_vision_click` and `browser_vision_type` route through the vision model to identify elements visually:

```text
browser_vision_click("the orange 'Sign up' button in the hero section")
```

Slower and costlier than ref-based clicks (one vision API call per interaction), so use as a fallback, not the default.

## Sessions {#sessions}

The browser surface manages headless Playwright sessions internally. One agent turn → one session, scoped to the turn. Sessions are reaped at turn end; cross-turn persistence isn't exposed today (intentional — sessions carry cookies + storage, easy footgun if shared across personalities).

If you need cross-turn state (a long-running scrape), drive multiple turns and pass URLs / state via memory.

## Capability declarations {#capabilities}

The wiring declares capabilities per tool. The personality-lockdown enforcement gate at [`packages/core/src/agent-loop.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop.ts) confirms each call's declared capabilities are satisfied. Today:

- **Network**: only `browse_url` and `browser_navigate` carry `network: { allowedHosts: ['*'] }`. Other browser tools operate on a page already loaded by one of these, so they don't independently re-declare network reach.
- **Vision**: `browser_vision_click` / `browser_vision_type` invoke `vision_analyze` internally, which carries `fs_reach: { read: 'from-personality' }` and the vision capability.

## Errors {#errors}

| Error | Cause |
|---|---|
| `Browser session not active — call browser_navigate first` | Tool requires a loaded page; agent skipped the navigate step |
| `Element ref @e<n> not found in current snapshot` | Stale ref; page mutated after the snapshot was taken |
| `Network request blocked: <host> not in allowlist` | Personality's `network` capability doesn't allow the domain |
| `Dialog already auto-dismissed` | Page raised a JS dialog before agent could respond; Playwright's default auto-dismisses |

## Examples {#examples}

### Read JS errors from a page {#example-console}

```text
1. browser_navigate("https://app.example.com")
2. browser_console()
   → returns:
     [error] Uncaught TypeError: Cannot read 'foo' of undefined  (app.js:42)
     [warn]  Deprecated API usage in legacy-loader.js
```

### Fill and submit a form via accessibility refs {#example-form}

```text
1. browser_navigate("https://example.com/signup")
2. browser_snapshot()   → identifies @e5 (email input), @e6 (password), @e7 (submit)
3. browser_type("@e5", "alice@example.com")
4. browser_type("@e6", "correcthorsebatterystaple")
5. browser_click("@e7")
6. browser_snapshot()   → confirm post-submit state
```

### Composite vision review {#example-vision-review}

```text
1. browser_navigate("https://example.com/dashboard")
2. browser_screenshot()
3. vision_analyze(image=<screenshot>, prompt="Identify any anomalies or out-of-range values.")
```

## See also {#see-also}

- [`vision_analyze` reference](vision-tools.md) — pairs with `browser_screenshot` for visual page review.
- [Tool capabilities](tool-capabilities.md) — the capability declaration contract.
- [Tool interface](tool-interface.md) — the `Tool<TArgs>` shape every browser tool implements.
