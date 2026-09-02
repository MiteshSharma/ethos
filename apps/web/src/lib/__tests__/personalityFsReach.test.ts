import { describe, expect, it } from 'vitest';
import { wizardFsReach } from '../personalityFsReach';

// The create wizard's "Working directories" field. The EDIT drawer's equivalent
// is covered end to end by
// `apps/web-api/src/__tests__/routes/personalities-fs-reach-rpc.test.ts`; this
// is the other half — what the wizard hands the `personalities.create` call.
//
// The contract types `workdir` as `string | string[]`, so narrowing a
// multi-root declaration to its first entry here would typecheck and silently
// create a one-root personality.

describe('wizardFsReach', () => {
  it('omits fs_reach entirely when the wizard declared nothing', () => {
    expect(wizardFsReach({ fsReachRead: [], fsReachWrite: [], fsReachWorkdir: [] })).toEqual({});
  });

  it('carries a single working directory as a one-entry list', () => {
    expect(
      wizardFsReach({ fsReachRead: [], fsReachWrite: [], fsReachWorkdir: ['/srv/app'] }),
    ).toEqual({ fs_reach: { read: [], write: [], workdir: ['/srv/app'] } });
  });

  it('carries EVERY working directory, not just the first', () => {
    expect(
      wizardFsReach({
        fsReachRead: ['/data'],
        fsReachWrite: ['/data/out'],
        fsReachWorkdir: ['/srv/a', '/srv/b', '/srv/c'],
      }),
    ).toEqual({
      fs_reach: { read: ['/data'], write: ['/data/out'], workdir: ['/srv/a', '/srv/b', '/srv/c'] },
    });
  });

  it('declares fs_reach for a workdir-only personality', () => {
    // read/write empty means "default reach", which is a different thing from
    // "no declared workdir" — the block must still be sent.
    const out = wizardFsReach({
      fsReachRead: [],
      fsReachWrite: [],
      fsReachWorkdir: ['/srv/a', '/srv/b'],
    });
    expect(out.fs_reach?.workdir).toEqual(['/srv/a', '/srv/b']);
  });

  it('omits workdir (rather than sending an empty list) when none was declared', () => {
    // Creation has nothing to merge into, so an undeclared workdir is absent
    // rather than explicitly cleared.
    const out = wizardFsReach({
      fsReachRead: ['/data'],
      fsReachWrite: ['/data/out'],
      fsReachWorkdir: [],
    });
    expect(out.fs_reach).toEqual({ read: ['/data'], write: ['/data/out'] });
    expect('workdir' in (out.fs_reach ?? {})).toBe(false);
  });
});
