import type { LangfuseIngestionEvent } from './mapping';

export interface LangfuseClientConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

/** A hung POST must not outlive the poller's stale-claim cutoff (120s
 *  default) — otherwise a peer poller can reclaim and finish exporting the
 *  same trace before this fetch resolves. */
const POST_TIMEOUT_MS = 15_000;

/** Shape of Langfuse's ingestion response on both 2xx and 207. Only the
 *  `errors` array is read; `successes` is ignored. */
interface LangfuseIngestionResponse {
  errors?: unknown[];
}

/**
 * POST one batch to Langfuse's ingestion endpoint. Basic Auth per
 * https://langfuse.com/docs/api-and-data-platform/features/public-api
 * (username = public key, password = secret key). Returns whether the batch
 * was fully accepted. A plain 2xx (non-207) is success. The endpoint
 * responds 207 on partial per-event failure within an otherwise-accepted
 * batch — `Response.ok` treats that as success, but it can mean some events
 * in the batch were silently dropped, so a 207 is only reported success when
 * its body's `errors` array is empty; a non-empty (or unparseable) `errors`
 * array is reported as failure so the caller releases the claim and retries
 * the whole batch next tick (retry is idempotent by trace/event id — no
 * partial-retry-of-just-the-failed-events here). A rejected batch (network
 * failure, non-2xx, non-207 partial) is the caller's cue to release the
 * trace's claim and retry next tick — this function does not retry.
 */
export async function postToLangfuse(
  batch: LangfuseIngestionEvent[],
  config: LangfuseClientConfig,
): Promise<boolean> {
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64');
  const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/api/public/ingestion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ batch }),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (res.status === 207) {
    try {
      const body = (await res.json()) as LangfuseIngestionResponse;
      return Array.isArray(body.errors) && body.errors.length === 0;
    } catch {
      return false;
    }
  }
  return res.ok;
}
