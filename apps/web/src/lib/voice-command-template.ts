// Validation for the `command-stt` / `command-tts` shell templates edited on the
// Settings page (`auxiliary.asr.command` / `auxiliary.tts.command`).
//
// Both factories in `extensions/voice-providers/src/command-{stt,tts}.ts` THROW
// when `command` is missing, so a saved-but-empty template resolves to "voice
// silently doesn't work" at the next utterance. Catching it in the form turns
// that into an inline error next to the field that caused it.

/** Placeholders `command-stt` substitutes (extensions/voice-providers/src/command-stt.ts). */
export const COMMAND_STT_PLACEHOLDERS = '{input_path} {output_path} {language}';

/** Placeholders `command-tts` substitutes (extensions/voice-providers/src/command-tts.ts). */
export const COMMAND_TTS_PLACEHOLDERS = '{input_path} {output_path} {format} {voice} {speed}';

/** Verified macOS recipe — `say` derives its container from `--file-format`, so
 *  without these flags `-o out.mp3` writes a 16-byte silent file (exit 0). */
export const COMMAND_TTS_EXAMPLE =
  'say --file-format=WAVE --data-format=LEI16@22050 -o {output_path} -f {input_path}';

/** whisper.cpp's `-of` appends `.txt` itself, while `{output_path}` already ends
 *  in `.txt` — hence the `-of {input_path}` + `mv` shape. */
export const COMMAND_STT_EXAMPLE =
  'whisper-cli -f {input_path} -otxt -of {input_path} && mv {input_path}.txt {output_path}';

/** Ethos writes the input to a temp file and reads the output back from another,
 *  so a template naming neither path can never produce audio or a transcript. */
const REQUIRED_PLACEHOLDERS = ['{input_path}', '{output_path}'] as const;

/**
 * @returns the error to show inline, or `null` when the template is usable.
 */
export function validateCommandTemplate(value: string | null | undefined): string | null {
  const command = (value ?? '').trim();
  if (command.length === 0) {
    return 'A command template is required — the provider refuses to start without one.';
  }
  const missing = REQUIRED_PLACEHOLDERS.filter((p) => !command.includes(p));
  if (missing.length > 0) {
    return `Command must include ${missing.join(' and ')} — Ethos substitutes the temp file paths there.`;
  }
  return null;
}
