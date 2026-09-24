/**
 * A first line entry inside the day's lunch window spends that lunch.
 * The engineer keeps working; Router must not insert another break.
 */
export function forfeitsLunchOnLateEntry(input: {
  liveNow: number;
  enabled: boolean;
  taken: boolean;
  windowStartAt: bigint | number | null;
  windowEndAt: bigint | number | null;
}): boolean {
  if (!input.enabled || input.taken) return false;
  if (input.windowStartAt === null || input.windowEndAt === null) return false;
  const start = Number(input.windowStartAt);
  const end = Number(input.windowEndAt);
  return input.liveNow >= start && input.liveNow < end;
}
