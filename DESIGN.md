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
| `--text-secondary` | `#9A9A98` | `#585857` | De-emphasized text. Contrast 6.80:1 / 6.81:1 |
| `--text-tertiary` | `#7E7E7D` | `#70706B` | Muted, captions, section labels. Contrast 4.72:1 / 4.76:1 — WCAG AA for normal text, because the feedback contract puts durations here at 13px |

### Per-personality accent (the load-bearing identity affordance)

The chat tab swaps the accent per active personality two ways at once, from one
resolver (`personalityAccent` in `apps/web/src/lib/theme.ts`): a second
`<ConfigProvider>` carries it as Antd's `colorPrimary`, and the element that
provider wraps carries it as `--accent`. Both are needed — a `ConfigProvider`
renders no DOM node, so raw CSS cannot read a variable off it. In Call Stage the
same element carries the call's accent instead, which is the personality's unless
`display.call_accent` pins a hex.

Accent flows through:

| Flow | Where it lives |
|---|---|
| Personality bar accent stripe (3px tall) | `PersonalityBar.tsx`, inline `background` |
| Composer caret color | `input, textarea { caret-color: var(--accent, …) }` |
| Send button background (and its hover, which brightens the accent rather than naming a second blue) | `.composer-send-btn` |
| Focus ring (`outline: 2px solid var(--accent); outline-offset: 1px`) | 17 `:focus-visible` rules in `styles.css` |
| Link color in agent text | `.message-assistant a` |

The rule survives; its premise does not. The previous statement of this rule held
because "the rail is outside the personality subtree" — true only while a single
flat sidebar was the entire chrome. The two-altitude IA (`◎` Library / per-agent
Workspace) introduces a contextual column that **is** the personality subtree, so
the rule is restated by scope rather than by widget:

**Global chrome stays neutral; scoped chrome carries the scope's identity.** The
altitude rail is global chrome and keeps `--ethos-info` forever. The contextual
column and the stage carry the active scope's accent. The furniture moves only
when you have walked into a different room.

**Team chrome is neutral**, because a team's identity is plural. The team panes
(Overview, Board, Structure, Memory, Activity, Channels, Settings) run on
`--ethos-info` like the Library. Inside a team, a member's workspace
(`/t/:teamId/p/:id/*`) carries that member's accent exactly as `/p/:id/*` does. The
team **Chat** pane carries the coordinator's accent, because it is the coordinator's
surface. The rail stays neutral at every altitude.

| Personality | Hex | Reasoning |
|---|---|---|
| researcher | `#4A9EFF` | Blue — knowledge, exploration |
| engineer | `#4ADE80` | Green — making, building |
| reviewer | `#F59E0B` | Amber — caution, judgment |
| coach | `#E879F9` | Magenta — encouragement, clarity |
| operator | `#94A3B8` | Grey — operational, neutral |

### Runner accent (a foreign process is not a personality)

A **runner** is an external coding harness Ethos delegates a job to — Pi today,
another harness later. It gets an accent for the same reason a personality does:
you have to be able to tell at a glance whose work you are looking at. It does
**not** get a personality accent, and it is not a sixth row in the table above.
The table is the roster of agents that live here; a runner is a process Ethos
handed work to, and blurring the two would say the wrong thing about what Pi is.

| Runner | Dark | Light | Reasoning |
|---|---|---|---|
| pi | `#2DD4BF` | `#0D9488` | Teal — outside the five personality hues and outside the semantic four, so it can never be read as an agent's identity or as a status signal |

Two rules, both load-bearing:

1. **Runner identity is data, not CSS.** Every runner accent, label, and badge
   string is consumed through a single `RUNNERS` identity map
   (`{id, label, accent, badgeText}`, `apps/web/src/lib/runners.ts`). No
   component hardcodes a runner's hex, its badge text, or the literal `pi` — a
   second harness must be a map entry, never a diff across the render tree. Copy
   is templated on `{runner}`.
2. **A runner accent is not an `--accent`.** The per-personality accent swap
   (above) is unaffected: a delegated run's chrome carries the runner's hue
   *within the run's own surface*, and the surrounding scope keeps the
   personality's. The two never trade places.

### Semantic colors

Used **only** to signal status, never as decoration. Always paired with an icon — never color alone.

A semantic colour is tuned to the ground it sits on, so it has a dark and a
light value. A personality accent does **not** — an identity hue is the same
hue in both skins. Where a dark semantic and an accent share a hex they are
still two different tokens that happen to agree on the primary skin: `--warning`
is not the reviewer accent, and retuning one must never move the other.

| Token | Dark | Light | Usage |
|---|---|---|---|
| `--success` | `#4ADE80` | `#177D3C` | Success states, completed tools. Dark value coincides with the engineer accent; the light value does not |
| `--warning` | `#F59E0B` | `#986206` | Pending review, soft warnings. Dark value coincides with the reviewer accent; the light value does not |
| `--error` | `#F87171` | `#CE2C2C` | Distinct red, never a personality color — failures, rejections |
| `--info` | `#4A9EFF` | `#4A9EFF` | Informational tags, neutral notifications. The one semantic that does not retune: it is the researcher hue and the permanent altitude-rail blue, so it moves only as an accent decision |

Light values keep their dark counterpart's hue and drop lightness until the
pair clears WCAG AA on `--bg-base` (4.98 / 4.92 / 4.99:1); red also eases its
saturation so a 5:1 red reads as brick rather than siren beside the ochre and
the forest green. `--info` on paper-warm is 2.63:1 and is a known shortfall —
see the 2026-09-04 decisions-log row.

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
  - `sm: 4px` — buttons, chips, tight UI chrome (NOT chat bubbles)
  - `md: 8px` — cards, modals, surface containers
  - `lg: 14px` — drawers, large surfaces
  - `full: 9999px` — pills, status dots, only on circular elements

### "Cards earn existence" rule

The `Card` primitive is reserved. It appears **only** on:
- Skill rows (Skills tab)
- Cron job rows (Cron tab)
- Task tiles (Teams Control Center board)

Everything else uses raw layout primitives. Tool chips are inline rows. Drawer streams are dense lists. Onboarding personality picker is stacked rows. No card grids anywhere.

The rule governs the `Card` **primitive**, not the word "card". A bordered
container assembled from raw primitives is not an exemption and never needed
one — `ClarifyCard`, the composer, and `CallStrip` are all built that way. The
three exemptions above share a property that is the actual test: each is a
**repeated list unit** whose alternative was a dense row, and each was granted
because the unit did not fit the row. A one-off container inline in a stream has
no dense-row alternative to be measured against, so there is nothing for an
exemption to buy — build it from primitives. The team Overview's attention tiles are
the Task tile exemption reused, not a new one; structure-canvas nodes, scope-switcher
rows and supervisor-ledger rows are bordered containers assembled from primitives.

#### The one approved card grid: the Recipes gallery

`apps/web/src/pages/Recipes.tsx` renders its catalog as a **card grid**, which
"No card grids anywhere" above otherwise forbids. It was first built as stacked
rows for exactly that reason; the user reviewed both that page and a clickable
card-grid prototype and asked for the grid on **2026-09-04**. This paragraph is
the record of that approval, per this file's own "do not deviate without
explicit user approval".

Scope, so this does not spread: it covers **the Recipes gallery and nothing
else**. It is not a precedent for other catalogs (Skills, MCP, Plugins,
Personalities and Dashboards are unaffected), and it is not a fourth `Card`
**primitive** exemption — the cards are assembled from raw primitives and each
one is a real `<Link>`, so the Antd `Card` primitive is still unused on that
page. Any other surface wanting a card grid needs its own approval, recorded
here the same way.

## Chat surface

### User message bubbles
`border-radius: 12px 12px 4px 12px` — top-heavy asymmetric radius (conversational, not boxy). The `sm` (4px) token is for chips and buttons only; never use it on chat bubbles.

Background: `var(--bg-overlay)`. Padding: `10px 16px`. Max-width: 75%.

### Composer
The composer is a **unified bordered card** — not a bare textarea with a button beside it.

- Container: `border: 1px solid var(--border-strong); border-radius: 12px; background: var(--bg-elevated); padding: 10px 10px 10px 16px;`
- Send button: icon-only circular button (32px diameter, `border-radius: 9999px`, `background: var(--accent)`). Arrow SVG icon. No text label. Disabled state: `background: var(--bg-overlay)`.
- The `border-top` line separator above the composer is removed — the card container provides visual separation.

### Feedback & activity
The user always sees what the agent is doing and what it did; the answer itself is never interrupted by machinery; every request is visibly acknowledged within the first second.

1. **The answer is content only.** An assistant bubble holds text, images, HTML, PDF, cards and the delegated-run card — things the agent made *for* the reader. It never holds tool chips, badges, pills or status. (`tool` blocks stop being appended to `turn.blocks`.)
2. **The status line** sits directly above the composer, inside the 800px column, in a **reserved slot** from the moment a message is sent until the turn's footer replaces it, so nothing moves. Geist Mono 13px `--text-secondary`; the accent dot steady for `received` and `thinking`, pulsing for a running tool; elapsed time in `--text-tertiary` tabular numerals. Phases: `received` (on send, before any event) → `thinking` → `{tool} · {argsPreview}` → `writing` (elapsed only — the words are the feedback). After 20 s without an event it appends `⚠ still working` (`--warning`, glyph + word). It is a `role="status"` `aria-live="polite"` region, announcing on send and on each tool change, throttled to one announcement per 2 s.
3. **The trail** is one collapsed footer line under the bubble, in the same slot the status line vacated: `✓ 4 actions · ⚠ 2 unverified · 12.4s ▸` (`<button aria-expanded>`, Geist Mono 13px `--text-secondary`, durations `--text-tertiary`). Expanded, it is the drawer's dense rows: glyph + word (✓ ok / ✗ failed / ⚠ unverified — never colour alone), tool name in mono, one-line args, duration right-aligned tabular; 28px rows, `sm` radius hover tint `--ethos-hover`. An aborted turn ends with `✗ stopped · 2 actions`. Zero actions → no footer. Zero findings → no "verified" (fail-open must not fabricate assurance).
4. **One trail, two renderers.** A per-turn `trail` structure in the chat reducer is derived from live `tool_start`/`tool_end`/`tool_progress` *and* from persisted tool messages on history load. The footer renders `trail[turnId]`; the drawer renders the same trails grouped by turn (a header row: relative time + the first words of the user message). They cannot disagree, and yesterday's replies have trails (durations show `—` when history lacks them).
5. **Findings are trail rows.** A grounding finding, a blocked-page hint, a profile-fallback warning: `⚠` + the word, the claim quoted in mono, the evidence in `--text-secondary`; the row is a button that focuses the tool row it cites. In `correct` mode the next reply's first paragraph is preceded by one mono label `correction · re: "tests pass"` — the only chrome.
6. **Feedback rows outside chat.** Any action a page takes — a backup, a probe, an install stage, an observe heartbeat — is a row: glyph + word, mono subject, mono timestamp or duration, result text. The same row the trail uses. Persistent, never a toast; outcomes resolve the row in place, they do not remove it.
7. **Nothing vanishes.** A waiting card (clarify, takeover) resolves to a row stating the outcome; it never disappears. (Call Stage lesson, 2026-08-14.)

### Empty chat state
When `messages.length === 0` and no turn is active, the chat surface shows a centered empty state (not a placeholder sentence):
- 48px PersonalityMark SVG
- Personality name (16px, 500 weight)
- Model in monospace (13px, secondary)
- "Ready to help." (14px, secondary) — no marketing copy
- 2×2 suggestion pill grid: `border: 1px solid var(--border); border-radius: 9999px; padding: 8px 20px; background: var(--bg-elevated)`. Each pill pre-fills the composer on click.
- Suggestion sets are per-personality — see `apps/web/src/components/chat/MessageList.tsx` for the full set.

### Connection status indicator
Three-state dot (8px circle, `border-radius: 9999px`):
- **Connected**: `#4ADE80` (solid)
- **Connecting**: `#F59E0B` (pulsing — reuse `thinking-bounce` keyframe)
- **Offline**: `#F87171` (solid)

Web surface: rendered in TopBar right-hand side alongside `{provider} · {model}` mono label.
Desktop surface: rendered in sidebar bottom as an 8px dot inside a 20px glow ring (`border: 1.5px solid rgba(74,222,128,0.4)`).

**Extended for a microphone (SatelliteRow, voice V3).** A wake satellite has
states a websocket does not, so the same `.sb-dot` base gains three modifiers
rather than a second dot being drawn:

- **Listening**: `#4ADE80` (solid) + three CSS liveness bars. The bars are a
  cue, not a meter — the node protocol carries no amplitude, and inventing
  levels would be the dishonest version of "the mic is armed".
- **Speaking**: `var(--accent)` (pulsing) — the same "the agent has the floor"
  vocabulary as the CallStrip.
- **Muted**: `--text-tertiary` (solid).
- **Wake off**: **hollow** — transparent fill, 1.5px `--text-tertiary` ring.
  Hollow rather than a second grey because wake-off is *persisted* and muted is
  momentary, and the indicator-honesty rule is worthless if the two look alike.
- **Degraded**: `#F87171` (solid), with the failing probe named inline.

`prefers-reduced-motion` stops the pulse and the bars; the bars hold their
tallest height so the row still reads as armed.

### Personality bar

The bar at the top of the chat tab is **identity, read-only**: accent stripe,
mark, name, model. It carries no control that changes which personality the
conversation is with, because a session belongs to the personality it started
with. The two controls it does carry act on the session, not on identity —
rename, and `+` to start a new one (which is where a personality gets chosen,
via the New Session picker). The same rule holds everywhere in the web UI: the
command palette offers no "switch personality" verb, and a `?personality=`
deep-link is honoured only alongside `new=1`.

### Call Stage

Talk-mode's primary surface is a **mode, not a dialog**. Starting a call switches
the Chat page **into** Call Stage; ending the call returns it to normal chat.
Nothing floats over the conversation, because while a call is carrying audio the
call *is* the conversation. This reverses the earlier "no new full-screen
surface" line: a call is not a status cue, and a 10px dot is not enough surface
to carry three continuously-changing states.

**Two** columns, filling the chat tab:

| Column | Width | What it holds |
|---|---|---|
| Stage | flexible | The shape on canvas, the personality's name, the mono state word, mute + end, and a Geist Mono `{provider} · {model} · NNNms` footer. |
| This call | 320px | **This call's** turns, newest last — not chat history. A header reading `This call` plus the **Back to chat** control. At its base, the reserved clarify slot. |

**There is no left navigation rail, and that is the decision.** A rail is an
invitation to move around the UI, and moving around the UI mid-sentence is
exactly what a call cannot afford. The only column worth looking away to is the
one that says what is happening in *this* call. Nothing else earns a column.

The PersonalityBar is **not** rendered in this mode either, for the same reason:
rename and new-session are the wrong things to offer someone who is
talking. Identity is carried by the stage itself — the accent-coloured shape
holding the personality's initial, and the name beneath it.

Below 760px the transcript's turns and clarify slot drop, as before. The column
itself does **not**: it now carries the only exit that is not a hang-up, so it
collapses to its header row and restacks under the stage — one line holding
`This call` and a 44px `Back to chat`. The controls and the way back to text are
never what gets cut.

**Enter and exit are automatic and derived from the CALL, never from the drawn
state** (`callStageMounted`). A live call is the mode through every status it
passes through, including `connecting` and `reconnecting`. Degraded, mic-denied
and ended return to normal chat, where the CallStrip carries the explanation and
the way to act on it. The only manual exit is **Back to chat**, a single small
text button in the transcript header — not a rail, not a second mechanism. It
collapses the mode without hanging up: the Reconnecting row below promises the
composer stays usable for text, and in a mode this is what keeps that promise.
Only hang-up and `Esc` end a call.

#### The reserved clarify slot

The slot sits at the base of the transcript column for the whole call — dimmed,
reading `No open question`, when there is nothing to answer — and a mid-turn
`clarify` **fills it in place**. A reserved slot rather than a popup, because
things appearing and disappearing mid-call read as instability, and attention
for a surface that just moved is the one thing a person on a call cannot spare.
The slot holds its own height and does not flex; the scrolling turn list above
absorbs the difference, so filling it moves nothing on screen.

Off-call the clarify card is unchanged: it still floats over Chat as an
`alertdialog`. Both are the same component and resolve through the same
`clarify.respond` / `clarify.resolved` path — in the slot it is a labelled
region, not an alert, because nothing was interrupted by its arrival.

Three treatments, all driven by the same amplitude signal:

| Treatment | Value | What it is |
|---|---|---|
| Liquid | `liquid` | The personality circle fills like a vessel; the surface is two summed sines, so it reads as liquid rather than a progress bar. |
| Orb | `orb` | A radial-gradient body whose rim deforms with amplitude. |
| Rings | `rings` | Three concentric rings breathing outward from a solid core. |

**Which one a call draws is the personality's, not the app's.** The shape is
identity — the same argument the accent already won — so a personality declares
it as `voice.call_style`, edited in its Identity step next to the voice fields.
It is optional and there is no "unset" look: an undeclared personality gets a
treatment derived from its id, deterministically, so a fresh install already
shows five agents that do not look alike. `display.call_style` sits between the
two for operators who want one shape everywhere; its default, `personality`, is
not a pin. The order is one function — `resolveCallTreatment` in
`packages/types/src/personality.ts`:

1. the personality's `voice.call_style`
2. `display.call_style`, when it names a concrete treatment
3. derived from the personality id

Color is `display.call_accent`: `personality` (default — follows the active
personality's accent, so the shape says *which* agent holds the floor) or an
explicit hex. `display.call_style` and `display.call_accent` are edited in
Settings → Voice → Call appearance. Nothing else about the stage is
configurable — the motion constants are fixed in code.

#### Motion class: continuous amplitude-driven motion

This is a **new motion category**, and the first one added to this system. The
scale below (80 / 180 / 240ms, "no bounces or springs") describes *state
transitions*: something changes, the change takes a fixed time, the motion ends.
A duplex call has no such moment to animate. What the listener needs — is it
hearing me, is it working, is it talking — is true continuously and has to be
shown continuously, so the shape is driven by an audio amplitude signal for as
long as the call is up. The transition scale still governs everything else about
the stage (entering the mode, hover, focus ring).

The motion constants — smoothing, gain, travel, wave speed, glow, orbit rate —
are **fixed in code**, not exposed: `CALL_MOTION` in
`apps/web/src/features/voice/call-motion.ts`.

#### States

| State | What the user sees |
|---|---|
| Listening | The shape in `--error` red — the live-mic vocabulary the composer's `AudioBars` already uses. Amplitude is the mic level. |
| Thinking | **Amplitude-independent** — nobody is talking. The circle contracts to 84%, a comet arc orbits it, and a slow 0.5Hz breath keeps the shape alive at rest. Accent-colored. |
| Speaking | Accent-colored, amplitude driven by the agent's own output level (an analyser on the playout graph). |
| Connecting / Reconnecting | Rendered **inside** the stage, not instead of it: the Thinking shape (busy, accent, amplitude-independent — nobody is talking) with the mono state word reading `connecting` / `reconnecting…`. The stage is mounted by the call, never by the state — unmounting it for a status a live call passes through replays the 240ms entrance and restarts the canvas, which the user reads as the whole surface flickering out and back between turns. Text stays reachable throughout via **Back to chat**. |
| Degraded / Mic-denied / Ended | The mode ends, Chat returns to normal, and the CallStrip takes over. These are the states where what the user needs is the explanation and a way to act on it, and the strip is what carries both. |

`prefers-reduced-motion`: the comet collapses to a **static ring** — no orbit, no
wave, no glow, and the amplitude smoothing drops out so nothing drifts after the
signal stops. State stays legible without a frame of motion: the color, the
contraction and the mono state word carry it.

Controls are ≥44px touch targets. The provider label stays Geist Mono
`{provider} · {model}`, the same vocabulary as the TopBar and the strip.

### CallStrip

What normal chat shows for a call: the form the Call Stage collapses to, and the
only form for the states that are not carrying audio (degraded, mic-denied, a
call that ended with something left to explain). One slim strip on Chat —
**rows, never the `Card` primitive**.
Nine states, all in existing vocabulary:

| State | What the user sees |
|---|---|
| Idle / entry | No strip. 16px stroke mic glyph in the composer card next to send; "Try voice" pill in the empty-chat grid. |
| Connecting | 10px amber (`--warning`) dot pulsing via `status-dot-pulse` + `connecting` in Geist Mono. |
| Listening | Red `AudioBars` mic meter. |
| Thinking | The accent dot **steady** — the personality has the floor but is not talking yet. |
| Agent speaking | The same 10px accent dot **pulsing** + the live caption line in `--text-secondary`. |
| Barge-in acknowledged | Caption truncates; one `--motion-default` accent flash; the line stays in the transcript marked `[interrupted]`. |
| Reconnecting | Amber dot + `reconnecting…`; the composer stays usable for text. |
| Degraded to text | The strip collapses to a dismissible inline **row**: "Voice unavailable — provider X failed; continuing in text." |
| Mic permission denied | An inline row with the browser's re-grant path. Never a dead mic icon. |

The provider that served the turn and its latency render as **Geist Mono
`{provider} · {model}` + `NNNms`** — the same label vocabulary as the TopBar.
Not a badge, not a debug panel. The per-stage breakdown sits behind an
expandable toggle, collapsed by default.

Controls are ≥44px touch targets; `prefers-reduced-motion` stops every pulse and
the barge-in flash. At 375px the mark, state and mute/end persist and the mono
detail collapses behind the toggle's tap.

While a call is carrying audio the strip also carries the control that returns to
the Call Stage — collapse and restore are the same call, not two surfaces.

## Sidebar

### Icons
Every nav item **must** carry a 16px stroke SVG icon (`stroke="currentColor"`, `strokeWidth="1.5"`, `fill="none"`). Text-only nav is forbidden — the collapsed/icon-only rail must remain navigable. No emoji as nav icons.

Icon assignments:

| Route | Icon description |
|---|---|
| Chat | Speech bubble (rounded rect + tail at bottom-left) |
| Sessions | List with leading dots (3 rows) |
| Personalities | Person silhouette (circle head + arc shoulders) |
| Skills | Lightning bolt / zap |
| Memory | Brain (rounded irregular organic shape) |
| Activity | Bar chart (3 ascending vertical bars) |
| Cron | Clock (circle + hour/minute hands) |
| Communications | Envelope |
| Mesh | Three circles connected by lines |
| Teams | Two person silhouettes |
| Platforms | Globe / world outline |
| MCP | Hexagon with connecting lines |
| Batch | Stack of documents |
| Eval | Checkmark in a box |
| Plugins | Plug (rectangle + 2 prongs) |
| Settings | Gear / cog (circle + teeth) |
| Overview | House (roof + walls) |
| Structure | Three circles linked by lines (one above two) |
| Channels | Envelope (same glyph as Communications) |
| Board | Three vertical bars (same glyph as Kanban) |

### Active state
`background: rgba(74,158,255,0.18); border-left: 2px solid #4A9EFF; padding-left: 10px` (compensate padding for the 2px border). Text color: `var(--text-primary)` (full brightness — not dimmed blue).

Previous spec of 12% opacity was too low to read; 18% is the correct value.

### Section dividers
Nav group separators are **thin lines** (`height: 1px; background: var(--border); margin: 4px 12px`) rather than uppercase label text. Retain group labels but reduce to `opacity: 0.35` and remove `text-transform: uppercase` — they become structural hints, not headings.

### Desktop icon-only rail
Desktop sidebar is 64px wide and always icon-only. Active state uses background + a 2px × 16px rounded bar flush to the left edge (not a full left-border since there's no label text to offset against).

### Teams (third altitude)

A team is a scope beside Library and Workspace, not a page inside the Library. It
keeps the rail and gets its own contextual column. The column's rows, in order:

1. **Chat** — with a `via <coordinator>` hint in Geist Mono 11px beside a 12px mark
2. divider
3. **Overview**, **Board**, **Structure**, **Memory**, **Activity**, **Channels**, **Settings**
4. divider
5. `RECENT IN <TEAM>` — the recent-sessions block filtered to the team's members

The breadcrumb reads `<ring> <team> ▾ / <pane>`. The `▾` on the team name is the
**scope switcher**, and it is the breadcrumb root at every altitude: Independent
(the Library and per-agent workspaces), each team, and New team. Team chrome is
neutral (see "Per-personality accent"); the segmented ring is the team mark (see
"Personality marks → Altitude convention").

## Interaction states

### Hover / pressed tints
All hover and pressed backgrounds use **CSS variables** (not hardcoded `rgba(255,255,255,...)` values, which break in light mode):

| Variable | Dark value | Light value |
|---|---|---|
| `--ethos-hover` | `rgba(255,255,255,0.07)` | `rgba(0,0,0,0.05)` |
| `--ethos-pressed` | `rgba(255,255,255,0.12)` | `rgba(0,0,0,0.09)` |
| `--ethos-surface-tint` | `rgba(255,255,255,0.04)` | `rgba(0,0,0,0.03)` |
| `--ethos-shadow-overlay` | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.12)` |

These are emitted by `tokensToCssVariables()` in `packages/design-tokens/src/antd.ts` using `isLightSurface()` to branch. **Never hardcode white-alpha tints in CSS** — always use the variable so skins work correctly.

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

One exception to the scale, not to the preference: the Call Stage's
**continuous amplitude-driven motion** (see "Call Stage") is not a state
transition and has no duration token. It still stops under
`prefers-reduced-motion`, and it is the only place in the system allowed to move
without a transition.

## Personality marks (generative SVG)

Deterministic geometric marks per personality. Same algorithm runs at render time on every surface — no asset pipeline, no PNG bundle.

**Algorithm:**
1. Hash personality `id` (FNV-1a 32-bit)
2. 5×5 grid, mirror-symmetric (cells `[0..2]` mirrored to `[3..4]`)
3. Each cell filled based on a bit from the hash; opacity 0.55–0.93 from next 2 bits
4. Background: circular frame — a `<circle>` at accent color `0x22` alpha, plus a 1.5px accent ring stroke at ~0.55 opacity around the circumference (strokeWidth scales: `size * 0.04`, minimum 1). Cells are clipped to the circle via `<clipPath>`. Echoes the circular ring logo (`logo.svg` annulus).
5. Filled cells: solid accent at the computed opacity

**Altitude convention:** the Ethos annulus (`apps/desktop/assets/brand/ethos-mark.svg`)
marks the machine altitude — the Library, not any single agent. Agents get generative
marks (this algorithm, per personality); Ethos gets the ring. A team gets a
**segmented ring** — one arc per member, in that member's accent, in manifest order
starting at 12 o'clock, with a faint neutral fill inside. It is built from the members,
so it is neither a generative mark (an agent) nor the annulus (the machine). Three
marks, three altitudes; none inherits another: a personality does not inherit the
annulus, the machine altitude does not generate a mark, and a team's ring is assembled
from its members, not hashed from an id.

The segmented ring renders at 14px (breadcrumb), 18px (switcher rows), 22–30px
(column identity, rail) and 36px (team Overview). Arc stroke width is
`max(1.5, size * 0.09)`; the gap between arcs is `min(3px, 18% of an arc)`. Same
algorithm on every surface. TUI fallback: `◔ ◑ ◕ ●` by member count. Reference
implementation in `apps/web/src/components/ui/TeamRing.tsx`, with the algorithm twin
in `packages/web-contracts/src/marks.ts`.

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

- **Web:** All tokens applied via Antd `ConfigProvider` theme — `apps/web/src/lib/theme.ts`. Per-personality accent swap happens at the workspace subtree level via a second `<ConfigProvider>` wrapper.
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
| 2026-05-11 | Task tile is the third Card-primitive exemption | Plan B Control Center boards need a tile primitive — id + title + priority + assignee mark + child progress + status action row don't fit a dense list row. Same rationale as Skill / Cron exemptions: the card IS the unit of work, not decoration. Tied to the kanban primitive (`extensions/kanban-store`) and `apps/web/src/pages/TeamControlCenter.tsx`. |
| 2026-05-29 | User bubble radius → `12px 12px 4px 12px` | sm (4px) made bubbles look like table cells. Asymmetric top-heavy radius reads as conversational. |
| 2026-05-29 | Composer unified card | Bare textarea + text "Send" button reads as a form. Unified bordered container + circular icon send button. |
| 2026-05-29 | Sidebar active state → 18% blue + 2px left border | Previous 12% bg was imperceptible. 18% + border gives clear "you are here" signal. |
| 2026-05-29 | Sidebar icons mandatory | Collapsed state (64px desktop rail) is unusable without icons. Text-only nav forbidden. |
| 2026-05-29 | Hover/pressed as CSS variables | Hardcoded `rgba(255,255,255,...)` tints are invisible in light mode. Variables flip correctly per skin. |
| 2026-05-29 | Connection status dot | Text-only "connecting…" has no visual salience. Three-state colored dot (green/amber/red) is scannable. |
| 2026-05-29 | Empty chat state with suggestion pills | "Start the conversation." placeholder is undesigned. Personality mark + pills sets context and invites the first message. |
| 2026-06-11 | Personality marks → circular frame (accent ring + circle-clipped cells) | New circular ring logo; marks follow the logo's geometry. User-directed. Docs `PersonalityMark` updated; `apps/web/src/components/ui/PersonalityMark.tsx` and `packages/web-contracts/src/marks.ts` are follow-ups to keep cross-surface parity. |
| 2026-07-16 | Docs landing page: personality icon → annulus ring (logo geometry); landing shows 3 specialists with cross-provider model routing | User-directed during landing-page 3D redesign (hero-demos hybrid). Scope: docs landing page; app surfaces still use the generative grid mark pending a follow-up decision. |
| 2026-07-19 | In-call speaking indicator (talk-mode) | Phase B browser talk-mode needs a "who's speaking" cue. Reuses `AudioBars` for the user mic and an accent `status-dot-pulse` dot for the agent — accent, not a semantic color, so the cue reads as personality identity. No new primitives. |
| 2026-08-12 | CallStrip added to the component inventory (voice V1a, DR3) | Talk-mode's nine states needed one home. A slim strip of ROWS on Chat, not a new surface and not a `Card`; the thinking state is the existing accent dot held steady, connecting/reconnecting borrows the amber connection dot, and provider + latency reuse the `{provider} · {model}` mono label rather than a badge or debug panel. |
| 2026-08-13 | Call overlay supersedes the 2026-07-19 "In-call speaking indicator" entry | A 10px pulsing dot cannot express three continuously-changing states, so the call gets a non-blocking centered overlay (three treatments, amplitude-driven) that minimizes to the strip rather than ending the call. Adds one new motion class — continuous amplitude-driven motion — because the 80/180/240ms transition scale has no way to express a duplex call's need for continuous feedback. The strip keeps every state that is not carrying audio. |
| 2026-08-14 | Call Stage supersedes the 2026-08-13 "Call overlay" entry | The user rejected the centered dialog: things appearing and disappearing mid-call read as instability. A call is now a MODE — Chat switches into a **two-column** stage (shape, this call's transcript) and returns to normal chat when the call ends. There is no left rail and no PersonalityBar: a navigation column mid-call invites wandering around the UI mid-sentence, and rename/fork/new-session are the wrong controls to offer someone who is talking. The one way back to the composer without hanging up is a single small **Back to chat** text button in the transcript header — the same collapse the strip's restore control reverses. The clarify question gets a reserved slot in the transcript column that is always on screen and fills in place, instead of a card that arrives over the conversation. Everything the overlay entry decided about the SHAPE — three treatments, the amplitude motion class, the per-state colour rules, mounting by the call rather than the state — carries over unchanged; only the container was wrong. |
| 2026-08-14 | `--accent` is defined, and the call treatment is the personality's | Two halves of one correction. (1) `--accent` was READ 19 times across `styles.css` and defined NOWHERE, so every per-personality colour in raw CSS silently rendered the generic info blue — Antd primitives tinted, the CSS around them did not. It is now stamped on the chat subtree's own element from the same resolver `personalityTheme` uses, and `CallStage`'s local copy was removed so there is exactly one definition. (2) The call treatment moved from an app-wide `display.call_style` to `voice.call_style` on the personality, defaulting to a shape DERIVED from the personality id — every agent looks distinct with nothing configured, and the operator key becomes a pin rather than the source. Owner's doctrine: a personality is not just its tools and plugins, it is also how it looks and feels. |
| 2026-08-14 | `WakeRouteRow` and `SatelliteRow` added to the component inventory (voice V3, DR3) | Wake routing needed two list surfaces and neither earns a `Card`: a routing table and a fleet of microphones are both things you scan for the one entry that is wrong, and a bordered box per entry turns scanning into reading. Both are dense rows in Settings → Voice (DR4 — no new sidebar item). Satellite liveness extends the existing connection dot rather than drawing a new one, adding listening / speaking / muted / **hollow** wake-off / degraded. Phrases, state words, node ids, capabilities and ages are Geist Mono, because every one of them is a literal the operator also sees in `ethos listen doctor` output or in `config.yaml`. The route editor's live phrase tester lights the matching row in that **personality's own accent** — the identity affordance is the proof, so you recognize the agent that answered rather than reading a generic highlight. |
| 2026-08-14 | A session is bound to the personality it started with; the in-chat switcher is removed | Owner's call: "A session belongs to a personality that joined this when session started. Then you can't switch." The dropdown in the personality bar is gone, along with the auto-fork-on-switch behaviour it needed and the command palette's "Switch personality →" verb. Identity stays fully visible — stripe, mark, name, model — it just isn't a control any more. Choosing an agent is part of STARTING a session: the New Session picker (`+` in the bar, "New chat session" in the palette) is the one entry point, and a `?personality=` deep-link now applies only with `new=1`. Forking a session is still offered where it belongs, in the Sessions tab. |
| 2026-08-15 | `CallRow` added to the component inventory (voice V4, DR3) | A call history is the purest case of the "cards earn existence" rule: you scan it for the one call that was refused or the one still ringing, and a bordered box per call turns scanning into reading. So calls are dense rows in Communications → Calls (DR4 — no new sidebar item), behind direction/state filter chips that narrow the SERVER query rather than a rendered array. A call in progress adds exactly ONE modifier to the connection dot — `--call-live`, accent because a live call belongs to the personality answering it, with a 2px accent ring (the `--matched` device) so it cannot be mistaken for a satellite's `--speaking` dot in a list that can show both; every other state reuses a modifier the vocabulary already has, and `refused` borrows **hollow** because a guard turning a caller away is a decision, not a fault. Numbers, durations, tiers, costs and state words are Geist Mono with `tabular-nums`, because each is a literal the operator also reads in `config.yaml`, the trunk console, or an invoice. The pulse stops under `prefers-reduced-motion`; the duration keeps ticking, because it is data, and a frozen clock on an open call is a lie rather than a courtesy. |
| 2026-08-16 | Sidebar accent rule restated by scope, not widget; per-personality accent swap moves to the workspace subtree; annulus marks the machine altitude | Personality-first-ui refactor (P0) splits chrome into two altitudes — Library (machine, `◎` annulus) and Workspace (per-agent, contextual column + stage). The 2026-04/05 rule ("the rail is outside the personality subtree") was conditional on a single flat sidebar being the only chrome; under two altitudes the contextual column **is** the personality subtree, so the rule survives restated: global chrome (the altitude rail) stays `--ethos-info` forever, scoped chrome (contextual column + stage) carries the active scope's accent, and it moves only when you walk into a different room. The `<ConfigProvider>` accent swap lifts accordingly, from the chat tab to the workspace subtree. Also recorded: the Ethos annulus (`apps/desktop/assets/brand/ethos-mark.svg`) marks the machine altitude; agents keep their generative marks — Ethos gets the ring, agents don't inherit it. Blocking amendment, landed before any code (constitutional decision, not implementation detail). |
| 2026-08-16 | Personality mark circular frame actually implemented; unknown-personality accents hash to a unique hue instead of bucketing into the 5 curated colors | Closes the gap between the 2026-06-11 circular-frame decision and the code, which still rendered a rounded square — `PersonalityMark.tsx` and `marks.ts` now draw a clipped circle with accent ring per spec. Also: `accentFor()` previously hashed unknown ids into the 5 curated `tokens.accents` values, guaranteeing collisions once a deployment has more than 5 personalities (this one has 9); it now derives a deterministic per-id hue (fixed S/L, shifted out of the purple/violet/indigo band) while the 5 curated built-ins keep their exact hex. |
| 2026-08-19 | New `display` identity block on `PersonalityConfig`, first field `display.avatar_url` | Personality avatars plan P0 (schema & governance). Follows the Phase 30.8 personality-presentation amendment: a personality's visual presence is identity, so a custom avatar image lands as a sub-key of an identity block (`display.avatar_url`, an optional string URL to a served or uploaded avatar image) parallel to `voice`, never as a new top-level `PersonalityConfig` field. Falls back to the existing generated mark (`PersonalityRingAvatar` / `PersonalityMark`) whenever unset or the image fails to load — no other rendering change in this phase. |
| 2026-08-20 | Runner accent `#2DD4BF` dark / `#0D9488` light — a sixth hue that is deliberately NOT a personality accent, consumed only through the `RUNNERS` identity map | Pi-delegation D19/D26. Ethos can now hand a job to an external coding harness, and the run has to be attributable on sight — but a runner is a foreign process, not an agent that lives here, and giving it a sixth row in the per-personality table would say it is one. So it gets its own subsection and a teal that sits outside both the five personality hues and the semantic four, where it can be mistaken for neither an identity nor a status. The consumption rule is the half that has to hold: accent, label, and badge text all come from one `RUNNERS` map (`{id, label, accent, badgeText}`, `apps/web/src/lib/runners.ts`), copy is templated `{runner}`, and no component hardcodes a hex or the literal `pi` — a second harness must be a map entry, not a diff across the render tree. The per-personality accent swap is untouched: a run's own surface carries the runner's hue, the scope around it keeps the personality's. Blocking amendment, landed before the run card (constitutional decision, not implementation detail). |
| 2026-08-20 | The delegated-run card is NOT a fourth "Cards earn existence" exemption | Ruled on while landing the runner accent, and recorded so it is not relitigated when the card gets built. The run card is heavy — header, task line, live `now` line, meta row, an 18-row collapsible detail grid, a nested question card, a button row — and "does it fit a dense row" answers *no*. But that is the wrong test for it, because the rule governs the `Card` **primitive**, not the word "card": `ClarifyCard`, the composer and `CallStrip` are all bordered containers of comparable weight built from raw primitives, and none of them needed an exemption. The three granted exemptions share a property the run card lacks — each is a **repeated list unit** measured against the dense row it replaced. The run card is a singleton inline in a transcript with no row alternative to lose to, and Antd's `Card` (title slot, `extra`, fixed body padding) buys it nothing it would not immediately override, while its state-varying border and warm blocked tint want explicit CSS anyway. So: built from primitives, and the surfaces that ARE lists stay lists — the drawer Runs pane and the Tasks page rows remain dense rows, which is where the rule was doing real work all along. |
| 2026-09-04 | The Recipes gallery is an approved exception to "no card grids anywhere" | User-directed. The gallery shipped as stacked rows, correctly, because this file names card grids as slop. The user then reviewed a clickable prototype alongside the shipped rows and asked for the grid, and this file's rule is "do not deviate without explicit user approval" — so the deviation is recorded rather than re-litigated the next time someone reads the anti-slop table. Scoped to that one page: not a precedent for Skills / MCP / Plugins / Personalities / Dashboards, and not a fourth `Card`-primitive exemption, since the cards are raw primitives and each is a real `<Link>` (focusable, middle-clickable). The rest of the Recipes flow stays rows — preflight groups, the install summary and the post-install checklist are all the same bordered row list. |
| 2026-09-04 | Feedback & activity contract | Owner principle: show every action, never inside the answer, complete, acknowledge every ask. Tool chips leave the bubble; status line on send in a reserved slot; collapsed trail footer; one derived trail for footer + drawer; findings and settings feedback share the row vocabulary. Supersedes ToolChip's "inline between text spans" rationale. |
| 2026-09-04 | Five token values raised to clear WCAG AA 4.5:1 on `--bg-base`, plus the light `--text-secondary` the fix depended on | Owner-approved accessibility correction, not a restyle. The feedback & activity contract landed the same day assigns `--text-tertiary` to **every** duration and elapsed number at 13px and `--warning` to `⚠ still working` / `⚠ N unverified` — 13px is normal text, so 4.5:1 applies to tokens that were previously only ever carrying captions. Measured against `--bg-base` with `contrastRatio()` in `packages/design-tokens/src/validate.ts`, five pairs failed: `--text-tertiary` dark `#6B6B6A` 3.59:1 → `#7E7E7D` 4.72:1; `--text-tertiary` light `#94948F` 2.91:1 → `#70706B` 4.76:1; `--warning` light `#F59E0B` 2.05:1 → `#986206` 4.92:1; `--success` light `#4ADE80` 1.67:1 → `#177D3C` 4.98:1; `--error` light `#F87171` 2.65:1 → `#CE2C2C` 4.99:1. Every value clears the bar with margin rather than sitting on 4.51, because a token pinned to the threshold fails the next time anyone nudges a background. **The sixth change is the one that needed a decision.** Raising a tertiary compresses the grey ramp toward secondary, and a hierarchy you cannot see is not a hierarchy. In dark that still works: secondary stays `#9A9A98` and the step is ΔL\* 10.8 (was 18.4). In light it did not — secondary was `#6B6B6A` at 5.10:1, which caps a compliant tertiary at ΔL\* 1.9, indistinguishable. So light `--text-secondary` moves too, `#6B6B6A` → `#585857` (5.10:1 → 6.81:1, ΔL\* 9.7), which also makes the two skins' ramps parallel — 15.62/6.80/4.72 dark against 16.64/6.81/4.76 light. The alternative was leaving the single worst failure in the file at 2.91:1, which is not a fix. **The `reviewer` accent is deliberately unchanged at `#F59E0B`, and so is `engineer` at `#4ADE80`.** `--warning` and `reviewer` were never one constant — `DEFAULT_TOKENS.accents.reviewer` and `DEFAULT_TOKENS.semantic.warning` are separate fields that happened to agree — and they now agree only on the dark skin. A personality's identity hue is load-bearing and does not retune per background; a status colour does. The semantic table gains a Light column to say so in the file rather than only in the code. Light semantics keep their dark hue exactly (37.7° / 141.9° / 0.0°) and drop lightness; red also eases saturation 91% → 65% so a 5:1 red reads as brick rather than siren next to an ochre and a forest green. `--info` is knowingly left failing at 2.63:1 on paper-warm: it is the researcher hue and the permanent altitude-rail blue, so moving it is an accent decision under the identity rule above, not a contrast one, and it is not in the approved set. The validator now enforces `--text-secondary` and `--text-tertiary` at AA 4.5 alongside `--text-primary` at AAA 7, so this cannot silently regress; it deliberately does NOT yet cover the semantics, because `paper.info` would fail it. |
| 2026-09-04 | Teams are a third altitude | Teams-as-a-scope plan (`plan/phases/teams-as-a-scope.md`, D9/D10, §12). A team is a scope beside Library and Workspace, not a page in the Library: the scope switcher (Independent · teams · New team) is the breadcrumb root at every altitude. Team chrome is **neutral** (`--ethos-info`) because a team's identity is plural; a member's workspace inside a team (`/t/:teamId/p/:id/*`) carries that member's accent exactly as `/p/:id/*` does; the team Chat pane is the coordinator's session and carries the coordinator's accent. The team mark is the **segmented ring** — one arc per member in that member's accent, manifest order from 12 o'clock — built from the members, so it can be mistaken for neither the generative mark nor the annulus. No new `Card` exemption: the Overview's attention tiles reuse the Task tile. Prototype: `plan/prototypes/teams-as-a-scope/ethos-team-scope.html` (artifact https://claude.ai/code/artifact/ca79190e-4d8a-4f1a-b4ec-29c53df17fb2). Blocking amendment, landed before any code. |
