/** Preset ids the catalogue offers; `compact` is the default (D-24). */
export type PolicyId = 'fast' | 'compact' | 'sla' | 'balanced' | 'eco';

export interface PolicySummary {
  policyId: PolicyId;
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
