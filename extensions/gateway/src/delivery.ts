import type { DeliveryLedger } from '@ethosagent/delivery-ledger';

// ---------------------------------------------------------------------------
// Two-phase delivery-obligation wrapper (item 9)
//
// Shared by the Gateway's own reply paths and by `DraftStreamer`'s terminal
// edit, so the "record before, confirm after, and NEVER let the ledger break a
// reply" policy lives in exactly one place.
//
// A ledger failure must never cost the user their message: both helpers
// swallow their own errors and report them through `onLedgerError`. Failing to
// record degrades to today's behavior (no durability); failing to confirm
// leaves the row `pending`, so the worst case is a redundant redelivery — the
// same at-least-once trade the ledger already makes.
// ---------------------------------------------------------------------------

/** A ledger plus the identity bits one outbound surface contributes. */
export interface DeliveryBinding {
  ledger: DeliveryLedger;
  botKey: string;
  platform: string;
  /** Observability seam for ledger-internal failures. Never rethrown. */
  onLedgerError?: (stage: 'record' | 'confirm', error: string) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write the `pending` obligation. Returns its id, or `null` when there is no
 * ledger, nothing to deliver, or the write itself failed.
 */
export async function beginDelivery(
  binding: DeliveryBinding | undefined,
  input: { chatId: string; sessionId: string; threadId?: string | undefined; content: string },
): Promise<string | null> {
  if (!binding || !input.content) return null;
  try {
    return await binding.ledger.record({
      botKey: binding.botKey,
      platform: binding.platform,
      chatId: input.chatId,
      sessionId: input.sessionId,
      // A thread is part of WHERE the reply belongs, not decoration: the lane
      // key already encodes it. Dropping it here would redeliver into the root
      // chat, out of the context that made the answer legible.
      threadId: input.threadId,
      content: input.content,
    });
  } catch (err) {
    binding.onLedgerError?.('record', errMsg(err));
    return null;
  }
}

/**
 * Mark the obligation delivered. Call ONLY when the platform confirmed
 * (`DeliveryResult.ok === true` / the terminal edit landed) — an unconfirmed
 * send must stay `pending` so the boot sweep redelivers it.
 */
export async function confirmDelivery(
  binding: DeliveryBinding | undefined,
  obligationId: string | null,
): Promise<void> {
  if (!binding || obligationId === null) return;
  try {
    await binding.ledger.markDelivered(obligationId);
  } catch (err) {
    binding.onLedgerError?.('confirm', errMsg(err));
  }
}
