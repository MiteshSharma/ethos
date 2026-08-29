import { describe, expect, it } from 'vitest';
import { toNativeMarkdown } from '../format';

// CHS-004 — Slack treats `<!channel>`, `<!here>`, `<!everyone>` and `<@Uxxx>`
// as control sequences anywhere in message text. Before escaping ran first,
// model output containing any of them broadcast-pinged the workspace.

describe('toNativeMarkdown — mention injection', () => {
  it.each(['<!channel>', '<!here>', '<!everyone>'])('neutralises %s', (mention) => {
    const out = toNativeMarkdown(`heads up ${mention} the build is red`);
    expect(out).not.toContain(mention);
    expect(out).toContain('&lt;!');
  });

  it('neutralises a direct user ping', () => {
    const out = toNativeMarkdown('ask <@U123456> about it');
    expect(out).not.toContain('<@U123456>');
    expect(out).toContain('&lt;@U123456&gt;');
  });

  it('escapes bare angle brackets and ampersands', () => {
    expect(toNativeMarkdown('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });

  it('does not double-escape the ampersand it just wrote', () => {
    expect(toNativeMarkdown('Tom & Jerry')).toBe('Tom &amp; Jerry');
    expect(toNativeMarkdown('5 < 6')).toBe('5 &lt; 6');
  });
});

describe('toNativeMarkdown — generated syntax stays live', () => {
  it('emits real link delimiters while escaping the model’s own brackets', () => {
    const out = toNativeMarkdown('see [the docs](https://example.com/a) and <!channel>');
    expect(out).toContain('<https://example.com/a|the docs>');
    expect(out).not.toContain('<!channel>');
  });

  it('still converts headers and bold', () => {
    expect(toNativeMarkdown('# Title')).toBe('*Title*');
    expect(toNativeMarkdown('**strong**')).toBe('*strong*');
  });

  it('keeps a link whose text contains an angle bracket inert', () => {
    // The label is escaped; only the delimiters we generate are live.
    const out = toNativeMarkdown('[a<b](https://example.com)');
    expect(out).toBe('<https://example.com|a&lt;b>');
  });
});
