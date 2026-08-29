import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { type CallFilter, callsQueryInput } from '../../voice/call-rows';
import { callKeys, platformKeys } from './keys';

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
