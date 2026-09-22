import type { Tx } from '../../persistence';

/** Converts wall time at a business boundary; persistence audit timestamps remain wall-based. */
export async function businessNow(tx: Tx, wallNow: number, workDate?: string): Promise<number> {
  const day = workDate
    ? ((await tx.liveWorkday.findFirst({
        where: { workDate, status: 'running' },
        orderBy: { startedAtWallSec: 'desc' },
      })) ??
      (await tx.liveWorkday.findFirst({
        where: { workDate, status: 'finished' },
        orderBy: { finishedAt: 'desc' },
      })))
    : ((await tx.liveWorkday.findFirst({
        where: { status: 'running' },
        orderBy: { startedAtWallSec: 'desc' },
      })) ??
      (await tx.liveWorkday.findFirst({
        where: { status: 'finished', workDate: localWorkDate(wallNow) },
        orderBy: { finishedAt: 'desc' },
      })));
  if (!day) return wallNow;
  if (day.status === 'finished') return Number(day.finishedAt ?? day.logicalEndAt);
  if (day.startedAtWallSec === null) return Number(day.logicalStartAt);
  const start = Number(day.logicalStartAt);
  const duration = Math.max(1, Number(day.logicalEndAt) - start);
  const factor = day.speedDurationSec === null ? 1 : duration / day.speedDurationSec;
  return Math.min(
    Number(day.logicalEndAt),
    start + Math.floor(Math.max(0, wallNow - Number(day.startedAtWallSec)) * factor),
  );
}

function localWorkDate(epochSeconds: number): string {
  return new Date((epochSeconds + 3 * 3600) * 1000).toISOString().slice(0, 10);
}
