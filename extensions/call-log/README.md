# @ethosagent/call-log

Durable call history for telephony (V4). One row per phone call: who rang, from
and to which number, which bot and lane took it, which personality and voice
tier served it, how it ended, and — once the call is over — its summary,
transcript and cost.

It exists because a call otherwise leaves nothing behind. The lane is in-memory,
the audio is transient, and the session store keeps the turns without the call
facts around them. The Communications call list, the live-call indicator and
post-call summaries all read from here.

## Raw-path SQLite carve-out

`SQLiteCallLog` opens a raw filesystem path through `@ethosagent/sqlite` and
`mkdirSync`s the database file's parent directory, rather than going through the
`Storage` abstraction. Same rationale as `job-store`, `delivery-ledger` and
`session-cards`: SQLite manages its own WAL/SHM files natively and needs a real
path, and `Storage` covers data IO under `~/.ethos/`, not bootstrapping the
enclosing directory of a database file. Recorded in the "Allowed exceptions"
list in `CLAUDE.md`.

## The one rule

`pruneEnded` never deletes a `ringing` or `live` row, however old it is. Those
are live state, not history — a long call is still a call, and a ringing row
stuck past the cutoff is a lost hang-up that an operator needs to see rather
than a row to quietly drop.

## Implementations

- `SQLiteCallLog` — production. Takes `{ path }`.
- `InMemoryCallLog` — tests. Same interface, same ordering and pruning rules,
  no disk.
