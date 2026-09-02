import type { DeliveryLedger } from '@ethosagent/delivery-ledger';
import type { PlatformAdapter } from '@ethosagent/types';
import { beginDelivery, confirmDelivery, type DeliveryBinding } from './delivery';

// ---------------------------------------------------------------------------
// Webhook delivery fan-out (plan/phases/webhook-subscriptions.md, Phase 2)
//
// A webhook hook can name zero or more DELIVERY TARGETS: places its content
// goes in ADDITION to the HTTP response (or, in `deliverOnly` mode, INSTEAD of
// dispatching a turn at all). The HTTP response is deliberately NOT a target
// variant — it is what it always was, and targets are additive.
//
// Two rules this module exists to keep in one place:
//
//   1. One broken or slow target must never block a sibling. The fan-out is
//      `Promise.allSettled`, and a throw anywhere inside one target's handling
//      becomes that target's `{ ok: false }` — `relayToTargets` never rejects.
//   2. A `platform` target reuses the ONE reliability mechanism the gateway
//      already has (`beginDelivery`/`confirmDelivery`), so an undelivered
//      webhook fan-out is redelivered by the same boot sweep as every other
//      outbound reply. No second retry ledger.
// ---------------------------------------------------------------------------

/**
 * Where one relayed webhook payload goes.
 *
 * - `log` — emitted to the process log. No ledger row: there is nothing to
 *   redeliver, so recording an obligation would only manufacture false
 *   `pending` rows for the boot sweep to chase.
 * - `platform` — sent through a live `PlatformAdapter`, resolved by
 *   `adapterId` (exactly `PlatformAdapter.id`, the join key the gateway
 *   command already builds its adapter map on). Covered by the ledger.
 */
export type DeliveryTargetConfig =
  | { type: 'log' }
  | { type: 'platform'; adapterId: string; chatId: string; threadId?: string };

/** One target's outcome. Positionally matches the `targets` input. */
export interface RelayResult {
  target: DeliveryTargetConfig;
  ok: boolean;
  error?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The `platform` half of an adapter id. Adapter ids for per-bot platforms are
 * namespaced `${platform}:${botKey}` (`telegram:tg-a`); single-instance
 * adapters are the bare platform name (`email`). Either way the segment before
 * the first `:` is the platform, which is what the ledger row records.
 */
function platformOf(adapterId: string): string {
  const colon = adapterId.indexOf(':');
  return colon > 0 ? adapterId.slice(0, colon) : adapterId;
}

async function relayOne(
  target: DeliveryTargetConfig,
  content: string,
  ctx: {
    hookId: string;
    sessionKey: string;
    adaptersById: Map<string, PlatformAdapter>;
    ledger?: DeliveryLedger;
    log: (line: string) => void;
  },
): Promise<RelayResult> {
  if (target.type === 'log') {
    ctx.log(`[webhook] ${ctx.hookId}: delivered to log — ${content}`);
    return { target, ok: true };
  }

  const adapter = ctx.adaptersById.get(target.adapterId);
  if (!adapter) {
    return {
      target,
      ok: false,
      error: `unknown adapterId '${target.adapterId}' — no such adapter is running`,
    };
  }

  const binding: DeliveryBinding | undefined = ctx.ledger
    ? {
        ledger: ctx.ledger,
        // The target's OWN adapterId, never `webhook:<hookId>`. The boot sweep
        // (`Gateway.sweepPendingDeliveries`) filters pending obligations to the
        // botKeys this process owns; a `webhook:` botKey matches no running bot,
        // so the row would never be recognized as ours and never redelivered.
        botKey: target.adapterId,
        platform: platformOf(adapter.id),
        onLedgerError: (stage, error) =>
          ctx.log(`[webhook] ${ctx.hookId}: delivery ledger ${stage} failed — ${error}`),
      }
    : undefined;

  const obligationId = await beginDelivery(binding, {
    chatId: target.chatId,
    sessionId: ctx.sessionKey,
    threadId: target.threadId,
    content,
  });

  const result = await adapter.send(target.chatId, {
    text: content,
    ...(target.threadId ? { threadId: target.threadId } : {}),
  });

  // "Resolved without throwing" is NOT confirmation: every shipped adapter
  // catches platform failures and returns `{ ok: false }`, so confirming on a
  // resolved promise would mark exactly the failures the ledger exists to catch
  // as delivered. Only `ok === true` confirms; anything else leaves the row
  // `pending` for the boot sweep.
  if (!result.ok) {
    return { target, ok: false, error: result.error ?? 'adapter reported failure' };
  }
  await confirmDelivery(binding, obligationId);
  return { target, ok: true };
}

/**
 * Fan one webhook payload out to every configured target.
 *
 * Never rejects, and never lets one target's latency or failure affect
 * another. Results come back in the same order as `targets`.
 */
export async function relayToTargets(
  targets: readonly DeliveryTargetConfig[],
  content: string,
  ctx: {
    hookId: string;
    sessionKey: string;
    adaptersById: Map<string, PlatformAdapter>;
    ledger?: DeliveryLedger;
    /** Where this module's log lines go. REQUIRED, and injected rather than
     *  defaulted to a console writer: the console belongs to the CLI
     *  (`apps/ethos/src/`), never to library code — the same seam doctrine
     *  `CaptureFactory` and `PrefilterRunner` already follow. */
    log: (line: string) => void;
  },
): Promise<RelayResult[]> {
  const settled = await Promise.allSettled(targets.map((target) => relayOne(target, content, ctx)));
  return settled.map((outcome, i) => {
    const target = targets[i] ?? { type: 'log' };
    if (outcome.status === 'fulfilled') return outcome.value;
    return { target, ok: false, error: errMsg(outcome.reason) };
  });
}
