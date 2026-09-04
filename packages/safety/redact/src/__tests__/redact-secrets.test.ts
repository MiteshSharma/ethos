import { describe, expect, it } from 'vitest';
import { detectSecrets, redactString } from '../index';

// This repo ships an xAI LLM provider and an `x_search` tool that share the
// `providers/xai/apiKey` credential, so a leaked `xai-...` key can reach a log
// from two directions. The pattern is deliberately conservative: xAI documents
// the format only as "xai- followed by a long alphanumeric string".
const XAI_KEY = `xai-${'A1b2C3d4E5f6G7h8I9j0'.repeat(4)}`;

describe('redactString — xAI API keys', () => {
  it('redacts a realistic xAI key to the tag', () => {
    const result = redactString(`export XAI_API_KEY=${XAI_KEY}`);
    expect(result).toBe('export XAI_API_KEY=[REDACTED:xai-key]');
    expect(result).not.toContain('A1b2C3d4');
  });

  it('redacts an xAI key embedded in prose', () => {
    const result = redactString(`the key is ${XAI_KEY}, do not share it`);
    expect(result).toBe('the key is [REDACTED:xai-key], do not share it');
  });

  it('reports the xAI label from detectSecrets', () => {
    expect(detectSecrets(XAI_KEY)).toEqual([{ label: 'xAI API key' }]);
  });

  it('leaves the bare prefix and a too-short body alone', () => {
    const nearMisses = 'xai- and xai-key and xai-short123 and xai-abc';
    expect(redactString(nearMisses)).toBe(nearMisses);
    expect(detectSecrets(nearMisses)).toEqual([]);
  });

  it('does not shadow, and is not shadowed by, the neighbouring provider keys', () => {
    const groq = `gsk_${'B'.repeat(52)}`;
    const openai = `sk-proj-${'C'.repeat(48)}`;
    const result = redactString(`${XAI_KEY} ${groq} ${openai}`);
    expect(result).toBe('[REDACTED:xai-key] [REDACTED:groq-key] [REDACTED:openai-key]');
  });

  it('is idempotent — the tag itself is not re-redacted', () => {
    const first = redactString(`key ${XAI_KEY}`);
    expect(redactString(first)).toBe(first);
  });
});
