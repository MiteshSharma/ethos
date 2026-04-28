import { contract } from '@ethosagent/web-contracts';
import { implement } from '@orpc/server';
import type { ApprovalsService } from '../services/approvals.service';
import type { ChatService } from '../services/chat.service';
import type { ConfigService } from '../services/config.service';
import type { CronService } from '../services/cron.service';
import type { EvolverService } from '../services/evolver.service';
import type { LabService } from '../services/lab.service';
import type { MemoryService } from '../services/memory.service';
import type { MeshService } from '../services/mesh.service';
import type { OnboardingService } from '../services/onboarding.service';
import type { PersonalitiesService } from '../services/personalities.service';
import type { PlatformsService } from '../services/platforms.service';
import type { PluginsService } from '../services/plugins.service';
import type { SessionsService } from '../services/sessions.service';
import type { SkillsService } from '../services/skills.service';

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
  approvals: ApprovalsService;
  cron: CronService;
  skills: SkillsService;
  evolver: EvolverService;
  mesh: MeshService;
  memory: MemoryService;
  plugins: PluginsService;
  platforms: PlatformsService;
  lab: LabService;
}

export const os = implement(contract).$context<RpcContext>();
