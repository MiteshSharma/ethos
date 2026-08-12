import { os } from './context';

export const voiceRouter = {
  transcribe: os.voice.transcribe.handler(async ({ input, context }) => {
    if (!context.voice) {
      throw new Error('Voice transcription not configured');
    }
    const transcript = await context.voice.transcribe(input.audio, input.mimeType, {
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      ...(input.language ? { language: input.language } : {}),
    });
    return { transcript };
  }),
  synthesize: os.voice.synthesize.handler(async ({ input, context }) => {
    if (!context.voice) throw new Error('Voice synthesis not configured');
    return context.voice.synthesize(input.text, {
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.override ? { override: input.override } : {}),
    });
  }),
  ttsEntries: os.voice.ttsEntries.handler(async ({ context }) => {
    // No service wired = nothing configured, which is a legitimate state the
    // personality editor renders around — not an error to throw at it.
    if (!context.voice) return { default: { providerId: null, voices: null }, roster: {} };
    return context.voice.listTtsEntries();
  }),
  sttEntries: os.voice.sttEntries.handler(async ({ context }) => {
    if (!context.voice) return { default: { providerId: null }, roster: {} };
    return context.voice.listSttEntries();
  }),
  realtimeEntries: os.voice.realtimeEntries.handler(async ({ context }) => {
    // No service wired = no realtime tier, which is the same answer the editor
    // renders for a deployment that configured no roster.
    if (!context.voice) return { roster: {}, defaultEntryName: null };
    return context.voice.listRealtimeEntries();
  }),
  realtimeToken: os.voice.realtimeToken.handler(async ({ input, context }) => {
    // No service wired = no realtime tier, which is a state the browser
    // renders (it starts a pipeline call) rather than an error to throw at it.
    if (!context.voice) {
      return {
        ok: false as const,
        reason: 'not_configured' as const,
        message: 'No realtime voice provider is configured for this deployment.',
        providerId: null,
      };
    }
    return context.voice.mintRealtimeToken({
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
    });
  }),
};
