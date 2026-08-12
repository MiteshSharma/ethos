import { os } from './context';

export const voiceRouter = {
  transcribe: os.voice.transcribe.handler(async ({ input, context }) => {
    if (!context.voice) {
      throw new Error('Voice transcription not configured');
    }
    const transcript = await context.voice.transcribe(input.audio, input.mimeType);
    return { transcript };
  }),
  synthesize: os.voice.synthesize.handler(async ({ input, context }) => {
    if (!context.voice) throw new Error('Voice synthesis not configured');
    return context.voice.synthesize(input.text, {
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      ...(input.language ? { language: input.language } : {}),
    });
  }),
};
