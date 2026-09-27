import type { Tx } from '../../persistence';

export const ORDINARY_REPLANNING_KEY = 'policy.ordinary-replanning-disabled';

/** A System Layer arrival rule, independent of Router optimization settings. */
export async function ordinaryReplanningDisabled(tx: Tx): Promise<boolean> {
  const row = await tx.appState.findUnique({ where: { key: ORDINARY_REPLANNING_KEY } });
  return row?.value === true;
}

/** Hold only new ordinary work when there is already a working plan; emergencies always enter routing. */
export async function ordinaryArrivalHoldUntil(
  tx: Tx,
  now: number,
  category: string,
): Promise<bigint | null> {
  if (category === 'emergency' || !(await ordinaryReplanningDisabled(tx))) return null;
  if (!(await tx.appliedPlanCurrent.findUnique({ where: { id: 'singleton' } }))) return null;
  const day = await tx.liveWorkday.findFirst({ where: { status: 'running' } });
  const dayEnd = (Math.floor((now + 10800) / 86400) + 1) * 86400 - 10800;
  return BigInt(Math.max(dayEnd, Number(day?.logicalEndAt ?? 0)));
}
