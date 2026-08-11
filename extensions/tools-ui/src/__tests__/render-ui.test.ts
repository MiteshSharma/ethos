// `render_ui` is Canvas. Two things must hold no matter what the model sends:
// the template name never becomes a path expression, and every read goes
// through the per-turn ScopedStorage so one personality cannot reach another's
// templates. The caps are the third leg — an oversized frame or an unknown
// library is refused at the tool, never on the wire.

import { BoundaryError, type ScopedFs, type ToolContext } from '@ethosagent/types';
import { CARD_SPEC_VERSION, CanvasCardPayloadSchema } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { createRenderUiTool, type PersonalityDirResolver } from '../render-ui';

const PERSONALITY_DIR = '/home/tester/.ethos/personalities/trader';
const dirFor: PersonalityDirResolver = (id) => (id === 'trader' ? PERSONALITY_DIR : undefined);

function makeCtx(read?: (path: string) => Promise<string>): {
  ctx: ToolContext;
  reads: string[];
} {
  const reads: string[] = [];
  const scopedFs = {
    read: async (path: string) => {
      reads.push(path);
      return read ? await read(path) : '<h1>from disk</h1>';
    },
  } as unknown as ScopedFs;
  return {
    ctx: { platform: 'web', personalityId: 'trader', scopedFs } as unknown as ToolContext,
    reads,
  };
}

const tool = createRenderUiTool(dirFor);

describe('render_ui inline mode', () => {
  it('round-trips html, data and libraries into a canvas envelope', async () => {
    const { ctx } = makeCtx();
    const result = await tool.execute(
      {
        title: 'Sector flow',
        html: '<div id="root"></div>',
        data: { sectors: ['IT'] },
        libraries: ['echarts@1'],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('rendered canvas: Sector flow');
    const card = (
      result.structured as { card: { kind: string; specVersion: number; payload: unknown } }
    ).card;
    expect(card.kind).toBe('canvas');
    expect(card.specVersion).toBe(CARD_SPEC_VERSION);
    expect(CanvasCardPayloadSchema.safeParse(card.payload).success).toBe(true);
    expect(card.payload).toMatchObject({
      title: 'Sector flow',
      html: '<div id="root"></div>',
      data: { sectors: ['IT'] },
      libraries: ['echarts@1'],
    });
  });

  it('is gated by the personality toolset, not always included', () => {
    expect(tool.toolset).toBe('ui');
    expect(tool.alwaysInclude).toBeFalsy();
  });
});

describe('render_ui template mode', () => {
  it('reads through scopedFs and inlines the resolved html', async () => {
    const { ctx, reads } = makeCtx();
    const result = await tool.execute({ template: 'market-brief', title: 'Brief' }, ctx);
    expect(reads).toEqual([`${PERSONALITY_DIR}/ui/market-brief.html`]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structured).toMatchObject({ card: { payload: { html: '<h1>from disk</h1>' } } });
  });

  it.each(['../secrets', 'a/b', '/etc/passwd', 'brief.html', '..'])(
    'rejects template %s before any read',
    async (template) => {
      const { ctx, reads } = makeCtx();
      const result = await tool.execute({ template }, ctx);
      expect(result).toMatchObject({ ok: false, code: 'input_invalid', field: 'template' });
      expect(reads).toEqual([]);
    },
  );

  it('refuses when the personality directory cannot be resolved', async () => {
    const { ctx, reads } = makeCtx();
    const result = await createRenderUiTool(() => undefined).execute({ template: 'brief' }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
    expect(reads).toEqual([]);
  });

  it('refuses when there is no personality context', async () => {
    const { ctx } = makeCtx();
    const result = await tool.execute({ template: 'brief' }, {
      ...ctx,
      personalityId: undefined,
    } as unknown as ToolContext);
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
  });

  it('refuses when scopedFs is absent, naming fs_reach', async () => {
    const result = await tool.execute({ template: 'brief' }, {
      platform: 'web',
      personalityId: 'trader',
    } as unknown as ToolContext);
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
    if (result.ok) return;
    expect(result.error).toContain('fs_reach');
  });

  it('translates a BoundaryError into a refusal naming the template', async () => {
    const { ctx } = makeCtx(() => {
      throw new BoundaryError('read', '/elsewhere/ui/brief.html', [PERSONALITY_DIR]);
    });
    const result = await tool.execute({ template: 'brief' }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
    if (result.ok) return;
    expect(result.error).toContain('brief');
  });

  it('reports a missing template rather than an empty canvas', async () => {
    const { ctx } = makeCtx(async () => '');
    const result = await tool.execute({ template: 'brief' }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
    if (result.ok) return;
    expect(result.error).toContain('brief');
  });
});

describe('render_ui argument validation', () => {
  it('rejects both html and template', async () => {
    const { ctx, reads } = makeCtx();
    const result = await tool.execute({ html: '<p>x</p>', template: 'brief' }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
    expect(reads).toEqual([]);
  });

  it('rejects neither html nor template', async () => {
    const { ctx } = makeCtx();
    const result = await tool.execute({ title: 'Nothing' }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'input_invalid' });
  });

  it('rejects oversized html, naming the actual size', async () => {
    const { ctx } = makeCtx();
    const result = await tool.execute({ html: 'x'.repeat(65537) }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'input_invalid', field: 'html' });
    if (result.ok) return;
    expect(result.error).toContain('65537');
  });

  it('rejects oversized data, naming the actual size', async () => {
    const { ctx } = makeCtx();
    const result = await tool.execute({ html: '<p>x</p>', data: { blob: 'x'.repeat(33000) } }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'input_invalid', field: 'data' });
    if (result.ok) return;
    expect(result.error).toMatch(/\d+ chars/);
  });

  it('rejects an unknown library and names the allowlist', async () => {
    const { ctx } = makeCtx();
    const result = await tool.execute({ html: '<p>x</p>', libraries: ['d3@7'] }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'input_invalid', field: 'libraries' });
    if (result.ok) return;
    expect(result.error).toContain('d3@7');
    expect(result.error).toContain('echarts@1');
  });
});

describe('render_ui off-surface backstop', () => {
  it('refuses politely on a channel platform', async () => {
    const { ctx, reads } = makeCtx();
    const result = await tool.execute({ template: 'brief' }, {
      ...ctx,
      platform: 'slack',
    } as unknown as ToolContext);
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
    expect(reads).toEqual([]);
  });
});
