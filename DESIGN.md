# Ethos · Design System

**The agent team is present.** Each personality has a face. The chat surface fingerprints which agent you are talking to. This system delivers that across CLI, TUI, VS Code extension, web UI, and email digests.

> Always read this file before making any visual or UI decision. All font choices, colors, spacing, and aesthetic direction live here. Do not deviate without explicit user approval.

## Product context

- **What this is:** TypeScript AI agent framework where personality is architecture
- **Who it's for:** developers, terminal-adjacent power users
- **Project type:** multi-surface developer tool (CLI / TUI / VS Code / web UI / email / platform adapters)
- **Memorable thing:** the agent team is PRESENT. Each personality has a face — generative mark + accent color + voice. Distinguishes vs anonymous-LLM chatbots.

## Aesthetic direction

- **Direction:** Industrial / Utilitarian + identity-forward
- **Decoration level:** minimal — typography and per-personality accents do all the work. No grain, no texture, no decorative SVG, no gradient backgrounds.
- **Mood:** terminal-adjacent, honest, dense-but-readable. Linear-density meets Vercel-typographic-restraint with personality.
- **Reference points:** Linear (calm density, sidebar nav), Vercel (typographic restraint), GitHub identicons (deterministic generative marks)

## Typography

- **Display / UI:** `Geist` — 400 (regular) / 500 (medium) / 600 (semibold). No italics in UI chrome.
- **Mono / code / tool args / data:** `Geist Mono` 400. Used for: model names, tool names, tool arguments, kbd hints, file paths, tabular numbers, timestamps.
- **Loading:** self-hosted via npm `geist` package on web; system font fallback `'Geist', system-ui, sans-serif` and `'Geist Mono', monospace`. Never `Inter`, `Roboto`, `system-ui`, `-apple-system` as the primary display font.
- **Why:** Geist is the current right pair for serious developer tools. The mono is excellent and the proportional has restraint without being neutral.

### Scale

| Role | Size | Weight | Line height | Letter spacing |
|---|---|---|---|---|
| h1 / hero | 32px (2rem) | 600 | 1.2 | -0.01em |
| h2 | 24px (1.5rem) | 600 | 1.25 | 0 |
| h3 | 20px (1.25rem) | 600 | 1.3 | 0 |
| h4 / strong-body | 16px (1rem) | 500 | 1.4 | 0 |
| body | 14px (0.875rem) | 400 | 1.5 | 0 |
| small | 12px (0.75rem) | 400 | 1.4 | 0 |
| micro / section labels | 11px (0.6875rem) | 500 | 1.4 | 0.08em (uppercase) |
| mono | 13px (0.8125rem) | 400 | 1.45 | 0 |

`font-variant-numeric: tabular-nums` on all mono content — tables, tool-chip metadata, usage counters, timestamps.

## Color

Dark mode is **primary**. Light mode is **supported but not optimized** (used by some users in bright environments — must be readable, not a marketing surface).

### Surface tokens

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--bg-base` | `#0F0F0F` | `#FAFAF7` | App background. Paper-warm, not pure black/white. |
| `--bg-elevated` | `#1A1A1A` | `#FFFFFF` | Sidebar, drawer, modal, card primitive |
| `--bg-overlay` | `#2A2A2A` | `#F0F0EC` | Hover, pressed states, user message background |
| `--border-subtle` | `#2A2A2A` | `#E8E8E4` | Default borders |
| `--border-strong` | `#3A3A3A` | `#D0D0CC` | Emphasized borders, dividers |
| `--text-primary` | `#E8E8E6` | `#1A1A1A` | Main body text. Contrast ~14:1 / ~17:1 |
| `--text-secondary` | `#9A9A98` | `#6B6B6A` | De-emphasized text |
| `--text-tertiary` | `#6B6B6A` | `#94948F` | Muted, captions, section labels |

### Per-personality accent (the load-bearing identity affordance)

The chat tab swaps `--accent` per active personality via a second `<ConfigProvider>` wrapper. Accent flows through:
- Personality bar accent stripe (3-4px tall)
- Composer caret color (`caret-color: var(--accent)`)
- Send button background
- Focus ring (`outline: 2px solid var(--accent); outline-offset: 1px`)
- Link color in agent text
- Active sidebar item left-border (when chat tab is active)

| Personality | Hex | Reasoning |
|---|---|---|
| researcher | `#4A9EFF` | Blue — knowledge, exploration |
| engineer | `#4ADE80` | Green — making, building |
| reviewer | `#F59E0B` | Amber — caution, judgment |
| coach | `#E879F9` | Magenta — encouragement, clarity |
| operator | `#94A3B8` | Grey — operational, neutral |

### Semantic colors

Used **only** to signal status, never as decoration. Always paired with an icon — never color alone.

| Token | Hex | Usage |
|---|---|---|
| `--success` | `#4ADE80` | (matches engineer) — success states, completed tools |
| `--warning` | `#F59E0B` | (matches reviewer) — pending review, soft warnings |
| `--error` | `#F87171` | distinct red, never a personality color — failures, rejections |
| `--info` | `#4A9EFF` | (matches researcher) — informational tags, neutral notifications |

## Spacing

Base unit: **8px**. Density: **comfortable** — not data-dashboard compact, not marketing-spacious. Linear-density.

```
xs  4px
sm  8px
md  12px
lg  16px
xl  24px
2xl 32px
3xl 48px
4xl 64px
5xl 96px
```

## Layout

- **Approach:** grid-disciplined for app surfaces; single-composition for onboarding steps
- **Web sidebar:** 240px expanded / 64px collapsed
- **Web right drawer:** 360px (toggleable, default visible at ≥1280px)
- **Chat content max-width:** 800px (readable line-length)
- **Onboarding step max-width:** 520px (centered, generous vertical breathing)
- **Border-radius scale (hierarchical):**
  - `sm: 4px` — buttons, chips, inputs
  - `md: 8px` — cards, modals, surface containers
  - `lg: 14px` — drawers, large surfaces
  - `full: 9999px` — pills, status dots, only on circular elements

### "Cards earn existence" rule

The `Card` primitive is reserved. It appears **only** on:
- Skill rows (Skills tab)
- Cron job rows (Cron tab)

Everything else uses raw layout primitives. Tool chips are inline rows. Drawer streams are dense lists. Onboarding personality picker is stacked rows. No card grids anywhere.

## Motion

Single easing, short durations, no bounces or springs.

```css
--motion-fast:    80ms   /* hover, focus ring */
--motion-default: 180ms  /* state changes, tool chip transitions */
--motion-slow:    240ms  /* drawer, sidebar, modal slide */
--ease:           cubic-bezier(0.16, 1, 0.3, 1)
```

Transitions allowed on: `opacity`, `transform`, `color`, `background-color`, `border-color`, `outline-color`. **Never on text content** (no width-animating text reveals — they cause layout thrash).

`prefers-reduced-motion` → all motion is instant. `* { transition: none !important; animation: none !important; }`.

## Personality marks (generative SVG)

Deterministic geometric marks per personality. Same algorithm runs at render time on every surface — no asset pipeline, no PNG bundle.

**Algorithm:**
1. Hash personality `id` (FNV-1a 32-bit)
2. 5×5 grid, mirror-symmetric (cells `[0..2]` mirrored to `[3..4]`)
3. Each cell filled based on a bit from the hash; opacity 0.55–0.93 from next 2 bits
4. Background: rounded square at `${size * 0.16}` radius, accent color at `0x22` alpha
5. Filled cells: solid accent at the computed opacity

Reference implementation in `apps/web/src/components/ui/PersonalityMark.tsx`. Same algorithm available as `packages/web-contracts/src/marks.ts` so server-side rendering and TUI ASCII fallback can use it.

For TUI: render as a 4×4 unicode block-character grid using `▓▒░` characters with the personality's ANSI accent. Same hash, same symmetry, just lower fidelity.

## Cross-surface token mapping

Ethos lives across surfaces. The single source of truth is hex values and font choices in this file. Each surface reads them differently:

| Token | Web (CSS var) | TUI (ANSI 256) | VS Code (theme) | Email digest | CLI (chalk) |
|---|---|---|---|---|---|
| accent · researcher | `#4A9EFF` | `\x1b[38;5;39m` | matches editor accent | `#4A9EFF` brand | `chalk.hex('#4A9EFF')` |
| accent · engineer | `#4ADE80` | `\x1b[38;5;41m` | (same) | (same) | `chalk.hex('#4ADE80')` |
| accent · reviewer | `#F59E0B` | `\x1b[38;5;208m` | (same) | (same) | `chalk.hex('#F59E0B')` |
| accent · coach | `#E879F9` | `\x1b[38;5;207m` | (same) | (same) | `chalk.hex('#E879F9')` |
| accent · operator | `#94A3B8` | `\x1b[38;5;247m` | (same) | (same) | `chalk.hex('#94A3B8')` |
| bg-base (dark) | `#0F0F0F` | (terminal default) | `--vscode-editor-background` | (light only) | (terminal default) |
| text-primary (dark) | `#E8E8E6` | `\x1b[38;5;253m` | `--vscode-foreground` | `#1A1A1A` | (terminal default) |
| mono | `Geist Mono` | (terminal mono font) | `editor.fontFamily` | `monospace` fallback | (terminal default) |

### Per-surface notes

- **CLI:** colorless by default. Apply `--accent` only via `chalk` for personality-tagged log lines and tool chips.
- **TUI (Ink):** `<Text color="#4A9EFF">` syntax in Ink wraps to ANSI escape codes. Generative marks render as 4×4 unicode block-character grids.
- **VS Code extension:** uses `--vscode-*` tokens for chrome (so VS Code's user theme stays consistent). Per-personality accent only on personality-specific affordances (chat header stripe, tool chip icon).
- **Email digests:** light mode only (most email clients render dark mode poorly). Single brand accent (`#4A9EFF`) — no per-personality fingerprint in digests because they aggregate across personalities.
- **Web UI:** the full system; this file's primary consumer. Applied via Antd `ConfigProvider` theme tokens, see `apps/web/src/lib/theme.ts`.

## Voice (UI copy)

Honest, terminal-adjacent. No marketing copy. No "Welcome to Ethos!" / "Unlock the power of AI." No emoji as design elements (✓/✗/⏳ are status indicators, not decoration).

- Empty states are practical: "No skills installed. Try `claude/code-review` from ClawHub." Never "Looks like you don't have any skills yet! 🚀"
- Errors are concrete: "API key invalid — re-enter to continue." Never "Oops, something went wrong!"
- Buttons are verbs: "Send", "Approve", "Deny", "Schedule". Never "Get Started" or "Click Here".

## Anti-slop rules (the rules that keep the system honest)

The web UI specifically must avoid these patterns. Code review checks for them.

| Pattern | Why it's slop | Replacement |
|---|---|---|
| Purple/violet/indigo gradients | Default AI-generated app | Per-personality accent, solid colors only |
| 3-column feature grid with icons in colored circles | The most recognizable AI-template layout | Stacked rows with sample content |
| Centered everything with uniform spacing | Marketing-template feel | Left-aligned, asymmetric where appropriate |
| Bubbly border-radius on every element | Toy-app feel | Hierarchical scale (4/8/14/full) |
| Decorative blobs, floating circles, wavy SVG dividers | Filler | Empty space; let typography lead |
| Emoji as design elements | Lazy decoration | Status icons (✓/✗/⏳) only, never decorative |
| Colored left-border on cards | "We have to differentiate cards somehow" | Cards earn existence; differentiate via content |
| `system-ui` / `-apple-system` as primary display font | "I gave up on typography" signal | Geist + Geist Mono |
| Generic hero copy | Indistinguishable from every SaaS site | Specific, in-product language |
| Hover states that change layout | Layout thrash | `prefers-reduced-motion` honored; only opacity/color/transform |

## Implementation notes

- **Web:** All tokens applied via Antd `ConfigProvider` theme — `apps/web/src/lib/theme.ts`. Per-personality accent swap happens at the chat tab level via a second `<ConfigProvider>` wrapper.
- **TUI:** Tokens consumed via the existing Ink components — extend `apps/tui/src/components/StatusBar.tsx` to emit personality-accent ANSI codes when displaying the active personality.
- **VS Code:** Uses the user's theme; only personality affordances get our accents. Webview CSS uses `var(--vscode-*)` for chrome; our `--accent` for chat-specific elements.

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-26 | Initial design system created | `/design-consultation` run after `/plan-design-review` (Phase 26), `/plan-ceo-review` (Phase 26), and `/plan-eng-review` (Phase 26). Memorable thing: "the agent team is present." |
| 2026-04-26 | Geist + Geist Mono | Dev-tool standard. Self-hosted via npm `geist` (local-first respects local-first ethos). |
| 2026-04-26 | Dark mode primary, light supported | Terminal-adjacent users live in dark mode. Light is read-only-mostly support. |
| 2026-04-26 | Per-personality accent system | Distinguishing wedge vs anonymous chatbots. The chat tab fingerprint changes per active agent. |
| 2026-04-26 | Generative SVG marks (5×5 mirror-symmetric, hash from personality ID) | Every personality gets identity from creation, no asset pipeline, custom personalities included. |
| 2026-04-26 | "Cards earn existence" rule | Most SaaS uses Card by default. Ethos uses raw layout. Reserves Card for skill rows + cron rows. Looks denser, more terminal-honest. |
| 2026-04-26 | Approval modal anchored to personality bar | The agent itself is asking permission, so the modal slides down from where the agent's face lives. Distinct from centered-modal default. |
| 2026-04-26 | Single easing `cubic-bezier(0.16, 1, 0.3, 1)`, no springs | Reinforces honesty/utility — no marketing-app whoosh. |
| 2026-04-26 | Cross-surface token mapping defined | Web/TUI/VS Code/email/CLI consume the same tokens, surface-specific render. Single source of truth survives surface additions. |
