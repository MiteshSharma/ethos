import { describe, expect, it } from 'vitest';
import { createClickListener } from '../click-listener';

describe('createClickListener', () => {
  it('resolves waitForHit when the listener URL is hit', async () => {
    const listener = await createClickListener();
    const hitPromise = listener.waitForHit();

    const response = await fetch(listener.url);
    expect(response.status).toBe(204);

    await hitPromise;
    listener.close();
  });

  it('returns 404 and does not resolve waitForHit for the wrong path', async () => {
    const listener = await createClickListener();
    let hit = false;
    listener.waitForHit().then(() => {
      hit = true;
    });

    const wrongUrl = listener.url.replace(/\/click\/.+$/, '/click/not-the-real-token');
    const response = await fetch(wrongUrl);
    expect(response.status).toBe(404);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hit).toBe(false);

    listener.close();
  });

  it('gives independent tokens and ports to concurrent listeners', async () => {
    const a = await createClickListener();
    const b = await createClickListener();
    expect(a.url).not.toBe(b.url);

    let bHit = false;
    b.waitForHit().then(() => {
      bHit = true;
    });

    await fetch(a.url);
    await a.waitForHit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bHit).toBe(false);

    a.close();
    b.close();
  });
});
