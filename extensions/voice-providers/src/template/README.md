# create-ethos-voice-provider

Starter template for building a custom Ethos voice provider plugin.

## Quick start

1. Copy this template directory
2. Implement `SttProvider` and/or `TtsProvider` from `@ethosagent/types`
3. Export a factory function and call `registerSttProvider`/`registerTtsProvider` in your plugin's `activate()`
4. Declare `ethos.pluginContractMajor: 4` in your `package.json`

## Example STT provider

An STT provider receives the utterance **as bytes**, never as a path. Declare
`STT_CONTRACT_VERSION` in your caps — a provider still declaring `1` is claiming
the removed `transcribe(audioPath)` signature and fails conformance.

```typescript
import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import type { SttAudio, SttProvider, VoiceCapabilities } from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';

class MySttProvider implements SttProvider {
  readonly name = 'my-stt';
  readonly caps: VoiceCapabilities = {
    kind: 'stt',
    formats: ['opus', 'mp3', 'wav'],
    local: false,
    contractVersion: STT_CONTRACT_VERSION,
  };

  async transcribeBuffer(
    audio: SttAudio,
    opts?: { language?: string; signal?: AbortSignal },
  ): Promise<string> {
    // `audio.data` is the complete utterance; `audio.mimeType` describes it
    // (e.g. 'audio/webm', 'audio/wav'). Honour `opts.signal` so barge-in can
    // abort an in-flight upload.
    return 'transcribed text';
  }
}

export function activate(api: EthosPluginApi): void {
  api.registerSttProvider('my-stt', () => new MySttProvider());
}
```

If your transcriber is a binary that needs a file on disk, write your own temp
file inside `transcribeBuffer` and delete it in a `finally` — see
`command-stt.ts`. Do not ask the caller for a path: captured voice is the most
sensitive artifact the system handles, and whoever writes it owns deleting it.

### Streaming STT (optional)

Implement `StreamingSttProvider` in addition and set `caps.streaming: true`.
Callers prefer `transcribeStream` when the flag is set and fall back to
`transcribeBuffer` otherwise, so a streaming provider must still implement both.

## Example TTS provider

```typescript
import type { TtsProvider, VoiceCapabilities } from '@ethosagent/types';

class MyTtsProvider implements TtsProvider {
  readonly name = 'my-tts';
  readonly caps: VoiceCapabilities = {
    kind: 'tts',
    formats: ['mp3'],
    local: false,
    maxInputChars: 5000,
    contractVersion: 1,
  };

  async synthesize(text: string): Promise<{ audio: Uint8Array; format: 'mp3' }> {
    // Your implementation here
    return { audio: new Uint8Array(0), format: 'mp3' };
  }
}
```

## Config-only (command) provider

No code needed — just add to `~/.ethos/config.yaml`:

```yaml
auxiliary:
  tts:
    provider: my-local-tts
    providers:
      my-local-tts:
        type: command
        command: "piper --model en_US-lessac-medium --output-file {output_path} < {input_path}"
        output_format: wav
```

## Conformance

Use `validateSttProvider` / `validateTtsProvider` from `@ethosagent/voice-providers`
to check the whole provider — caps *and* the methods those caps promise:

```typescript
import { validateSttProvider } from '@ethosagent/voice-providers';

const errors = validateSttProvider(myProvider);
if (errors.length > 0) throw new Error(errors.join(', '));
```

`validateVoiceCaps` is still exported for a caps-only check.
