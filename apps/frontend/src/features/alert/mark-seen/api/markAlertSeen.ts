import { authorizedRequest } from '@/entities/session';

/**
 * `POST /dispatch/alerts/:id/seen` — the dispatcher has read it. «Seen» is not
 * «resolved»: an alert stays open until its cause goes away or is decided.
 */
export function markAlertSeen(alertId: string): Promise<{ seen: true }> {
  return authorizedRequest<{ seen: true }>(`/dispatch/alerts/${encodeURIComponent(alertId)}/seen`, {
    method: 'POST',
  });
}
