import { describe, expect, it } from 'vitest';
import {
  COMMAND_STT_EXAMPLE,
  COMMAND_STT_PLACEHOLDERS,
  COMMAND_TTS_EXAMPLE,
  COMMAND_TTS_PLACEHOLDERS,
  validateCommandTemplate,
} from '../voice-command-template';

// The Settings field for `auxiliary.asr.command` / `auxiliary.tts.command`.
// `commandSttFactory` / `commandTtsFactory` throw on a missing template, and a
// template that never names the temp files runs but produces nothing — both are
// caught here so the user sees the reason next to the field.

describe('validateCommandTemplate', () => {
  it('requires a template — the provider refuses to construct without one', () => {
    expect(validateCommandTemplate('')).toBe(
      'A command template is required — the provider refuses to start without one.',
    );
    expect(validateCommandTemplate('   ')).toBe(
      'A command template is required — the provider refuses to start without one.',
    );
    expect(validateCommandTemplate(undefined)).toContain('required');
    expect(validateCommandTemplate(null)).toContain('required');
  });

  it('rejects a template missing {output_path}', () => {
    expect(validateCommandTemplate('say -f {input_path}')).toBe(
      'Command must include {output_path} — Ethos substitutes the temp file paths there.',
    );
  });

  it('rejects a template missing {input_path}', () => {
    expect(validateCommandTemplate('say hello -o {output_path}')).toBe(
      'Command must include {input_path} — Ethos substitutes the temp file paths there.',
    );
  });

  it('names both placeholders when neither is present', () => {
    expect(validateCommandTemplate('say hello')).toBe(
      'Command must include {input_path} and {output_path} — Ethos substitutes the temp file paths there.',
    );
  });

  it('accepts the shipped macOS TTS and whisper.cpp STT recipes', () => {
    expect(validateCommandTemplate(COMMAND_TTS_EXAMPLE)).toBeNull();
    expect(validateCommandTemplate(COMMAND_STT_EXAMPLE)).toBeNull();
  });

  it('advertises exactly the placeholders the providers substitute', () => {
    // Mirrors extensions/voice-providers/src/command-{stt,tts}.ts.
    expect(COMMAND_STT_PLACEHOLDERS).toBe('{input_path} {output_path} {language}');
    expect(COMMAND_TTS_PLACEHOLDERS).toBe('{input_path} {output_path} {format} {voice} {speed}');
  });
});
