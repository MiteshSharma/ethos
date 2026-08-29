---
name: xurl
description: Use X's own official developer-platform CLI (`xurl`) to post, reply, quote, thread, upload media, search, and manage bookmarks/lists/DMs on X (Twitter) under the user's own authenticated account. Covers the one-time OAuth setup, the shortcut commands, raw v2 endpoint access for gaps (lists, analytics), and the hard safety rules around credential handling and posting.
version: 1.0.0
author: ethosagent
tags: [x, twitter, social-media, xurl, x-api]
required_tools: [terminal]

ethos:
  category: platform-integration
  external_cli_alternatives: [xurl]
  default_personalities: []
  prerequisites:
    external_cli: [xurl]
    auth:
      - one-time manual app registration in the X developer dashboard (developer.x.com)
      - one-time browser OAuth2 PKCE consent via `xurl auth oauth2`
    env_vars: []
    optional_tools: []
  integrates_with:
    - tool: x_search
      role: sibling with a different scope — x_search is Grok-mediated broad keyword/semantic search with no account-scoped access; xurl operates under the user's own authenticated X account (it can read the user's own bookmarks, DMs, timeline, and follower graph, which x_search cannot reach at all). Pick the one that matches the task's account-scope, not habit.
  surface_metadata:
    invocation_trigger: "user says 'post this to X', 'reply to this tweet', 'check my X DMs', 'search my bookmarks', 'what's the engagement on my last post'; agent self-invokes when a task needs the user's OWN authenticated X account rather than broad public search"
    estimated_turns: "1-4"
---

# xurl — X (Twitter) via the Official Developer CLI

`xurl` is X's own official CLI for the X API v2 — curl-like raw endpoint access plus a set of shortcut commands for posting, reading, searching, and managing bookmarks/lists/DMs under one authenticated account. It is the account-scoped complement to `x_search`, not a replacement for it.

*Informed by X's own `xurl` documentation (github.com/xdevplatform/xurl, docs.x.com/tools/xurl) and the publicly-documented `xurl` skill pattern used by other agent frameworks (e.g. Hermes Agent). Content below is written fresh for Ethos's own conventions.*

## When to use this skill

- The user asks to post, reply, quote-post, or thread something on X.
- The user wants to read or manage things scoped to their own account: bookmarks, lists, DMs, followers, their own recent posts' engagement.
- The task explicitly needs the authenticated user's timeline, mentions, or DM inbox — none of which `x_search` can reach.
- The user asks to attach an image or video to a post.

## When NOT to use this skill

- Broad public keyword or semantic search across X, not scoped to the user's own account — use the `x_search` tool instead. `x_search` is Grok-mediated and needs no X account auth; `xurl search` runs against X's native recent-search endpoint under the user's own OAuth token and is subject to that account's rate limits and access tier.
- `xurl auth status` reports no default app/user — stop and point the user at "Setup the user needs to do once" below. Do not attempt to run the OAuth flow on the user's behalf inside a tool call; it opens a browser for human consent.
- The task asks for analytics fields (`non_public_metrics`, `organic_metrics`) the account's API access tier doesn't include — report the limitation, don't estimate numbers.

## Posting, replying, quoting, threads

```bash
# Plain post
xurl post "Shipping the new release notes today."

# Reply to a specific post (post ID from a prior read/search/post response)
xurl reply 1823456789012345678 "Good catch — fixed in the next patch."

# Quote-post
xurl quote 1823456789012345678 "This is exactly the tradeoff we discussed last week."
```

There is no dedicated "thread" command. Build one by chaining `post` then `reply`, capturing each response's post id with `jq`:

```bash
first=$(xurl post "1/ Here's what shipped this week..." | jq -r '.data.id')
second=$(xurl reply "$first" "2/ The scheduler seam now supports..." | jq -r '.data.id')
xurl reply "$second" "3/ Full changelog: <link>"
```

## Media

Upload first, then attach the returned media id to a post:

```bash
xurl media upload ./screenshot.png
xurl media upload --media-type video/mp4 --category tweet_video ./demo.mp4
xurl media status --wait MEDIA_ID   # poll until processing finishes, video/gif only
xurl post "New dashboard is live." --media-id MEDIA_ID
```

## Reading and search

```bash
xurl read 1823456789012345678              # look up one post
xurl search "from:xdevelopers lang:en" -n 10  # recent-search shortcut
```

For anything the shortcuts don't cover, `xurl` also accepts raw v2 endpoints, curl-style:

```bash
xurl "/2/tweets/search/recent?query=from:xdevelopers&max_results=10"
xurl -X POST /2/tweets -d '{"text": "Hello from xurl!"}'
```

`xurl search`/raw endpoint reads run under the authenticated user's own OAuth token against X's native API — this is what lets it also do things `x_search` structurally cannot: read the user's own bookmarks, DMs, timeline, and follower graph. `x_search` is a separate tool (`extensions/tools-x-search`) doing Grok-mediated broad keyword/semantic search with no account-scoped access. Use `xurl` when the task is "my account, my data"; use `x_search` when the task is "what's out there on X about X".

## Bookmarks, likes, follows

```bash
xurl bookmark 1823456789012345678
xurl unbookmark 1823456789012345678
xurl bookmarks -n 20
xurl like 1823456789012345678
xurl repost 1823456789012345678
xurl follow @openai
xurl followers -n 20
```

## Direct messages and XChat

Classic Direct Messages:

```bash
xurl dm @someuser "Following up on the thread above."
xurl dms -n 25
```

XChat is a separate, end-to-end-encrypted messaging surface with its own local key material — treat it as a distinct feature, not a DM alias:

```bash
xurl chat keys restore                        # one-time, restores XChat encryption keys
xurl chat send @someuser "message" --reply-to SEQUENCE_ID
xurl chat read @someuser -n 10
```

## Lists

No shortcut command exists for lists — use raw v2 endpoints:

```bash
xurl -X POST /2/lists -d '{"name": "Watching", "description": "Accounts to track", "private": true}'
xurl "/2/users/USER_ID/owned_lists"
xurl -X POST /2/lists/LIST_ID/members -d '{"id": "USER_ID"}'
xurl -X DELETE /2/lists/LIST_ID/members/USER_ID
xurl "/2/lists/LIST_ID/tweets"
```

## Analytics

Public engagement counts are generally available via `tweet.fields=public_metrics`:

```bash
xurl "/2/tweets/1823456789012345678?tweet.fields=public_metrics"
```

Deeper analytics (`non_public_metrics`, `organic_metrics` — impressions, profile clicks, video view breakdowns) require both OAuth2 user context and a paid X API access tier (Basic/Pro); the free tier does not expose them and the request will fail. If a metrics call comes back as a permissions error, report the tier limitation to the user rather than approximating a number:

```bash
xurl "/2/tweets/1823456789012345678?tweet.fields=public_metrics,non_public_metrics,organic_metrics"
```

## Anti-patterns

- Treating `xurl search` and `x_search` as interchangeable. Pick based on account-scope: own account vs. broad public search.
- Posting, replying, quoting, or DM-sending without checking whether an approval gate applies (see Hard rules).
- Inventing a single "thread" flag. There isn't one — chain `post` then `reply` using the returned post id.
- Fabricating an analytics number when `non_public_metrics`/`organic_metrics` fails on tier. Report the limitation.
- Re-printing `xurl auth status` or any command's raw stdout uncritically when it might echo a token — check before repeating tool output back to the user.

## Hard rules

- **Never read, print, parse, summarize, upload, or transmit the contents of `~/.xurl/`** in any tool call or response. This directory holds `auth.yml` (OAuth tokens) and `keys.yml` (XChat private encryption keys, mode 600). There is no task that requires the agent to see these files.
- **Never pass tokens or secrets inline via a command-line flag** — `--bearer-token`, `--consumer-key`, `--consumer-secret`, `--access-token`, `--token-secret`, `--client-id`, `--client-secret` all land in shell history, process listings, and tool-call logs. The one exception is the human's own one-time manual setup run outside the agent session (see Setup below).
- **Never run `xurl token`.** It prints a live OAuth2 access token to stdout, which would then land directly in the agent's transcript.
- **Never pass `--verbose`/`-v`.** It exposes auth headers in the command output.
- **Posting is a real, public, largely irreversible action.** A personality using this skill for posting, replying, quoting, or sending a DM should route through Ethos's own approval-gate mechanism (a `before_tool_call` hook, or an explicit clarifying question) before the call happens, rather than posting unsupervised — unless the personality's own SOUL.md explicitly authorizes autonomous posting. This is an operating rule for the agent to follow, not something the skill can enforce technically.

## Setup the user needs to do once

1. Install `xurl` (see github.com/xdevplatform/xurl for the current install instructions — Homebrew tap or `go install`).
2. Register an app in the X developer dashboard (developer.x.com): create a Project + App, enable OAuth 2.0, and capture the Client ID and Client Secret.
3. Register the app with `xurl` (run this manually — never delegate this call to the agent, since it takes the client secret as an argument):
   ```bash
   xurl auth apps add <name> --client-id <ID> --client-secret <SECRET>
   ```
4. Run the OAuth2 PKCE flow, which opens a browser for consent:
   ```bash
   xurl auth oauth2 --app <name>
   # on a headless/remote box:
   xurl auth oauth2 --app <name> --headless
   ```
5. Set the app as default so subsequent commands don't need `--app`:
   ```bash
   xurl auth default <name>
   ```
6. Verify:
   ```bash
   xurl auth status
   ```

Credentials persist to `~/.xurl/auth.yml` (YAML); tokens auto-refresh from there automatically. The agent never needs to read this file — see Hard rules.
