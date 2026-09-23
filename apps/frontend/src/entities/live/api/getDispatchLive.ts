import { authorizedRequest } from '@/entities/session';
import type { DispatchLiveView } from '../model/types';

/** `GET /dispatch/live` — the durable LIVE workday: crews, their tallies, closed visits. */
export function getDispatchLive(): Promise<DispatchLiveView> {
  return authorizedRequest<DispatchLiveView>('/dispatch/live');
}
