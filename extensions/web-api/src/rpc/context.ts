import { contract } from '@ethosagent/web-contracts';
import { implement } from '@orpc/server';
import type { ChatService } from '../services/chat.service';
import type { ConfigService } from '../services/config.service';
import type { OnboardingService } from '../services/onboarding.service';
import type { PersonalitiesService } from '../services/personalities.service';
import type { SessionsService } from '../services/sessions.service';

// Shared context type for every oRPC handler in the web-api. Each namespace
// file imports `os` from here (not from `@orpc/server` directly) so TypeScript
// sees one consistent context shape across the merged router.
//
// Adding a service: add the field here, register it in `createWebApi` →
// `createRoutes` → `RpcRoutesOptions.services`, and the new namespace's
// handlers can reach it via `({ context }) => context.<name>`.

export interface RpcContext {
  sessions: SessionsService;
  chat: ChatService;
  personalities: PersonalitiesService;
  config: ConfigService;
  onboarding: OnboardingService;
}

export const os = implement(contract).$context<RpcContext>();
