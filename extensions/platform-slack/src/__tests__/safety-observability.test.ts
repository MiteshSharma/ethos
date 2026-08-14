import { describe, expect, it, vi } from 'vitest';
import { dispatch, type SlashCommandPayload, type SlashContext } from '../commands';

// CHS-005 — adapter-local security decisions never reach the gateway's
// `checkMessage`, so without a sink they leave no trace anywhere.

function sink() {
  const recordSafetyBlock = vi.fn();
  return { recordSafetyBlock, calls: () => recordSafetyBlock.mock.calls.map((c) => c[0]) };
}

const payload: SlashCommandPayload = {
  user_id: 'U_INTRUDER',
  channel_id: 'C1',
  text: 'memory add secret',
} as SlashCommandPayload;

describe('slash-command refusal is recorded', () => {
  it('emits slack.slash.unauthorized when the user is not allowlisted', async () => {
    const obs = sink();
    const ctx = { allowedUsers: ['U_OWNER'], observability: obs } as unknown as SlashContext;

    const res = await dispatch(payload, ctx);

    expect(res.responseType).toBe('ephemeral');
    const [event] = obs.calls();
    expect(event.code).toBe('slack.slash.unauthorized');
    expect(event.details).toMatchObject({ userId: 'U_INTRUDER', channelId: 'C1' });
  });

  it('records nothing when the user is authorized', async () => {
    const obs = sink();
    const ctx = {
      allowedUsers: ['U_OWNER'],
      observability: obs,
      binding: { type: 'personality', name: 'default' },
    } as unknown as SlashContext;

    await dispatch({ ...payload, user_id: 'U_OWNER', text: 'help' }, ctx);
    expect(obs.calls()).toHaveLength(0);
  });

  it('still refuses when no sink is wired', async () => {
    // The sink is optional everywhere: an adapter built without one behaves
    // identically, it just records nothing.
    const ctx = { allowedUsers: ['U_OWNER'] } as unknown as SlashContext;
    const res = await dispatch(payload, ctx);
    expect(res.responseType).toBe('ephemeral');
  });
});
