import { describe, expect, it } from 'vitest';

describe('rpc', () => {
  it('exports client and rpc', async () => {
    const mod = await import('../rpc');
    expect(mod.client).toBeDefined();
    expect(mod.rpc).toBeDefined();
  });
});
