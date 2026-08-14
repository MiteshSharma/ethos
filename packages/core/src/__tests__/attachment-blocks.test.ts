import type { Attachment } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { canInlineNatively, encodeNativeBlocks } from '../attachment-blocks';

// C1 — the capability gate and the per-turn block cap.

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';

function att(over: Partial<Attachment> = {}): Attachment {
  return {
    type: 'image',
    ref: 'r1',
    url: `data:image/png;base64,${PNG_B64}`,
    mimeType: 'image/png',
    filename: 'shot.png',
    ...over,
  };
}

const PDF = att({
  type: 'file',
  mimeType: 'application/pdf',
  filename: 'report.pdf',
  url: 'data:application/pdf;base64,JVBERi0xLjQK',
});

describe('canInlineNatively', () => {
  it('gates images and documents on their own capability flag', () => {
    expect(canInlineNatively(att(), { images: true, documents: false })).toBe(true);
    expect(canInlineNatively(att(), { images: false, documents: true })).toBe(false);
    expect(canInlineNatively(PDF, { images: true, documents: false })).toBe(false);
    expect(canInlineNatively(PDF, { images: false, documents: true })).toBe(true);
  });

  it('decides on media type, not the channel-assigned attachment type', () => {
    // Slack labels a PDF as a generic `file`; the mime type is what counts.
    expect(canInlineNatively(PDF, { images: false, documents: true })).toBe(true);
    // An audio file is never inlineable, whatever the flags say.
    expect(
      canInlineNatively(att({ type: 'audio', mimeType: 'audio/mpeg' }), {
        images: true,
        documents: true,
      }),
    ).toBe(false);
  });

  it('is case-insensitive about the media type', () => {
    expect(
      canInlineNatively(att({ mimeType: 'IMAGE/PNG' }), { images: true, documents: false }),
    ).toBe(true);
  });
});

describe('encodeNativeBlocks', () => {
  it('encodes image and document blocks from data: URLs', async () => {
    const { blocks, errors } = await encodeNativeBlocks([att(), PDF], {});
    expect(errors).toEqual([]);
    // The filename rides along so block aging can name what it removed.
    expect(blocks).toEqual([
      { type: 'image', mediaType: 'image/png', data: PNG_B64, filename: 'shot.png' },
      {
        type: 'document',
        mediaType: 'application/pdf',
        data: 'JVBERi0xLjQK',
        filename: 'report.pdf',
      },
    ]);
  });

  it('omits filename when the attachment has none', async () => {
    const { blocks } = await encodeNativeBlocks([att({ filename: undefined })], {});
    expect(blocks).toEqual([{ type: 'image', mediaType: 'image/png', data: PNG_B64 }]);
  });

  it('reverts the whole turn to annotation when over the block cap', async () => {
    const many = Array.from({ length: 9 }, (_, i) => att({ ref: `r${i}`, filename: `s${i}.png` }));
    const { blocks, errors } = await encodeNativeBlocks(many, {});
    // All-or-nothing: 8 of 9 would have the model answer about the 8 and never
    // mention the 9th.
    expect(blocks).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('9 images/documents');
    expect(errors[0]).toContain('at most 8');
  });

  it('sends exactly the cap without complaint', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => att({ ref: `r${i}` }));
    const { blocks, errors } = await encodeNativeBlocks(eight, {});
    expect(blocks).toHaveLength(8);
    expect(errors).toEqual([]);
  });

  it('costs only itself when one file is unreadable', async () => {
    const { blocks, errors } = await encodeNativeBlocks(
      [att(), att({ ref: 'bad', filename: 'gone.png', url: 'https://example.com/gone.png' })],
      {},
    );
    expect(blocks).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('gone.png');
  });

  it('rejects a file over the per-media byte cap', async () => {
    // 6 MB of base64 zeroes — over the 5 MB image limit.
    const huge = 'A'.repeat(Math.ceil((6 * 1024 * 1024 * 4) / 3));
    const { blocks, errors } = await encodeNativeBlocks(
      [att({ filename: 'huge.png', url: `data:image/png;base64,${huge}` })],
      {},
    );
    expect(blocks).toEqual([]);
    expect(errors[0]).toContain('huge.png');
    expect(errors[0]).toContain('5 MB limit');
  });

  it('is a no-op for an empty candidate list', async () => {
    expect(await encodeNativeBlocks([], {})).toEqual({ blocks: [], errors: [] });
  });
});
