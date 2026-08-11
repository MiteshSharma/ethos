import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SttProvider,
  VoiceCapabilities,
  VoiceProviderFactoryContext,
} from '@ethosagent/types';

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
      contractVersion: 1,
    };
  }

  async transcribe(audioPath: string, opts?: { language?: string }): Promise<string> {
    const outputPath = join(tmpdir(), `ethos-stt-${randomBytes(8).toString('hex')}.txt`);
    const cmd = this.command
      .replace(/\{input_path\}/g, audioPath)
      .replace(/\{output_path\}/g, outputPath)
      .replace(/\{language\}/g, opts?.language ?? 'auto');

    try {
      await new Promise<void>((resolve, reject) => {
        execFile('sh', ['-c', cmd], { timeout: this.timeout }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      const result = await readFile(outputPath, 'utf-8');
      return result.trim();
    } finally {
      await unlink(outputPath).catch(() => {});
    }
  }
}

/**
 * Registry factory for `command-stt` — the recipe path (whisper.cpp, any CLI
 * transcriber). The operator supplies the command template in config:
 *
 *   auxiliary.asr.provider: command-stt
 *   auxiliary.asr.command: whisper-cli -f {input_path} -otxt -of {output_path}
 *
 * `command` is required: without it there is nothing to run, and a provider
 * that resolves but can never transcribe is worse than a refusal.
 */
export function commandSttFactory(ctx: VoiceProviderFactoryContext): CommandSttProvider {
  const command = ctx.config.command;
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error(
      'command-stt requires a `command` template (e.g. `whisper-cli -f {input_path} -otxt -of {output_path}`)',
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
