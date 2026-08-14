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
  // Lane mode is NOT gated on `context.voice`: the mode is a conversation
  // setting the operator can hold whether or not a provider is configured
  // today, and it is read by the gateway too.
  laneMode: {
    get: os.voice.laneMode.get.handler(({ input, context }) =>
      context.voiceLaneMode.get(input.sessionId),
    ),
    set: os.voice.laneMode.set.handler(({ input, context }) =>
      context.voiceLaneMode.set(input.sessionId, input.mode),
    ),
  },
  satellites: {
    list: os.voice.satellites.list.handler(({ context }) => ({
      nodes: (context.satellites?.list() ?? []).map((n) => ({
        nodeId: n.nodeId,
        laneId: n.laneId,
        displayName: n.displayName ?? null,
        capabilities: n.capabilities,
        state: n.state,
        stateDetail: n.stateDetail ?? null,
        wakeEnabled: n.wakeEnabled,
        probes: n.probes.map((p) => ({ name: p.name, ok: p.ok, detail: p.detail ?? null })),
        lastWake: n.lastWake ?? null,
        connectedAt: n.connectedAt,
      })),
    })),
    setWakeEnabled: os.voice.satellites.setWakeEnabled.handler(({ input, context }) => ({
      ok: context.satellites?.setWakeEnabled(input.nodeId, input.enabled) ?? false,
    })),
  },
  wakeRoutes: {
    get: os.voice.wakeRoutes.get.handler(({ context }) => context.wakeRoutes.get()),
    set: os.voice.wakeRoutes.set.handler(({ input, context }) =>
      context.wakeRoutes.set(input.routes),
    ),
  },
};
