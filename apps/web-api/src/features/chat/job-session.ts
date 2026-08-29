import type { JobStore } from '@ethosagent/types';

// A background job's events (clarify, run.update) are keyed by the job, not by
// a web session — the browser only knows the parent chat's session id, and the
// SSE buffer/ChatService only broadcasts by that id. This translates a job id
// into that id: job -> `parentSessionKey` (who spawned it) -> the real session
// id, via the `sessionKey` <-> `sessionId` map the `session_start` hook builds
// (see apps/web-api/src/index.ts).
//
// `undefined` covers every "nothing to deliver to" case, and all of them are
// normal, not errors: no `jobStore` wired, the job id doesn't resolve (already
// reaped, or from a different process), or its `parentSessionKey` has no open
// browser tab (a CLI- or gateway-spawned job). The caller's job is to skip the
// broadcast silently, exactly like the existing `if (!sessionId) return;` bail
// on the run.update bridge.
export async function resolveJobSessionId(
  jobId: string,
  jobStore: JobStore | undefined,
  sessionIdsByKey: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  if (!jobStore) return undefined;
  const job = await jobStore.get(jobId);
  if (!job) return undefined;
  return sessionIdsByKey.get(job.parentSessionKey);
}
