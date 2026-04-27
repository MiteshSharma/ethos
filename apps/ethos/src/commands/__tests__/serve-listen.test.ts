import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listenWithFallback } from '../serve-listen';

// Minimal stub that satisfies the `{ fetch }` shape `listenWithFallback`
// expects. Avoids dragging Hono into the CLI app's direct deps just for
// test-side wiring.
const stubApp = { fetch: () => new Response('ok') };

// Real-port integration test. We bind a "blocker" socket on an OS-assigned
// port, then ask `listenWithFallback` to take that exact port — it must
// detect EADDRINUSE and fall forward.

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

async function reserveFreePort(): Promise<{ port: number; release: () => Promise<void> }> {
  // Bind to the wildcard so we collide with @hono/node-server's default
  // (it binds to '::' / '0.0.0.0' depending on platform). Binding to
  // 127.0.0.1 only doesn't trigger EADDRINUSE on macOS dual-stack.
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, () => resolve());
  });
  const addr = blocker.address();
  if (!addr || typeof addr === 'string') {
    blocker.close();
    throw new Error('Could not determine assigned port');
  }
  return {
    port: addr.port,
    release: () =>
      new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      }),
  };
}

describe('listenWithFallback', () => {
  it('falls forward when the requested port is busy, returns the actual port', async () => {
    const blocker = await reserveFreePort();
    const { server, port } = await listenWithFallback(stubApp, blocker.port, 5);
    cleanups.push({
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    });

    expect(port).toBe(blocker.port + 1);
    await blocker.release();
  });

  it('throws when no free port is found in the attempt window', async () => {
    // Block 3 consecutive ports so a 3-attempt range can't find a free slot.
    const a = await reserveFreePort();
    let nextWanted = a.port;
    const blockers = [a];
    for (let i = 0; i < 4; i++) {
      // Keep reserving until we see N consecutive free ports we can occupy.
      nextWanted++;
      try {
        const next = await reserveSpecificPort(nextWanted);
        blockers.push(next);
        if (blockers.length >= 3) break;
      } catch {
        // Port wasn't actually free; reset the search around a fresh anchor.
        const fresh = await reserveFreePort();
        blockers.length = 0;
        blockers.push(fresh);
        nextWanted = fresh.port;
      }
    }
    if (blockers.length < 3) {
      // Couldn't find 3 consecutive free ports on this host; skip.
      for (const b of blockers) await b.release();
      return;
    }

    const firstPort = blockers[0]?.port;
    if (firstPort === undefined) {
      for (const b of blockers) await b.release();
      return;
    }
    await expect(listenWithFallback(stubApp, firstPort, 3)).rejects.toMatchObject({
      code: 'INTERNAL',
      cause: expect.stringMatching(/No free port in range/),
    });

    for (const b of blockers) await b.release();
  });
});

async function reserveSpecificPort(
  port: number,
): Promise<{ port: number; release: () => Promise<void> }> {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, () => resolve());
  });
  return {
    port,
    release: () =>
      new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      }),
  };
}
