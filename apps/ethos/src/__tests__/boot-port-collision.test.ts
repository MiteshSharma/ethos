// plan/phases/single-process-boot-profile.md §9.6 / §5 / §11 OQ10 — the web
// port's fallback ladder must never self-collide inside the merged process.
//
// In the split world `listenWithFallback` only ever probes OTHER processes'
// ports, so walking 3000→3004 on EADDRINUSE is harmless. In `ethos boot`,
// 3001/3002/3003 are THIS process's ACP, health and webhook servers, so a
// stale peer holding 3000 would walk the web bind straight into its own
// siblings — a failure mode with no precedent in the current architecture.
//
// The resolution taken (option (a) of §9.6): `boot.ts` hands the ladder the
// ports it has already bound, and the ladder skips them. The tests below pin
// both halves of that: the walk lands PAST the reserved ports, and — when
// there is nowhere left to land — it fails loudly, naming what it skipped.
//
// The last case is the non-regression: `serve.ts` still calls the 4-argument
// form, which reserves nothing and behaves exactly as it did before.

import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenWithFallback } from '../commands/serve-listen';

const stubApp = { fetch: () => new Response('ok') };

interface Closeable {
  close: () => void | Promise<void>;
}
const cleanups: Closeable[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const c = cleanups.pop();
    if (c) await c.close();
  }
});

function trackServer(server: { close: (cb?: () => void) => void }): void {
  cleanups.push({
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

async function occupy(port: number): Promise<() => Promise<void>> {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', () => resolve());
  });
  return () => new Promise<void>((resolve) => blocker.close(() => resolve()));
}

/** An OS-assigned free port, released before it is handed back. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!addr || typeof addr === 'string') throw new Error('could not assign a port');
  return addr.port;
}

describe('boot profile — the web fallback ladder cannot collide with its own process', () => {
  it('skips the ports this same process already bound and lands past them', async () => {
    // `base` stands in for 3000, base+1/2/3 for the ACP / health / webhook
    // servers `boot.ts` has already bound, base+4 for the free landing slot.
    const base = await freePort();
    const releaseBase = await occupy(base);
    // The three "sibling" ports are genuinely occupied too — the point is that
    // the ladder never even ATTEMPTS them, not that it survives failing on them.
    const releaseSiblings = await Promise.all([
      occupy(base + 1),
      occupy(base + 2),
      occupy(base + 3),
    ]);

    try {
      const { server, port } = await listenWithFallback(stubApp, base, 5, '127.0.0.1', [
        base + 1,
        base + 2,
        base + 3,
      ]);
      trackServer(server);
      expect(port).toBe(base + 4);
    } finally {
      await releaseBase();
      for (const release of releaseSiblings) await release();
    }
  });

  it('does not spend an attempt on a skipped port: the ladder keeps its full depth', async () => {
    // `attempts` is a depth of REAL bind attempts. With base+1 reserved, three
    // attempts must still reach three bindable ports (base, base+2, base+3) —
    // the old loop counted the skip and gave up after two.
    const base = await freePort();
    const releaseBase = await occupy(base);
    const releaseNeighbour = await occupy(base + 2);
    try {
      const { server, port } = await listenWithFallback(stubApp, base, 3, '127.0.0.1', [base + 1]);
      trackServer(server);
      expect(port).toBe(base + 3);
    } finally {
      await releaseBase();
      await releaseNeighbour();
    }
  });

  it('fails loudly, naming the skipped ports, rather than colliding silently', async () => {
    const base = await freePort();
    // Both bindable ports in the (now attempt-counted) window are taken by
    // other processes, and everything between them is reserved by this one:
    // there is nowhere to land, and the only acceptable outcome is a loud
    // error — never a bind onto one of our own servers.
    const releaseBase = await occupy(base);
    const releaseLanding = await occupy(base + 4);
    try {
      await expect(
        listenWithFallback(stubApp, base, 2, '127.0.0.1', [base + 1, base + 2, base + 3]),
      ).rejects.toMatchObject({
        code: 'INTERNAL',
        cause: expect.stringContaining('already bound by this process'),
      });
    } finally {
      await releaseBase();
      await releaseLanding();
    }
  });

  it('says the requested port was RESERVED, not taken, when this process holds it', async () => {
    // `ethos boot --web-port 3001` asks for the ACP port. Nothing external took
    // it, so "taken" would send the operator hunting a phantom conflict.
    const base = await freePort();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { server, port } = await listenWithFallback(stubApp, base, 2, '127.0.0.1', [base]);
      trackServer(server);
      expect(port).toBe(base + 1);
      const message = warn.mock.calls.map((args) => String(args[0])).join('\n');
      expect(message).toContain(`Port ${base} is already reserved by this process`);
      expect(message).not.toContain('was taken');
    } finally {
      warn.mockRestore();
    }
  });

  it('is unchanged for `serve.ts`: with no reserved set the walk falls forward as before', async () => {
    const base = await freePort();
    const releaseBase = await occupy(base);
    try {
      const { server, port } = await listenWithFallback(stubApp, base, 5);
      trackServer(server);
      expect(port).toBe(base + 1);
    } finally {
      await releaseBase();
    }
  });
});
