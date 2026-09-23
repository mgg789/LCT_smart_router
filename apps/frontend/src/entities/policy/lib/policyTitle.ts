import type { KnownPolicyId, PoliciesView, PolicyId } from '../model/types';

/**
 * Russian names of the presets.
 *
 * The API labels policies in English ("Compact", "SLA safe"); the interface is
 * Russian, and these are the names the mockup gives each preset. `covering` is
 * not drawn in the mockup — its name comes from `docs/frontend-api.md`, which
 * calls that strategy «полное покрытие».
 */
const TITLES: Record<KnownPolicyId, string> = {
  fast: 'Быстрее до клиента',
  compact: 'Меньше инженеров',
  sla: 'Бережнее к окнам',
  balanced: 'Ровнее загрузка',
  eco: 'Короче пробег',
  covering: 'Полное покрытие',
};

/**
 * Name to show for a preset. An id we have no name for falls back to the label
 * the API sent, and only then to the id itself — never to a guess.
 */
export function policyTitle(policyId: PolicyId, apiTitle?: string): string {
  return TITLES[policyId as KnownPolicyId] ?? apiTitle ?? policyId;
}

/** Name of the policy currently in force in a `GET /dispatch/policies` answer. */
export function activePolicyTitle(view: PoliciesView): string {
  const active = view.policies.find((policy) => policy.policyId === view.active.policyId);
  return policyTitle(view.active.policyId, active?.title);
}
