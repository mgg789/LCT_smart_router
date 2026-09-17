/** Recorded Router scenarios, validated again at the UI boundary. No server writes. */
import { parseDashboardSnapshot, parsePolicyComparison } from '../api/client';
import type { PolicyId } from '../api/types';
import pack from './generated/recorded.json';

/** Fixed scenarios exposed to the presenter; the original work date stays visible. */
export const demoScenarios = pack.scenarios.map(({ id, title }) => ({ id, title }));

/** Select a recorded calculation; rejects unknown scenarios and policies. */
export function recordedScenario(id: string, policy: PolicyId = 'compact') {
  const scenario = pack.scenarios.find((item) => item.id === id);
  if (!scenario) throw new Error('Неизвестный демо-сценарий');
  return {
    snapshot: parseDashboardSnapshot(scenario.snapshots[policy]),
    comparison: parsePolicyComparison(scenario.comparison),
    sourceCommit: pack.sourceCommit,
  };
}
