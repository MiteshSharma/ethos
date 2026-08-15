import type { AgentLoop, ClarifyBridge } from '@ethosagent/core';
import type { DashboardsService } from '@ethosagent/dashboard';
import type { ToolRegistry } from '@ethosagent/types';
import { contract } from '@ethosagent/web-contracts';
import { implement } from '@orpc/server';
import type { ChatService } from '../features/chat/service';
import type { DebugService } from '../features/debug/service';
import type { SessionsService } from '../features/sessions/service';
import type { ApiKeysService } from '../services/api-keys.service';
import type { ApprovalsService } from '../services/approvals.service';
import type { CallsService } from '../services/calls.service';
import type { ConfigService } from '../services/config.service';
import type { CronService } from '../services/cron.service';
import type { DeliveriesService } from '../services/deliveries.service';
import type { DigestService } from '../services/digest.service';
import type { DocumentsService } from '../services/documents.service';
import type { EvolverService } from '../services/evolver.service';
import type { GoalsService } from '../services/goals.service';
import type { KanbanService } from '../services/kanban.service';
import type { LabService } from '../services/lab.service';
import type { McpService } from '../services/mcp.service';
import type { MemoryService } from '../services/memory.service';
import type { MeshService } from '../services/mesh.service';
import type { NamedSecretsService } from '../services/named-secrets.service';
import type { OnboardingService } from '../services/onboarding.service';
import type { PersonalitiesService } from '../services/personalities.service';
import type { PlatformsService } from '../services/platforms.service';
import type { PluginLoader, PluginsService } from '../services/plugins.service';
import type { SkillsService } from '../services/skills.service';
import type { TasksService } from '../services/tasks.service';
import type { ToolSettingsService } from '../services/tool-settings.service';
import type { VoiceService } from '../services/voice.service';
import type { VoiceLaneModeService } from '../services/voice-lane-mode.service';
import type { WakeRoutesService } from '../services/wake-routes.service';
import type { SatelliteRegistry } from '../voice/satellite-registry';

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
  debug: DebugService;
  personalities: PersonalitiesService;
  config: ConfigService;
  onboarding: OnboardingService;
  approvals: ApprovalsService;
  /** Bridge backing the `clarify` tool — undefined when the loop has none. */
  clarifyBridge?: ClarifyBridge;
  cron: CronService;
  skills: SkillsService;
  evolver: EvolverService;
  goals: GoalsService;
  mesh: MeshService;
  memory: MemoryService;
  plugins: PluginsService;
  mcp: McpService;
  platforms: PlatformsService;
  lab: LabService;
  kanban: KanbanService;
  tasks: TasksService;
  apiKeys: ApiKeysService;
  digest: DigestService;
  /** Browse / delete files under a personality's declared workdir. */
  documents: DocumentsService;
  /** Global named-secrets vault manager (Phase 2). */
  namedSecrets: NamedSecretsService;
  /** Generic per-personality tool settings (Phase 2). */
  toolSettings: ToolSettingsService;
  toolRegistry?: ToolRegistry;
  dashboards?: DashboardsService;
  pluginLoader?: PluginLoader;
  agentLoop?: AgentLoop;
  voice?: VoiceService;
  /** Durable per-conversation voice mode, shared with the gateway's lanes.
   *  Not optional: it needs no provider, only Storage. */
  voiceLaneMode: VoiceLaneModeService;
  /** Read-only delivery-obligation ledger view. Not optional: it degrades to
   *  zeros when the gateway has never run. */
  deliveries: DeliveriesService;
  /** Connected wake satellites + the pushed routing table. Absent in
   *  deployments with no satellite lane — the RPCs then report an empty house
   *  rather than throwing at a Settings page. */
  satellites?: SatelliteRegistry;
  /** Read-only telephony call history. Absent in deployments with no call log —
   *  `voice.calls.*` then reports an empty list, which the UI renders as an
   *  empty state rather than an error. */
  calls?: CallsService;
  /** Read / replace the wake-phrase → personality table. Not optional: the
   *  editor must render (empty) even where no satellite lane is mounted. */
  wakeRoutes: WakeRoutesService;
  /** A2A peering service (from `@ethosagent/wiring`) — shared with the live
   *  `/a2a` handshake so the admin RPC and the trust decisions are one source
   *  of truth (plan §12). Absent in non-serve contexts. */
  a2aPeering?: import('@ethosagent/wiring').A2aPeeringService;
  /** Runtime A2A enable/disable control — the Settings toggle flips the same
   *  live gate the route modules and the `a2a_send` tool consult. Absent in
   *  non-serve contexts. */
  a2aControl?: import('../routes/route-module').A2aControl;
}

export const os = implement(contract).$context<RpcContext>();
