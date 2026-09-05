import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { type CallFilter, callsQueryInput } from '../../voice/call-rows';
import { startOfToday } from '../observed-rows';
import { callKeys, observedChatKeys, platformKeys } from './keys';

export function usePlatformsList() {
  return useQuery({
    queryKey: platformKeys.list(),
    queryFn: () => rpc.platforms.list(),
  });
}

export function useTelegramBots() {
  return useQuery({
    queryKey: platformKeys.bots('telegram'),
    queryFn: () => rpc.platforms.botsListTelegram(),
  });
}

export function useSlackBots() {
  return useQuery({
    queryKey: platformKeys.bots('slack'),
    queryFn: () => rpc.platforms.botsListSlack(),
  });
}

export function useWhatsAppBots() {
  return useQuery({
    queryKey: platformKeys.bots('whatsapp'),
    queryFn: () => rpc.platforms.botsListWhatsApp(),
  });
}

/** The plan's "times re-render every 30 s" (§8), done by refetching rather
 *  than by a second clock: the counts move too, and one interval that keeps
 *  both honest beats a ticking clock over stale numbers. React Query pauses an
 *  interval while the tab is unfocused, so a page left open costs nothing. */
export const OBSERVED_CHATS_POLL_MS = 30_000;

/**
 * Rooms a bot watches without answering.
 *
 * No error path: a deployment where nothing was ever observed answers
 * `{ lanes: [], omittedCount: 0, error: null }`, and an unreadable transcript
 * answers with `error` set — both are page CONTENT, not a rejected query. The
 * RPC does not throw on either, which is what lets the failure be a row that
 * stays instead of a toast that leaves (feedback & activity contract §6).
 */
export function useObservedChats(since: number = startOfToday()) {
  return useQuery({
    queryKey: observedChatKeys.since(since),
    queryFn: () => rpc.channels.observed({ since }),
    refetchInterval: OBSERVED_CHATS_POLL_MS,
  });
}

export function useChannelFilter(platform: string) {
  return useQuery({
    queryKey: platformKeys.channelFilter(platform),
    queryFn: () => rpc.platforms.getChannelFilter({ platform }),
  });
}

// -- Telephony call history (voice V4) --------------------------------------
//
// A deployment with no call log answers `{ calls: [] }` rather than throwing,
// so none of these hooks needs an error path for "telephony is not configured"
// — that case IS the empty state.

/** Live enough that a call ringing right now appears without a reload, slow
 *  enough that a Communications tab left open is not a load generator. React
 *  Query pauses an interval while the tab is unfocused, so a hidden tab polls
 *  nothing. */
export const ACTIVE_CALLS_POLL_MS = 4_000;

export function useCallsList(filter: CallFilter) {
  return useQuery({
    queryKey: callKeys.list(filter),
    queryFn: () => rpc.voice.calls.list(callsQueryInput(filter)),
  });
}

export function useActiveCalls() {
  return useQuery({
    queryKey: callKeys.active(),
    queryFn: () => rpc.voice.calls.active(),
    refetchInterval: ACTIVE_CALLS_POLL_MS,
  });
}

/** Null id = no row is open, so nothing is fetched. The transcript is the one
 *  thing the list deliberately withholds; it arrives only when asked for. */
export function useCallDetail(id: string | null) {
  return useQuery({
    queryKey: callKeys.detail(id ?? ''),
    queryFn: () => rpc.voice.calls.get({ id: id ?? '' }),
    enabled: id !== null,
  });
}
