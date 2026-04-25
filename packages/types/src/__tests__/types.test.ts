import { describe, expect, it } from 'vitest';

describe('@ethosagent/types', () => {
  it('imports without errors', async () => {
    const types = await import('../index');
    expect(types).toBeDefined();
  });
});
