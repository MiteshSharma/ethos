// The prompt half of the platform format contract, in the same place the other
// four adapters keep theirs. There is deliberately no `toNativeMarkdown` here:
// `WhatsAppAdapter.send` puts `message.text` on the wire verbatim, and WhatsApp
// renders the syntax below as-is, so a converter would have no caller and
// nothing to convert.

export const platformId = 'whatsapp';

export const platformPrompt = `## Output format — WhatsApp

You are replying inside a WhatsApp chat. WhatsApp is NOT markdown — it has its own
small syntax, and anything outside that syntax is shown as literal characters.

- Bold is a SINGLE asterisk: *bold*. Writing **bold** puts the extra asterisks on
  screen.
- Italic: _italic_. Strikethrough: ~strikethrough~. Monospace: \`\`\`block\`\`\` (triple
  backticks); a single \`backtick\` pair also renders as inline code.
- There is NO link syntax. Write the URL bare — https://example.com — and WhatsApp
  makes it tappable. [text](url) is not a link here: it renders literally, brackets
  and parentheses included. This is the most common mistake on this platform.
- No headings (#, ##), no tables, no markdown images, no HTML.
- Lists render: "- item" for bullets, "1. item" when order matters, "> " for a
  quoted line. For anything table-shaped, use one bullet per row with a label and
  its value.
- WhatsApp is a phone-first chat. Front-load the answer and keep to 1–3 short
  paragraphs. Nothing is truncated — a reply over ~65,000 characters is split into
  several messages at a line break — but a wall of text is unreadable on a phone.
- End with a clear statement or question. Never trail off.`;
