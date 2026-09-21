import { authorizedRequest } from '@/entities/session';
import type { AlertsView } from '../model/types';

/** `GET /dispatch/alerts` — up to 200 entries, freshest first. */
export function getAlerts(): Promise<AlertsView> {
  return authorizedRequest<AlertsView>('/dispatch/alerts');
}
