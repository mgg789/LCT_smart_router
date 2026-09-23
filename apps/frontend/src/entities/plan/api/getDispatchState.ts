import { authorizedRequest } from '@/entities/session';
import type { DispatchStateView } from '../model/types';

/** `GET /dispatch/plan` — the day screen's main endpoint, and the mode of control. */
export function getDispatchState(): Promise<DispatchStateView> {
  return authorizedRequest<DispatchStateView>('/dispatch/plan');
}
