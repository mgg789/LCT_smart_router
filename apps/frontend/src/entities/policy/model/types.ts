/**
 * Presets the catalogue offers. `compact` is the default (D-24) and `covering`
 * is the extendable-workforce strategy that `GET /dispatch/policies` returns but
 * `docs/frontend-api.md` §5 does not list yet.
 *
 * The union stays open: a preset added on the server must not break the client.
 */
export type KnownPolicyId = 'fast' | 'compact' | 'sla' | 'balanced' | 'eco' | 'covering';
export type PolicyId = KnownPolicyId | (string & {});

export interface PolicySummary {
  policyId: PolicyId;
  /** English label from the API; the UI renders the Russian name instead. */
  title: string;
  description: string;
  isDefault: boolean;
}

export interface ActivePolicy {
  policyId: PolicyId;
  version: number;
  /** Unix seconds. */
  changedAt: number;
}

export interface PoliciesView {
  policies: PolicySummary[];
  active: ActivePolicy;
}
