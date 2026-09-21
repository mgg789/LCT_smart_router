import { authorizedRequest } from '@/entities/session';
import type { PolicyComparison } from '../model/comparison';

/**
 * `GET /dispatch/policy-comparison` — runs every policy and the FIFO baseline on
 * the current published input. Heavy: the first answer after a publication can
 * take up to ~90 s (docs/frontend-api.md §6.3), so it is asked for, not polled.
 */
export function getPolicyComparison(): Promise<PolicyComparison> {
  return authorizedRequest<PolicyComparison>('/dispatch/policy-comparison');
}
