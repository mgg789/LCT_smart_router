/** Client-side helpers for the server-owned accelerated workday clock. */
export interface LiveClockAnchor {
  readonly liveNow: number;
  readonly speedFactor: number;
  readonly receivedAtMs: number;
}

/** Interpolates logical seconds between two authoritative API responses. */
export function liveNowAt(anchor: LiveClockAnchor, performanceNowMs = performance.now()): number {
  return Math.floor(
    anchor.liveNow + ((performanceNowMs - anchor.receivedAtMs) / 1000) * anchor.speedFactor,
  );
}

/** Formats a non-negative duration for compact, frequently updating controls. */
export function formatLiveCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

/** Converts a Moscow HH:mm input into an absolute second on the active work date. */
export function moscowTimeInputAt(workDate: string, time: string): number | null {
  const matched = /^(\d{2}):(\d{2})$/.exec(time);
  if (!matched) return null;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return null;
  const [yearText, monthText, dayText] = workDate.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (![year, month, day].every(Number.isInteger)) return null;
  return Date.UTC(year, month - 1, day, hour - 3, minute) / 1000;
}
