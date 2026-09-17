/** Recorded Router scenarios, validated again at the UI boundary. No server writes. */
import { parseDashboardSnapshot, parsePolicyComparison } from '../api/client';
import type { PolicyId } from '../api/types';
import pack from './generated/recorded.json';

/** Policies present in the recorded demo pack. Covering is live-only and not replayed. */
const RECORDED_POLICY_IDS = ['compact', 'fast', 'sla', 'balanced', 'eco'] as const;
type RecordedPolicyId = (typeof RECORDED_POLICY_IDS)[number];

/** Fixed scenarios exposed to the presenter; the original work date stays visible. */
export const demoScenarios = pack.scenarios.map(({ id, title }) => ({ id, title }));

/** Map a live PolicyId onto a key that exists in the recorded snapshots. */
function recordedPolicyId(policy: PolicyId): RecordedPolicyId {
  return (RECORDED_POLICY_IDS as readonly PolicyId[]).includes(policy)
    ? (policy as RecordedPolicyId)
    : 'compact';
}

/** Select a recorded calculation; rejects unknown scenarios. Covering falls back to compact. */
export function recordedScenario(id: string, policy: PolicyId = 'compact') {
  const scenario = pack.scenarios.find((item) => item.id === id);
  if (!scenario) throw new Error('Неизвестный демо-сценарий');
  return {
    snapshot: parseDashboardSnapshot(scenario.snapshots[recordedPolicyId(policy)]),
    comparison: parsePolicyComparison(scenario.comparison),
    sourceCommit: pack.sourceCommit,
  };
}
