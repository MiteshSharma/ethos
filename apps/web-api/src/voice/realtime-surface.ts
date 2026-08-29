import { buildRealtimeInstructions, deriveRealtimeToolset } from '@ethosagent/tools-voice';
import type { PersonalityConfig, Storage, ToolRegistry } from '@ethosagent/types';
import type { RealtimeSessionSurface } from '../services/voice.service';

// Who a realtime session IS, and what it may call — resolved at mint time.
//
// The personality's SOUL.md becomes the session instructions verbatim, with the
// consult boundary policy appended. That is the same identity the text agent
// runs on, from the same file: a personality that switches tiers must not
// switch character, and the way to guarantee that is to read the one artifact
// rather than write a voice-flavoured paraphrase of it.
//
// The tool list is GENERATED from the wired registry, never hand-listed. See
// `deriveRealtimeToolset` for why a hand-listed one is a model announcing a
// capability out loud that nothing can service.

export interface RealtimeSurfaceOptions {
  /** Reads SOUL.md. The personality boundary applies here like everywhere. */
  storage: Storage;
  /** The registry the agent runs on. */
  toolRegistry?: ToolRegistry;
  /** Personality lookup — supplies `soulFile` and `toolset`. */
  personalities: {
    get(id: string): PersonalityConfig | undefined;
    getDefault(): PersonalityConfig;
  };
  /** Hot-reload seam, so an edited SOUL.md is heard on the next call. */
  refresh?: () => Promise<void>;
}

export function createRealtimeSurface(opts: RealtimeSurfaceOptions): RealtimeSessionSurface {
  return {
    async describe(personalityId) {
      // Same refresh-before-resolve rule the chat and personality surfaces
      // follow: a SOUL.md edited a minute ago is heard on the next call, not
      // after a restart. Fail-open — a malformed personality on disk must not
      // take voice down.
      await opts.refresh?.().catch(() => {});
      const personality = personalityId
        ? (opts.personalities.get(personalityId) ?? opts.personalities.getDefault())
        : opts.personalities.getDefault();
      const soul = personality.soulFile ? await opts.storage.read(personality.soulFile) : null;
      const tools = opts.toolRegistry
        ? deriveRealtimeToolset({
            registry: opts.toolRegistry,
            ...(personality.toolset ? { personalityToolset: personality.toolset } : {}),
          })
        : [];
      return { instructions: buildRealtimeInstructions(soul), tools };
    },
  };
}
