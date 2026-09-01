import { chatAbort } from '../features/chat/rpc/abort';
import { chatSend } from '../features/chat/rpc/send';
import { chatSteer } from '../features/chat/rpc/steer';
import { debugChat } from '../features/debug/rpc/chat';
import { sessionsCompact } from '../features/sessions/rpc/compact';
import { sessionsContextAnatomy } from '../features/sessions/rpc/context-anatomy';
import { sessionsDelete } from '../features/sessions/rpc/delete';
import { sessionsExport } from '../features/sessions/rpc/export';
import { sessionsFork } from '../features/sessions/rpc/fork';
import { sessionsGet } from '../features/sessions/rpc/get';
import { sessionsList } from '../features/sessions/rpc/list';
import { sessionsPin } from '../features/sessions/rpc/pin';
import { sessionsUnpin } from '../features/sessions/rpc/unpin';
import { sessionsUpdate } from '../features/sessions/rpc/update';
import { a2aRouter } from './a2a';
import { activityRouter } from './activity';
import { adminRouter } from './admin';
import { apiKeysRouter } from './api-keys';
import { batchRouter } from './batch';
import { clarifyRouter } from './clarify';
import { configRouter } from './config';
import { contextRouter, filesRouter } from './context-resolve';
import { cronRouter } from './cron';
import { dashboardsRouter } from './dashboards';
import { deliveriesRouter } from './deliveries';
import { digestRouter } from './digest';
import { documentsRouter } from './documents';
import { evalRouter } from './eval';
import { evolverRouter } from './evolver';
import { goalsRouter } from './goals';
import { kanbanRouter } from './kanban';
import { mcpRouter } from './mcp';
import { memoryRouter } from './memory';
import { meshRouter } from './mesh';
import { metaRouter } from './meta';
import { modelsRouter } from './models';
import { namedSecretsRouter } from './named-secrets';
import { onboardingRouter } from './onboarding';
import { personalitiesRouter } from './personalities';
import { platformsRouter } from './platforms';
import { pluginsRouter } from './plugins';
import { skillsRouter } from './skills';
import { slashCommandsRouter } from './slash-commands';
import { tasksRouter } from './tasks';
import { toolSettingsRouter } from './tool-settings';
import { toolsRouter } from './tools';
import { voiceRouter } from './voice';

// Top-level oRPC router. Each namespace lives in its own file (one
// `os.<namespace>.<method>.handler(...)` per procedure); this file only
// composes them. Add a namespace by importing its router and mounting it
// on `apiRouter` below — keep handler logic in the per-namespace file.

export const apiRouter = {
  sessions: {
    list: sessionsList,
    get: sessionsGet,
    fork: sessionsFork,
    delete: sessionsDelete,
    update: sessionsUpdate,
    export: sessionsExport,
    pin: sessionsPin,
    unpin: sessionsUnpin,
    contextAnatomy: sessionsContextAnatomy,
    compact: sessionsCompact,
  },
  activity: activityRouter,
  chat: {
    send: chatSend,
    abort: chatAbort,
    steer: chatSteer,
  },
  debug: {
    chat: debugChat,
  },
  personalities: personalitiesRouter,
  config: configRouter,
  onboarding: onboardingRouter,
  tools: toolsRouter,
  clarify: clarifyRouter,
  cron: cronRouter,
  skills: skillsRouter,
  slashCommands: slashCommandsRouter,
  evolver: evolverRouter,
  mesh: meshRouter,
  memory: memoryRouter,
  plugins: pluginsRouter,
  mcp: mcpRouter,
  platforms: platformsRouter,
  batch: batchRouter,
  eval: evalRouter,
  kanban: kanbanRouter,
  tasks: tasksRouter,
  apiKeys: apiKeysRouter,
  meta: metaRouter,
  models: modelsRouter,
  dashboards: dashboardsRouter,
  admin: adminRouter,
  context: contextRouter,
  files: filesRouter,
  goals: goalsRouter,
  digest: digestRouter,
  voice: voiceRouter,
  deliveries: deliveriesRouter,
  a2a: a2aRouter,
  namedSecrets: namedSecretsRouter,
  toolSettings: toolSettingsRouter,
  documents: documentsRouter,
};

export type ApiRouter = typeof apiRouter;
