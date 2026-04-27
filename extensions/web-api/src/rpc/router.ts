import { chatRouter } from './chat';
import { configRouter } from './config';
import { onboardingRouter } from './onboarding';
import { personalitiesRouter } from './personalities';
import { sessionsRouter } from './sessions';

// Top-level oRPC router. Each namespace lives in its own file (one
// `os.<namespace>.<method>.handler(...)` per procedure); this file only
// composes them.
//
// Namespaces in place:
//   • sessions      (26.1)  — list / get / fork / delete
//   • chat          (26.3a) — send / abort (SSE handles the streamed response)
//   • personalities (26.3b) — list / get (read-only — full lifecycle in v1)
//   • config        (26.3b) — get with redacted apiKey / update
//   • onboarding    (26.3b) — state / validateProvider / complete
//
// Pending: tools (26.3c).

export const apiRouter = {
  sessions: sessionsRouter,
  chat: chatRouter,
  personalities: personalitiesRouter,
  config: configRouter,
  onboarding: onboardingRouter,
};

export type ApiRouter = typeof apiRouter;
