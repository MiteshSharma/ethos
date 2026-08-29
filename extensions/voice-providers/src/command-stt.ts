import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SttAudio,
  SttProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { AUDIO_EXT_BY_MIME, baseMimeType } from './openai-compat';

export interface CommandSttConfig {
  name: string;
  command: string;
  outputFormat?: string;
  timeout?: number;
  languages?: string[];
}

export class CommandSttProvider implements SttProvider {
  readonly name: string;
  readonly caps: VoiceCapabilities;
  private readonly command: string;
  private readonly timeout: number;

  constructor(config: CommandSttConfig) {
    this.name = config.name;
    this.command = config.command;
    this.timeout = (config.timeout ?? 120) * 1000;
    this.caps = {
      kind: 'stt',
      formats: ['opus', 'mp3', 'wav'],
      local: true,
      languages: config.languages,
      contractVersion: STT_CONTRACT_VERSION,
    };
  }

  /**
   * The one provider that genuinely needs a path: it hands `{input_path}` to a
   * binary. So it materializes the utterance itself, in the OS temp dir, mode
   * 0o600, and unlinks it in `finally` — the file never outlives the call that
   * created it. This is deliberately provider-local: the alternative (every
   * caller writing a temp file so ONE provider can read one) is what the
   * buffer contract exists to delete.
   *
   * `~/.ethos/` access goes through `Storage`; this is `os.tmpdir()` and a
   * provider-owned lifetime, which is why `extensions/voice-providers/` is a
   * documented `node:fs` carve-out (see `apps/ethos/src/__tests__/no-raw-fs.test.ts`).
   */
  async transcribeBuffer(audio: SttAudio, opts?: { language?: string }): Promise<string> {
    const stem = `ethos-stt-${randomBytes(8).toString('hex')}`;
    const inputPath = join(tmpdir(), `${stem}.${extensionFor(audio.mimeType)}`);
    const outputPath = join(tmpdir(), `${stem}.txt`);
    const cmd = this.command
      .replace(/\{input_path\}/g, inputPath)
      .replace(/\{output_path\}/g, outputPath)
      .replace(/\{language\}/g, opts?.language ?? 'auto');

    try {
      await writeFile(inputPath, audio.data, { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        execFile('sh', ['-c', cmd], { timeout: this.timeout }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      const result = await readFile(outputPath, 'utf-8');
      return result.trim();
    } finally {
      await Promise.all([unlink(inputPath).catch(() => {}), unlink(outputPath).catch(() => {})]);
    }
  }
}

/**
 * Extension for the temp input file. CLI transcribers (whisper.cpp and
 * friends) sniff the container from the suffix, so an honest one matters.
 * Unknown/absent MIME → `wav`, the format the utterance-buffered fallback
 * produces and the one every such binary accepts.
 */
function extensionFor(mimeType: string | undefined): string {
  const base = baseMimeType(mimeType);
  return (base ? AUDIO_EXT_BY_MIME[base] : undefined) ?? 'wav';
}

/**
 * Registry factory for `command-stt` — the recipe path (whisper.cpp, any CLI
 * transcriber). The operator supplies the command template in config:
 *
 *   auxiliary.asr.provider: command-stt
 *   auxiliary.asr.command: whisper-cli -f {input_path} -otxt -of {input_path} && mv {input_path}.txt {output_path}
 *
 * whisper.cpp's `-of` takes a path WITHOUT an extension and appends `.txt`
 * itself, while `{output_path}` already ends in `.txt` — so `-of {output_path}`
 * writes `<name>.txt.txt` and this provider then reads a file that was never
 * created. Hence the `-of {input_path}` + `mv` shape above.
 *
 * `command` is required: without it there is nothing to run, and a provider
 * that resolves but can never transcribe is worse than a refusal.
 */
export function commandSttFactory(ctx: VoiceProviderFactoryContext): CommandSttProvider {
  const command = ctx.config.command;
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error(
      'command-stt requires a `command` template ' +
        '(e.g. `whisper-cli -f {input_path} -otxt -of {input_path} && mv {input_path}.txt {output_path}`)',
    );
  }
  const languages = ctx.config.languages;
  const timeout = Number(ctx.config.timeout);
  return new CommandSttProvider({
    name: typeof ctx.config.name === 'string' ? ctx.config.name : 'command-stt',
    command,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
    ...(Array.isArray(languages) ? { languages: languages.map(String) } : {}),
  });
}
