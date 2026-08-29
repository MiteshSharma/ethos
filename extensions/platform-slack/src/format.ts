export const platformId = 'slack';

export const platformPrompt = `## Output format — Slack

You are replying inside a Slack workspace. Follow these rules:

- Use Slack mrkdwn syntax: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, ~strikethrough~.
- Do NOT use standard markdown: no **double asterisks**, no # headers, no --- rules.
- Structure answers with short sections. Use *Section title* (bold) followed by bullet
  lines starting with • or -.
- Bullet lists: use – or • as the bullet character, one item per line.
- For code, always wrap in triple backticks with the language name: \`\`\`python ... \`\`\`.
- Link syntax: <https://example.com|link text>.
- Keep replies scannable. Prefer structure over prose for anything technical.
- Emoji is acceptable for status indicators (:white_check_mark:, :warning:) but use sparingly.
- Maximum reply length: 3000 characters. If more is needed, summarise with an offer to
  continue.`;

/**
 * Render model output as Slack mrkdwn.
 *
 * CHS-004 — escaping runs FIRST, on the raw text, and syntax is generated
 * after. The previous order (convert, then patch up stray delimiters with a
 * lookbehind) never escaped `<` at all, so a model that emitted `<!channel>`
 * broadcast-pinged the whole workspace, and `<@U123>` pinged a member. Slack
 * treats those as control sequences wherever they appear in message text; the
 * only reliable defence is to escape the angle brackets the model wrote and
 * emit only the delimiters we generate ourselves.
 *
 * Escaping first also fixes the legitimate-link breakage the old lookbehind
 * caused, because the link rule now runs against text with no ambient `<`/`>`
 * to trip over.
 */
export function toNativeMarkdown(text: string): string {
  // Slack's documented escape set. Order matters: `&` first, or the entities
  // written by the next two rules get double-escaped.
  let out = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Headers → bold (Slack has no native headers)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Bold: **text** → *text* (must come before italic to avoid conflicts)
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Italic: _text_ stays as _text_ (Slack uses underscore for italic)

  // Links: [text](url) → <url|text>. Generated last so these delimiters are
  // the only unescaped `<`/`>` in the output.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  return out;
}
