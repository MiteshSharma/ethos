---
title: Browser tools
description: "Browser tools for navigation, interaction, screenshots and vision-click, plus launch posture, persistent profiles, bot-wall detection and human takeover."
kind: reference
audience: developer
slug: browser-tools
updated: 2026-09-05
---

# Browser tools

Ethos ships a Playwright-backed browser surface covering navigation, interaction by accessibility ref, vision-click, page-state introspection, and browser session management — **thirteen tools**, plus `browser_request_takeover` in any deployment that has an interactive surface to hand a browser to. Personality lockdown gates which tools are visible per personality via the `toolset.yaml` allowlist.

## Source {#source}

Factory: [`extensions/tools-browser/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/index.ts) — `createBrowserTools`. Per-tool implementations split across `browser-actions.ts`, `browser-screenshot.ts`, `browser-takeover.ts`, `browser-vision-click.ts`, `browser-vision-type.ts`, `snapshot.ts`, `sessions.ts`, `launch-options.ts`, `block-detector.ts`, `a11y.ts`. Wiring at [`packages/wiring/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts).

## Tools {#tools}

| Tool | Purpose | Capability |
|---|---|---|
| `browse_url` | Legacy single-shot load + extract. Prefer `browser_navigate` for new code. | `network: { allowedHosts: ['*'] }` |
| `browser_navigate` | Load a URL; canonical first call in any workflow. Returns the post-load accessibility snapshot. | `network: { allowedHosts: ['*'] }` |
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
| `browser_request_takeover` | Pause the agent and hand the live browser to a human, then wait for them to hand it back. Registered only when wiring supplies a `ClarifyBridge`. | none |

All tools share `toolset: 'browser'`, so a personality opting in lists individual tools in `toolset.yaml` — they're not grouped under a single toolset name in the registry filter.

Every interaction tool returns the updated accessibility tree, so a fresh snapshot arrives with each result. There is no standalone `browser_snapshot` tool — `browse_url` and `browser_navigate` produce the first snapshot, and each click, type, scroll or back call produces the next.

## Accessibility-ref workflow {#a11y-workflow}

Most interaction work follows snapshot → click-by-ref:

```text
1. browser_navigate("https://example.com")
   → returns: accessibility snapshot with refs @e1, @e2, @e3, ...
2. browser_click("@e7")        # element 7; returns the post-click snapshot
3. browser_type("@e3", "hello world")   # refs from step 2's snapshot
```

Refs are stable within a single page-state but invalidate after navigation, click, or any DOM mutation. Always address elements by the refs in the *most recent* result, never by refs from an earlier one. The accessibility tree is what the model reasons over, not the rendered DOM — this gives stable element identity and avoids brittle CSS-selector authoring.

## Vision-click fallback {#vision-fallback}

Pages with poor accessibility (Canvas-rendered SPAs, JS-heavy widgets, custom roles) produce sparse snapshots. `browser_vision_click` and `browser_vision_type` route through the vision model to identify elements visually:

```text
browser_vision_click("the orange 'Sign up' button in the hero section")
```

Slower and costlier than ref-based clicks (one vision API call per interaction), so use as a fallback, not the default.

## Sessions {#sessions}

The browser surface manages Playwright sessions internally, keyed by `(sessionId, networkPolicy)`. A session outlives the turn that opened it: an idle sweeper closes sessions untouched for [`browser.idleTimeoutMs`](../../using/reference/config-yaml.md#browser) (default 10 minutes) and runs once a minute, and `SIGTERM` / `SIGINT` close every remaining session — awaiting `context.close()`, because a persistent context flushes its profile on close and killing only the browser handle would lose the login the profile exists for.

Two things a session is never reaped for. A session whose current page is being driven by a human is skipped by the sweeper for as long as the [takeover](#takeover) is live. And when [profiles](#profiles) are on, the cookies and storage a session accumulated survive the session's own death — they live in the profile directory, not the session.

## Launch posture {#launch-posture}

Everything about how a session launches is operator config under [`browser.*`](../../using/reference/config-yaml.md#browser), resolved once at tool-construction time in [`launch-options.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/launch-options.ts) and applied to every session.

**Headed vs. headless.** `browser.headed` is three-state, not a boolean:

- `auto` — the default, and what an absent key means. Headed where this machine can put a window on a screen: always on macOS and Windows; on Linux/BSD only when `DISPLAY` or `WAYLAND_DISPLAY` is set. Headless otherwise.
- `true` — headed. On a machine with no display this does not fail; it falls back to headless, and the `browse_url` / `browser_navigate` result that opened the session carries `⚠ browser.headed: true, but this machine has no display (no DISPLAY or WAYLAND_DISPLAY) — running headless.` once.
- `false` — headless, unconditionally.

**This is a visible change on upgrade.** Earlier releases were always headless. A developer on macOS will now see a real Chromium window open on the first `browse_url`. Set `browser.headed: false` to keep the previous behaviour.

**Proxy.** `browser.proxy.server` routes every session through an upstream proxy and must carry an explicit scheme (`http`, `https`, `socks4`, `socks5`); a bare `host:port` is refused at boot rather than guessed at. Before you set it, read [the SSRF limit under a proxy](../../security/controls.md#ssrf-browser-proxy) — it is a real gap, not a caveat.

**No stealth tier ships.** `browser.stealth.enabled` parses and is stored, and nothing reads it. There is no stealth engine, no fingerprint patching and no stealth-tier tool in this release; setting the key changes no behaviour.

## Persistent profiles {#profiles}

With `browser.profiles.enabled: true`, a session launches as a Playwright *persistent context* rooted at `~/.ethos/browser-profiles/<personality-id>/` instead of a throwaway one. Cookies, local storage and site data written there survive the session, the turn, `/new`, and a restart — a login the agent (or a human, during a takeover) completes once holds for every later session under that personality.

Profiles are **per personality**, which is the isolation boundary: two personalities never share a login, and a personality id that is not `[A-Za-z0-9_-]+` gets no profile at all rather than being allowed to name a directory. Profiles are **off unless the key is explicitly `true`** — an absent key is off.

A profile directory can only be open once. **Inside one Ethos process**, that is enforced by the per-profile mutex in [`sessions.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/sessions.ts) — `acquireProfileLock`. A second concurrent session for the same personality waits **15 seconds** for the first to finish, then gives up and launches an ordinary ephemeral context instead. That fallback is not silent — the `browse_url` / `browser_navigate` result that opened the session carries:

```text
⚠ Browser profile '<personality-id>' is in use by another session — this second session is not logged in.
```

Treat that warning as load-bearing. The second session works, and it is signed into nothing.

### Run one process per profile {#profiles-one-process}

**The mutex is process-local; the directory it guards is not.** `acquireProfileLock` is a promise chain held in one Node process's memory, while `~/.ethos/browser-profiles/<personality-id>/` is shared state on disk. A second Ethos process running the same personality — `ethos serve` beside `ethos gateway`, the desktop app beside a CLI chat, two daemons on one host — never sees the first process's lock. It does not wait 15 seconds, and it does not fall back to an ephemeral context.

What it meets instead is Chromium's own single-instance lock on the user data directory, one layer down and far less forgiving: `launchPersistentContext` fails, and the failure surfaces as a **failed** `browse_url` / `browser_navigate` — not as a warning on a working session. There is no cross-process lock behind the profile directory yet.

The failure is loud, not silent: Chromium refuses to open a directory another live Chromium holds, so what you lose is the tool call, not the login already stored in the profile. We have no evidence of profile corruption from a concurrent launch, and this page does not claim any.

Until a cross-process lock ships, pick one:

- **Run one Ethos process per personality profile. (Recommended)** The in-process mutex then covers every session that touches the directory, and the 15-second wait and ephemeral fallback above behave exactly as documented.
- **Set `browser.profiles.enabled: false` on the secondary process.** Its sessions are ephemeral and signed into nothing — the same posture as the in-process fallback, chosen deliberately rather than arrived at through a launch error.

## Bot walls {#bot-walls}

A bot wall answers a navigation with a real page — a 200, or a 403/429/503, with HTML and a title. Playwright reports success, and without a check the agent would read "Just a moment…" as the article it asked for. So `browse_url` and `browser_navigate` run [`detectBlock`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-browser/src/block-detector.ts) over the response status, headers, title and rendered text.

A detected wall is a **failure**, not a success carrying a flag:

```text
Blocked by Cloudflare bot protection (HTTP 403) at https://example.com/article —
matched "just a moment". The page content was not read and no retry was
attempted. Escalate with browser_request_takeover to hand the live browser to
the user so they can clear the interstitial, then navigate again.
```

The result names the vendor when one is recognised, the status when one triggered it, and the exact marker that matched, so the call is checkable. Nothing is retried and nothing is escalated on the agent's behalf.

Two triggers, in order: a named vendor signature (Cloudflare, DataDome, PerimeterX, Akamai — by header or on-page phrase), or failing that a bare 403/429/503, which reports an unnamed wall.

**The signature list is deliberately narrow.** `server: cloudflare` and `server: AkamaiGHost` sit on a large fraction of the healthy web and are **not** treated as blocks; Cloudflare is matched on `cf-mitigated`, the header that means "this response *is* the wall", and Akamai on its deny-page reference block. A false positive tells the agent a page it can read is walled, which is worse than a miss — a miss is recoverable because the snapshot is right there.

The hint names an escalation tool only when this process actually registered one. In a deployment with no `ClarifyBridge` there is no `browser_request_takeover`, and the hint says so rather than naming a tool the agent would waste a turn calling.

## Human takeover {#takeover}

`browser_request_takeover({ reason, timeout_s? })` pauses the agent and hands the live browser session to a person — for a login, an MFA prompt, a consent screen, or an interstitial the agent cannot clear. It is registered only when wiring supplies a `ClarifyBridge`: a deployment with no interactive surface has nobody to hand a browser to.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `reason` | string | — | Required, non-empty. What the user needs to do, in one sentence — shown to them verbatim. An empty or missing value is `input_invalid`. |
| `timeout_s` | number | `900` (15 min) | How long to wait for the hand-back. Rounded and clamped to `1`–`86400`. |

The call blocks until the takeover settles. While it is pending:

- A headed session is brought to the front (`page.bringToFront()`) so the window the user is being asked to use is not behind everything else. A headless session has nothing to raise.
- **Every other browser tool refuses** with `not_available` and `A human has taken over this browser session — the agent cannot drive it until they hand it back.` The code is `not_available` rather than `execution_failed` on purpose: the tool is fine, the browser is simply not the agent's right now.
- The idle sweeper skips the session.

On a real hand-back the tool returns:

```json
{
  "handed_back": true,
  "outcome": "user",
  "url": "https://example.com/dashboard"
}
```

`handed_back` is true **only** when a person actually handed the session back (`outcome: "user"`). A cancelled takeover returns `handed_back: false` with `outcome: "cancel"` — reported as true, it would tell the agent the login it is about to depend on has happened. A timeout does not return at all: it is `execution_failed` with `No one took over the browser within <n>s. The page is unchanged; report the blockage.` A session closed mid-takeover is `execution_failed` too, with nothing handed back, and a deployment where no surface can carry the request fails with `not_available`. The lock is released on every one of those paths, in a `finally` — a lock leaked on any exit would wedge browsing for the rest of the process.

**What the human sees** depends on the surface. The web chat draws a panel with the URL, a countdown and a **Hand back** button, and disables the composer. Telegram, Slack, Discord and WhatsApp cannot host a browser, so they render one sentence pointing at the machine and the web chat:

```text
I'm stuck on a login at example.com — the browser window is open on the machine
running Ethos; open the web chat to hand back: https://ethos.example.com/chat
```

That link is `<webBaseUrl>/chat`, built from `webBaseUrl` (which resolves `ETHOS_PUBLIC_URL` first). It names the web app's permanent chat entry point rather than a per-session deep link, because a channel row's session id is a channel key (`telegram:12345`) that the web router would 404 on. With nothing configured the sentence degrades to naming the web chat without a link — no scheme, host or port is ever guessed.

A takeover hands over a live, logged-in session. See [the security note](../../security/controls.md#browser-takeover-exposure) before granting this tool.

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
| `Blocked by <vendor> bot protection …` | [Bot wall](#bot-walls). The page was not read and nothing was retried. |
| `A human has taken over this browser session …` | A [takeover](#takeover) is live. Code `not_available`, not a page failure — wait for the hand-back. |
| `This browser session is already handed to a human …` | `browser_request_takeover` called on a session that already holds a takeover lock. |
| `No one took over the browser within <n>s.` | Takeover timed out. The page is unchanged; report the blockage rather than retrying. |
| `The browser session was closed during the takeover …` | `/new`, an abort, or the operator closing the window while a human held it. |
| `⚠ Browser profile '<id>' is in use by another session …` | Not an error — a notice on an otherwise successful result. This session fell back to an ephemeral context and is [not logged in](#profiles). |

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
   → snapshot identifies @e5 (email input), @e6 (password), @e7 (submit)
2. browser_type("@e5", "alice@example.com")
3. browser_type("@e6", "correcthorsebatterystaple")
4. browser_click("@e7")
   → returns the post-submit snapshot
```

### Composite vision review {#example-vision-review}

```text
1. browser_navigate("https://example.com/dashboard")
2. browser_screenshot()
3. vision_analyze(image=<screenshot>, prompt="Identify any anomalies or out-of-range values.")
```

## See also {#see-also}

- [`browser.*` config reference](../../using/reference/config-yaml.md#browser) — the operator keys behind headed mode, proxy, profiles and the idle sweep.
- [Security controls: the browser SSRF guard under a proxy](../../security/controls.md#ssrf-browser-proxy) — what `browser.proxy.server` does not protect.
- [`vision_analyze` reference](vision-tools.md) — pairs with `browser_screenshot` for visual page review.
- [Tool capabilities](tool-capabilities.md) — the capability declaration contract.
- [Tool interface](tool-interface.md) — the `Tool<TArgs>` shape every browser tool implements.
