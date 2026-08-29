// `files://` addresses the personality's ASSET FOLDER. tools-ui does not know
// where that folder is — wiring resolves it from the personality's `fs_reach`
// (it is the declared workdir when there is one) and hands the answer in. These
// tests pin that seam: the resolver's answer is the path the tools touch, for
// both reads and the auto-copy of externally-rendered files.

import type { ScopedFs, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type AssetDirResolver, createRenderFileTool, createRenderImageTool } from '../index';

const WORKDIR = '/srv/workspace/writer';
const LEGACY = '/home/tester/.ethos/personalities/writer/files';

/** Records every path the tool reads or writes; reads always succeed. */
function makeCtx(): {
  ctx: ToolContext;
  reads: string[];
  writes: string[];
} {
  const reads: string[] = [];
  const writes: string[] = [];
  const scopedFs = {
    readBytes: async (path: string) => {
      reads.push(path);
      return new Uint8Array([1, 2, 3]);
    },
    write: async (path: string) => {
      writes.push(path);
    },
  } as unknown as ScopedFs;
  return {
    ctx: { personalityId: 'writer', scopedFs } as unknown as ToolContext,
    reads,
    writes,
  };
}

const resolverFor =
  (dir: string): AssetDirResolver =>
  (id) =>
    id === 'writer' ? dir : undefined;

describe('files:// resolves against the supplied asset folder', () => {
  it('render_file reads from the declared workdir', async () => {
    const { ctx, reads } = makeCtx();
    const result = await createRenderFileTool(resolverFor(WORKDIR)).execute(
      { src: 'files://report.md' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(reads).toEqual([`${WORKDIR}/report.md`]);
  });

  it('render_image reads from the declared workdir', async () => {
    const { ctx, reads } = makeCtx();
    const result = await createRenderImageTool(resolverFor(WORKDIR)).execute(
      { src: 'files://chart.png' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(reads).toEqual([`${WORKDIR}/chart.png`]);
  });

  // Undeclared workdir: wiring hands back the historical folder, and the tools
  // must address exactly it — the behaviour every existing personality has.
  it('uses the historical personality folder when that is what the resolver yields', async () => {
    const { ctx, reads } = makeCtx();
    await createRenderFileTool(resolverFor(LEGACY)).execute({ src: 'files://report.md' }, ctx);
    expect(reads).toEqual([`${LEGACY}/report.md`]);
  });

  it('auto-copies an externally rendered file into the same folder', async () => {
    const { ctx, writes } = makeCtx();
    await createRenderFileTool(resolverFor(WORKDIR)).execute({ src: '/tmp/scratch/out.pdf' }, ctx);
    expect(writes).toEqual([`${WORKDIR}/out.pdf`]);
  });

  it('refuses files:// with no personality context', async () => {
    const { ctx } = makeCtx();
    const result = await createRenderFileTool(resolverFor(WORKDIR)).execute(
      { src: 'files://report.md' },
      { ...ctx, personalityId: undefined } as unknown as ToolContext,
    );
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
  });

  // A path is never guessed: an unresolvable asset folder refuses the read
  // rather than reaching for some default directory.
  it('refuses files:// when the asset folder cannot be resolved', async () => {
    const { ctx, reads } = makeCtx();
    const result = await createRenderFileTool(() => undefined).execute(
      { src: 'files://report.md' },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
    expect(reads).toEqual([]);
  });
});
