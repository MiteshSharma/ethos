import type { Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ageVisionBlocks, stripVisionBlocksForSummary } from '../vision-aging';

// C3 — recency-based block aging.

function userWithImage(filename?: string): Message {
  return {
    role: 'user',
    content: [
      { type: 'image', mediaType: 'image/png', data: 'AAAA', ...(filename ? { filename } : {}) },
      { type: 'text', text: 'what broke?' },
    ],
  };
}

const assistant: Message = { role: 'assistant', content: 'looking' };

describe('ageVisionBlocks', () => {
  it('keeps blocks inside the recency window', () => {
    const messages: Message[] = [userWithImage('shot.png'), assistant];
    expect(ageVisionBlocks(messages)).toBe(messages); // same reference — no allocation
  });

  it('ages blocks out past the window, naming the file', () => {
    const messages: Message[] = [
      userWithImage('shot.png'),
      assistant,
      assistant,
      assistant,
      assistant,
      assistant,
    ];
    const aged = ageVisionBlocks(messages);
    expect(aged[0]?.content).toEqual([
      { type: 'text', text: '[image aged out: shot.png]' },
      { type: 'text', text: 'what broke?' },
    ]);
  });

  it('falls back to an unnamed placeholder when the block has no filename', () => {
    const messages: Message[] = [
      userWithImage(),
      assistant,
      assistant,
      assistant,
      assistant,
      assistant,
    ];
    const aged = ageVisionBlocks(messages);
    expect(aged[0]?.content).toEqual([
      { type: 'text', text: '[image aged out]' },
      { type: 'text', text: 'what broke?' },
    ]);
  });

  it('labels documents as documents', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'document', mediaType: 'application/pdf', data: 'JV', filename: 'q3.pdf' },
        ],
      },
      assistant,
      assistant,
      assistant,
      assistant,
      assistant,
    ];
    expect(ageVisionBlocks(messages)[0]?.content).toEqual([
      { type: 'text', text: '[document aged out: q3.pdf]' },
    ]);
  });

  it('never mutates the input', () => {
    const messages: Message[] = [
      userWithImage('shot.png'),
      assistant,
      assistant,
      assistant,
      assistant,
      assistant,
    ];
    const before = JSON.stringify(messages);
    ageVisionBlocks(messages);
    // Aging happens at prompt build; the stored session keeps its blocks so a
    // fork or replay still has them.
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('leaves tool_use and tool_result blocks alone', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      assistant,
      assistant,
      assistant,
      assistant,
      assistant,
    ];
    const aged = ageVisionBlocks(messages);
    expect(aged[1]?.content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
  });
});

describe('stripVisionBlocksForSummary', () => {
  it('strips every block regardless of recency', () => {
    const messages: Message[] = [userWithImage('shot.png'), assistant];
    expect(stripVisionBlocksForSummary(messages)[0]?.content).toEqual([
      { type: 'text', text: '[image aged out: shot.png]' },
      { type: 'text', text: 'what broke?' },
    ]);
  });
});
