# @ethosagent/platform-email

Email `PlatformAdapter` — polls IMAP for unseen messages and sends replies via SMTP, threaded by subject.

## Why this exists

Email is the broadest-deployable surface: every user and every system has an inbox, and email survives outages, devices, and platform changes that chat apps don't. This adapter lets Ethos run as an email correspondent — read your inbox on a poll, route each subject thread into its own session, and reply with proper `In-Reply-To` headers so threading holds in normal mail clients.

## What it provides

- `EmailAdapter` — implements `PlatformAdapter` from `@ethosagent/types`.
- `EmailAdapterConfig` — IMAP and SMTP host/port/credentials plus `pollIntervalMs`.
- Constructor `overrides` for `createImapClient` and `createTransporter` so tests can inject mocks.

## How it works

Connection is IMAP polling, not IDLE. `start()` runs `poll()` once and then schedules it on `pollIntervalMs` (default 60 s) (`src/index.ts:99-103`). Each poll opens a fresh `ImapFlow` connection, locks `INBOX`, searches for `seen: false` UIDs, fetches them with `source: true`, parses each via `mailparser`, emits an `InboundMessage`, and finally marks the UID `\Seen` so it isn't re-processed (`src/index.ts:166-204, 235`). Errors at the IMAP layer are swallowed silently and retried on the next tick.

Session-key derivation is what makes email feel native: `chatId = ${from}:${slugify(subject)}` (`src/index.ts:32-45, 215`). The slug strips a leading `Re:`, lowercases, and collapses non-alphanumerics to `-`. Gateway then derives the lane key as `email:<from>:<slug>`, so **every distinct subject from a given sender becomes its own agent session** with its own conversation history. A new subject from the same person starts a new session by design.

For each inbound, the adapter records a `ThreadState` keyed by `chatId` containing the recipient address, the reply subject (prefixed with `Re:` if not already), and the parsed `Message-ID` (`src/index.ts:217-221`). `send(chatId, msg)` looks that state up and calls nodemailer with `inReplyTo` and `references` set so Gmail/Outlook/Apple Mail keep it in the same thread (`src/index.ts:116-136`). If thread state is missing — for instance, if `send` is called for a `chatId` the adapter never observed — the call returns `{ ok: false }`.

## Configuration

Constructor config:

| Field | Required | Notes |
|---|---|---|
| `imapHost`, `imapPort` | yes | IMAP is connected over TLS (`secure: true`). |
| `smtpHost`, `smtpPort` | yes | |
| `user`, `password` | yes | Used for both IMAP and SMTP auth. App-passwords required for Gmail / Apple. |
| `smtpSecure` | no | Defaults to `true` for port 465, otherwise `false` (STARTTLS path). |
| `pollIntervalMs` | no | Default `60_000`. |

## Gotchas

- **Each subject is its own session.** Replying to the same person under a new subject line starts a fresh agent conversation — there is no cross-subject memory. Conversely, anyone replying within the same `Re:` subject continues an existing session, including third parties on the thread.
- Polling, not IDLE — there is up to `pollIntervalMs` of latency per inbound. IMAP IDLE would be lower-latency but isn't implemented.
- `processMessage` errors are swallowed per-message; the poll loop continues even if a particular email fails to parse.
- `canSendTyping`, `canEditMessage`, `canReact`, `canSendFiles` are all `false` — the Gateway typing renew is a no-op and there's no edit-in-place.
- `messageId` is **not** populated on `InboundMessage`, so the Gateway dedup window cannot drop duplicate IMAP delivery — relying on `\Seen` flag arithmetic to dedup. If the `messageFlagsAdd` call fails, the message will be re-emitted on the next poll.
- A new IMAP connection is opened on every poll and on every health check; there is no connection pool.
- The `from` half of `chatId` comes from `parsed.from` — spoofed senders share session state with whoever they impersonate.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | `EmailAdapter`, `slugify`/`makeChatId`, IMAP poll + SMTP send. |
| `src/mailparser.d.ts` | Local type shim for `mailparser`. |
| `src/__tests__/` | Unit tests using injected IMAP/SMTP mocks. |
| `package.json` | Depends on `imapflow`, `mailparser`, `nodemailer`. |
