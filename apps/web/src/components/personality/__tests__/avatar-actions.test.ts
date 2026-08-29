import { describe, expect, it, vi } from 'vitest';
import {
  type AvatarActionDeps,
  applyAvatarSelection,
  attachAvatarAfterCreate,
  removeAvatar,
} from '../avatarActions';

// Sequencing rules for the avatar picker, pulled out of `NewAgentDialog` and
// `IdentityEditor` so they're testable without rendering either component
// (mirrors `voiceCreateInput`/`voiceUpdateInput` in
// `PersonalityVoiceFields.test.ts`).

function ok(): Response {
  return new Response(null, { status: 200 });
}

function fail(status = 500): Response {
  return new Response(null, { status });
}

function deps(over: Partial<AvatarActionDeps> = {}): AvatarActionDeps {
  return {
    setAvatarUrl: vi.fn().mockResolvedValue(undefined),
    uploadAvatar: vi.fn().mockResolvedValue(ok()),
    deleteAvatar: vi.fn().mockResolvedValue(ok()),
    ...over,
  };
}

describe('applyAvatarSelection (edit surface — personality already exists)', () => {
  it('DELETEs any stored upload before writing a curated URL, in that order', async () => {
    const d = deps();
    const calls: string[] = [];
    (d.deleteAvatar as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      calls.push(`delete:${id}`);
      return ok();
    });
    (d.setAvatarUrl as ReturnType<typeof vi.fn>).mockImplementation(
      async (id: string, url: string) => {
        calls.push(`update:${id}:${url}`);
      },
    );

    await applyAvatarSelection('researcher', { kind: 'curated', url: '/avatars/aria.svg' }, d);

    expect(calls).toEqual(['delete:researcher', 'update:researcher:/avatars/aria.svg']);
    expect(d.uploadAvatar).not.toHaveBeenCalled();
  });

  it('a file selection uploads bytes directly — no delete, no update call', async () => {
    const d = deps();
    const file = new File(['bytes'], 'a.png', { type: 'image/png' });

    await applyAvatarSelection('researcher', { kind: 'file', file }, d);

    expect(d.uploadAvatar).toHaveBeenCalledWith('researcher', file);
    expect(d.deleteAvatar).not.toHaveBeenCalled();
    expect(d.setAvatarUrl).not.toHaveBeenCalled();
  });

  it('throws when the upload response is not ok', async () => {
    const d = deps({ uploadAvatar: vi.fn().mockResolvedValue(fail(413)) });
    const file = new File(['bytes'], 'a.png', { type: 'image/png' });
    await expect(applyAvatarSelection('researcher', { kind: 'file', file }, d)).rejects.toThrow(
      '413',
    );
  });
});

describe('attachAvatarAfterCreate (create surface — no prior upload can exist)', () => {
  it('a curated pick writes the URL directly, no delete-first step', async () => {
    const setAvatarUrl = vi.fn().mockResolvedValue(undefined);
    const uploadAvatar = vi.fn().mockResolvedValue(ok());

    await attachAvatarAfterCreate(
      'new-agent',
      { kind: 'curated', url: '/avatars/nova.svg' },
      { setAvatarUrl, uploadAvatar },
    );

    expect(setAvatarUrl).toHaveBeenCalledWith('new-agent', '/avatars/nova.svg');
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it('a file selection uploads bytes directly', async () => {
    const setAvatarUrl = vi.fn().mockResolvedValue(undefined);
    const uploadAvatar = vi.fn().mockResolvedValue(ok());
    const file = new File(['bytes'], 'a.png', { type: 'image/png' });

    await attachAvatarAfterCreate(
      'new-agent',
      { kind: 'file', file },
      { setAvatarUrl, uploadAvatar },
    );

    expect(uploadAvatar).toHaveBeenCalledWith('new-agent', file);
    expect(setAvatarUrl).not.toHaveBeenCalled();
  });

  it('rejects when the upload fails, so the caller’s try/catch (not this function) decides what happens next', async () => {
    const setAvatarUrl = vi.fn().mockResolvedValue(undefined);
    const uploadAvatar = vi.fn().mockResolvedValue(fail(400));
    const file = new File(['bytes'], 'a.png', { type: 'image/png' });

    await expect(
      attachAvatarAfterCreate('new-agent', { kind: 'file', file }, { setAvatarUrl, uploadAvatar }),
    ).rejects.toThrow();
  });
});

describe('removeAvatar', () => {
  it('always goes through the DELETE route, never a bare update', async () => {
    const deleteAvatar = vi.fn().mockResolvedValue(ok());
    await removeAvatar('researcher', { deleteAvatar });
    expect(deleteAvatar).toHaveBeenCalledWith('researcher');
  });

  it('throws when the DELETE response is not ok', async () => {
    const deleteAvatar = vi.fn().mockResolvedValue(fail(404));
    await expect(removeAvatar('researcher', { deleteAvatar })).rejects.toThrow('404');
  });
});
