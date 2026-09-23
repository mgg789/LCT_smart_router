import { authorizedRequest } from '@/entities/session';
import type { RequestsView } from '../model/types';

/** `GET /dispatch/requests` — the whole day, including started and finished work. */
export function getRequests(): Promise<RequestsView> {
  return authorizedRequest<RequestsView>('/dispatch/requests');
}
