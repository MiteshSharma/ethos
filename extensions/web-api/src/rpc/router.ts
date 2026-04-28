import { chatRouter } from './chat';
import { configRouter } from './config';
import { cronRouter } from './cron';
import { onboardingRouter } from './onboarding';
import { personalitiesRouter } from './personalities';
import { sessionsRouter } from './sessions';
import { toolsRouter } from './tools';

// Top-level oRPC router. Each namespace lives in its own file (one
// `os.<namespace>.<method>.handler(...)` per procedure); this file only
// composes them.
//
// Namespaces in place:
//   • sessions      — list / get / fork / delete
//   • chat          — send / abort (SSE handles the streamed response)
//   • personalities — list / get (read-only — full lifecycle in v1)
//   • config        — get with redacted apiKey / update
//   • onboarding    — state / validateProvider / complete
//   • tools         — approve / deny (resolves pending approvals; the
//                     `before_tool_call` hook + SSE handle the request side)

export const apiRouter = {
  sessions: sessionsRouter,
  chat: chatRouter,
  personalities: personalitiesRouter,
  config: configRouter,
  onboarding: onboardingRouter,
  tools: toolsRouter,
  cron: cronRouter,
};

export type ApiRouter = typeof apiRouter;
