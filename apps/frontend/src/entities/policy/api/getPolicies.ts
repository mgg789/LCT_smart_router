import { authorizedRequest } from '@/entities/session';
import type { PoliciesView } from '../model/types';

/** `GET /dispatch/policies` — the catalogue plus the policy in force. */
export function getPolicies(): Promise<PoliciesView> {
  return authorizedRequest<PoliciesView>('/dispatch/policies');
}
