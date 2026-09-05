// The composition-root half of the screencast takeover (plan B3, T8).
//
// `createWebApi` takes `browserTakeoverSessions` and returns a `takeoverSocket`
// that has to be attached to the listening server. Without the registry the
// lane refuses every connection with `session_unavailable`; without the attach
// the path never upgrades at all. Both are host-side wiring, and both are only
// correct where the browser tools run IN THIS PROCESS.
//
// Asserted against SOURCE for the reason boot-profile-extraction.test.ts
// records: `commands/serve.ts` imports `@ethosagent/acp-server`, an app with
// no path alias, so the module is not importable from a repo-rooted vitest run.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const read = (rel: string) => readFile(join(root, rel), 'utf8');

describe('in-process hosts wire the browser-takeover lane', () => {
  it('serve.ts hands the socket the tool lock registry, not a policy lookup', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src).toContain('browserTakeoverSessions: createBrowserTakeoverRegistry(),');
    // The registry is the ONLY lookup the socket gets. A `findActiveSession`
    // closure here would be the policy re-lookup the design forbids.
    expect(src).not.toContain('findActiveSession');
  });

  it('serve.ts attaches and closes the takeover lane alongside the other two', async () => {
    const src = await read('apps/ethos/src/commands/serve.ts');
    expect(src).toContain('created.takeoverSocket.attach(server);');
    expect(src).toContain('created.takeoverSocket.close(),');
  });

  it('boot.ts attaches and closes it too, through the shared buildServeWebApi', async () => {
    const src = await read('apps/ethos/src/commands/boot.ts');
    // The options come from `buildServeWebApi`, so boot does NOT build its own
    // registry — one assembler, one answer for both profiles.
    expect(src).toContain('buildServeWebApi({');
    expect(src).not.toContain('browserTakeoverSessions');
    // `attachWebSockets` re-runs on a live `web.port` rebind; a lane left on
    // the previous server is a lane nobody can reach.
    expect(src).toContain('created.takeoverSocket.attach(target);');
    expect(src).toContain('created.takeoverSocket.close(),');
  });
});

// The honest refusal, asserted rather than assumed. `ethos gateway` opens its
// Chromium in the gateway process and hosts no web API at all, so there is no
// socket to reach it from and nothing to wire — `session_unavailable` on a
// takeover started by a gateway-hosted turn is the correct answer, not a gap.
// Handing back from the chat card still works there.
describe('the gateway cannot reach an in-process browser session', () => {
  it('hosts no web API, so no takeover lane is wired there', async () => {
    const src = await read('apps/ethos/src/commands/gateway.ts');
    expect(src).not.toContain('createWebApi(');
    expect(src).not.toContain('buildServeWebApi(');
    expect(src).not.toContain('takeoverSocket');
    expect(src).not.toContain('createBrowserTakeoverRegistry');
  });
});
