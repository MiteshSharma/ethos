// The one speakable-text sanitizer (voice V1a, eng-review D8).
//
// Everything the model writes for a screen is noise in a speaker: fences read
// as gibberish, a path is spelled out slash by slash, emoji become "smiling
// face with smiling eyes", and a leaked <think> block reads the agent's private
// reasoning aloud. This stage turns a reply into prose a voice can speak.
//
// It removes SYNTAX, never ordinary punctuation — commas, dashes, and question
// marks are what give synthesized speech its prosody.

/** `<think>`/`<thinking>` blocks, including one left unterminated by a cut-off stream. */
const THINK_BLOCK = /<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi;
const THINK_UNTERMINATED = /<think(?:ing)?\b[^>]*>[\s\S]*$/i;

/** Fenced code, including a fence the stream never closed. */
const CODE_FENCE = /```[\s\S]*?```/g;
const CODE_FENCE_UNTERMINATED = /```[\s\S]*$/;

/** Media directives: markdown images and HTML media elements. */
const MEDIA_ELEMENT = /<(audio|video|picture)\b[^>]*>[\s\S]*?<\/\1>/gi;
const MEDIA_TAG = /<(?:img|audio|video|source|track|embed)\b[^>]*\/?>/gi;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/g;

const INLINE_CODE = /`[^`]*`/g;

/** URLs are spelled out character by character by every TTS engine. */
const URL = /\bhttps?:\/\/[^\s<>)\]"']+/gi;
const WWW_URL = /\bwww\.[^\s<>)\]"']+/gi;

/** File paths — absolute, `./`, `../`, `~/`, Windows, and `dir/file.ext`. */
const WINDOWS_PATH = /(?<!\w)[A-Za-z]:\\[^\s"']*/g;
const SLASH_PATH = /(?<!\w)(?:~|\.{1,2})?\/(?:[\w.@%+~-]+\/)+[\w.@%+~-]*/g;
const RELATIVE_FILE =
  /(?<![\w/])[\w@%+~-]+(?:\/[\w.@%+~-]+)*\/[\w.@%+~-]+\.[A-Za-z0-9]{1,6}(?!\w)/g;

// Pictographs, skin-tone modifiers, flag pairs, ZWJ, and variation selectors.
// An alternation rather than one character class: a class cannot express an
// emoji sequence, and each alternative here removes one piece of one.
const EMOJI =
  /\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}]|\uFE0F|\u200D/gu;

function stripHidden(text: string): string {
  return text
    .replace(THINK_BLOCK, '')
    .replace(THINK_UNTERMINATED, '')
    .replace(CODE_FENCE, '')
    .replace(CODE_FENCE_UNTERMINATED, '');
}

function stripMedia(text: string): string {
  return text.replace(MEDIA_ELEMENT, '').replace(MEDIA_TAG, '').replace(MARKDOWN_IMAGE, '');
}

function stripAddresses(text: string): string {
  return text
    .replace(URL, '')
    .replace(WWW_URL, '')
    .replace(WINDOWS_PATH, '')
    .replace(SLASH_PATH, '')
    .replace(RELATIVE_FILE, '');
}

function stripMarkdownSyntax(text: string): string {
  return (
    text
      .replace(INLINE_CODE, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
      .replace(/^#{1,6}\s+/gm, '') // headings
      .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
      .replace(/(\*|_)(.*?)\1/g, '$2') // italic
      .replace(/~~(.*?)~~/g, '$1') // strikethrough
      // `[^\S\n]` not `\s`: `\s` crosses the newline and would swallow the blank
      // line that separates a list from the paragraph after it.
      .replace(/^[^\S\n]*[-*+][^\S\n]+/gm, '') // unordered list markers
      .replace(/^[^\S\n]*\d+\.[^\S\n]+/gm, '') // ordered list markers
      .replace(/^[^\S\n]*>[^\S\n]+/gm, '') // blockquotes
      // Horizontal rules, whole-line only — a prose em dash is not a rule.
      .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
  );
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[^\S\n]{2,}/g, ' ') // runs of spaces/tabs (never newlines)
    .replace(/[^\S\n]+([,.;:!?])/g, '$1') // gap left where a token was removed
    .replace(/[^\S\n]+\n/g, '\n') // trailing spaces on a line
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Reduce agent output to natural, speakable prose. Idempotent, and safe to run
 * on text that contains no markup at all.
 */
export function sanitizeForSpeech(text: string): string {
  return normalizeWhitespace(
    stripMarkdownSyntax(stripAddresses(stripMedia(stripHidden(text)))).replace(EMOJI, ''),
  );
}
