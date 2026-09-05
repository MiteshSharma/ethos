import { os } from './context';

// Backup pane RPC. Bytes never travel here — the archive itself is streamed by
// `GET /backup/download` (`routes/backup.ts`), which is cookie-only.
//
// `downloadAvailable` is the one thing a handler can answer that the service
// cannot: only this layer sees how the request authenticated. A Bearer caller
// presents an `sk-ethos-` API key and cannot reach a cookie-only route, so it
// is told rather than handed a link that 401s on click.
//
// What the plan says about desktop remote mode is worth correcting here,
// because it changes nothing but it would mislead the next reader. Desktop
// remote mode does NOT authenticate with a Bearer header: it puts the stored
// web token on a `Cookie` header precisely because `dual-auth.ts` scope-gates
// Bearer and would 403 every unmapped namespace (see the comment on
// `pluginFetch` in `apps/desktop/src/main/ipc.ts`). So desktop reads as a
// cookie caller here. The genuine Bearer caller is a third-party API key —
// and today `backup` has no SCOPE_MAP entry, so such a caller is refused the
// whole namespace before a handler runs. `downloadAvailable` is therefore
// belt-and-braces: correct now, and still correct on the day `backup` is
// scope-mapped and the 403 stops covering for it.

/** Same `_authMethod` read as `rpc/cron.ts`. Absent means cookie. */
function isBearer(context: object): boolean {
  return (context as { _authMethod?: unknown })._authMethod === 'bearer';
}

export const backupRouter = {
  status: os.backup.status.handler(({ context }) =>
    context.backup.status({ downloadAvailable: !isBearer(context) }),
  ),

  create: os.backup.create.handler(({ input, context }) =>
    context.backup.create(input.scopes ? { scopes: input.scopes } : {}),
  ),

  // The `identity`-only refusal (D6) lives in the service, not here: it is a
  // rule about what this deployment can safely do, and it must hold for every
  // caller of the service, not only for ones that arrive through this file.
  restoreIdentity: os.backup.restoreIdentity.handler(({ input, context }) =>
    context.backup.restoreIdentity({
      name: input.name,
      ...(input.scopes ? { scopes: input.scopes } : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    }),
  ),
};
