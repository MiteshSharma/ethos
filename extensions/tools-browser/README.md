# @ethosagent/tools-browser

Headless Chromium tools for navigating, clicking, and typing on web pages, exposing an accessibility-tree view with stable element references.

## Why this exists

`web_extract` reads static HTML; this package drives a real browser for SPAs and forms. The agent never sees pixels — instead it sees a YAML-formatted accessibility tree where every interactive element is tagged with an `@e{n}` reference that subsequent click/type calls use to locate the element by ARIA role + name.

## Tools provided

| Tool name | Toolset | Purpose |
|---|---|---|
| `browse_url` | `browser` | Navigate to a URL and return the page's accessibility tree with `@e{n}` refs. |
| `browser_click` | `browser` | Click an element by its `@e{n}` reference and return the updated tree. |
| `browser_type` | `browser` | Type text (optionally pressing Enter) into an element by `@e{n}`. |

Factory: `createBrowserTools()`. Also re-exports `parseAriaSnapshot`, `buildA11yTree`, and the `A11yRef` / `A11yResult` / `RawA11yNode` types from `src/a11y.ts`.

## How it works

One `Browser` + `Page` is kept per `ctx.sessionId` in a module-level `Map` (`src/index.ts:31`). `getOrCreateSession` lazy-launches Chromium with `--no-sandbox --disable-setuid-sandbox --disable-gpu`. A `SIGTERM` handler best-effort closes every session on process shutdown.

All three tools gate on `isPlaywrightInstalled()` via `import.meta.resolve('playwright')` (`src/index.ts:10`) — the tools simply disappear from the personality's tool list when Playwright is not present. `browse_url` additionally enforces `http://`/`https://` and runs `checkSsrf` from `@ethosagent/tools-web` before navigating, so the same private-network protections apply.

After every navigation, click, or type, `snapshotPage` calls Playwright's `page.locator('body').ariaSnapshot()` (1.44+) to get a YAML accessibility view. `parseAriaSnapshot` (`src/a11y.ts:48`) regex-scans every line whose role is in `INTERACTIVE_ROLES` (button, link, textbox, checkbox, etc.) and rewrites it with a fresh `@e{n}` token. The map of refs lives on the session and is replaced after every action.

`browser_click` and `browser_type` look up the ref on the session, then locate via `page.getByRole(ref.role, { name: ref.name }).first()` with a 10 s timeout. After clicking, the tools `waitForTimeout(500)` to let navigation/re-render settle before snapshotting again. On error, `browse_url` closes the session (`closeSession` at `src/index.ts:160`); the click and type tools leave the session intact so the agent can retry.

`buildA11yTree` is a parallel, JSON-tree based formatter exposed for tests and for callers that want to format raw `RawA11yNode` data.

## Gotchas

- Sessions are keyed by `ctx.sessionId`. Two parallel tool calls on the same session will fight over the same `Page` — `executeParallel` runs concurrently, so a personality that allows several browser actions in one turn can race.
- After any successful action, the previous `@e{n}` refs are invalid — the snapshot rebuilds the map from scratch every time. Do not cache refs across calls in the LLM history.
- Element location uses ARIA role + accessible name. If two elements share both, `.first()` wins silently.
- Playwright's Chromium binary is not installed by `pnpm install`. Run `npx playwright install chromium` once.
- The `--no-sandbox` flags are required for some container/CI environments and broaden the trust boundary — do not point this at hostile pages on a privileged host.
- `parseAriaSnapshot` is a regex over YAML, not a YAML parser. Roles whose accessible name contains an unescaped `"` will not be tagged.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Session map, `browse_url`/`browser_click`/`browser_type`, `createBrowserTools()`. |
| `src/a11y.ts` | `INTERACTIVE_ROLES`, `parseAriaSnapshot`, `buildA11yTree`. |
| `src/__tests__/` | Tests for snapshot parsing, ref injection, and tree building. |
