import { os } from './context';

// Activity namespace — durable activity history, read from the observability
// store's spans / turn traces / events.
//
// The store is optional throughout web-api (same posture as
// `sessions.contextAnatomy`): a deployment wired without one returns an empty
// page rather than erroring, so the Activity view renders an empty state
// instead of a failure.

export const activityRouter = {
  history: os.activity.history.handler(({ input, context }) => {
    const read = context.activityHistory;
    if (!read) return { items: [], nextBefore: null, nextBeforeId: null };
    const items = read({
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.beforeId !== undefined ? { beforeId: input.beforeId } : {}),
      limit: input.limit,
    });
    // A short page is the end of the feed; a full one may have more behind it,
    // so hand back the oldest row seen as the next exclusive cursor. Both
    // halves travel together — the timestamp alone cannot resume inside a group
    // of rows that share one millisecond.
    const oldest = items.at(-1);
    const more = items.length >= input.limit && oldest !== undefined;
    return {
      items,
      nextBefore: more ? oldest.startedAt : null,
      nextBeforeId: more ? oldest.id : null,
    };
  }),
};
