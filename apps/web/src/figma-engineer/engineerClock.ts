import { moscowClockLabel, moscowWorkDate } from '../figma-dashboard/welcomeDay';
import { formatClock, formatDayTitle } from '../lib/time';

/** Header stamp from Figma MAIN 73:9536 — `15 сентября, 20:14`. */
export function engineerHeaderStamp(nowMs = Date.now()): string {
  const date = formatDayTitle(moscowWorkDate(nowMs)).replace(/ \d{4}$/, '');
  return `${date}, ${moscowClockLabel(nowMs)}`;
}

/** Planned clock without a leading hour zero, as on the Figma cards (`9:17`). */
export function formatPlanTime(unixSec: number): string {
  const clock = formatClock(unixSec);
  return clock.startsWith('0') ? clock.slice(1) : clock;
}

/** Window chip `9:00-10:20` using the same loose hour as the cards. */
export function formatPlanWindow(startAt: number, endAt: number): string {
  return `${formatPlanTime(startAt)}-${formatPlanTime(endAt)}`;
}

/** Service duration in the list language (`45 минут`). */
export function formatMinutesRu(durationSec: number): string {
  const n = Math.max(0, Math.round(durationSec / 60));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} минута`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} минуты`;
  return `${n} минут`;
}

/** Detail header from Figma REQUEST 78:9734 — `Через 25 минут`, or `Сейчас`. */
export function arrivalHeadline(startAtSec: number, nowMs = Date.now()): string {
  const deltaSec = startAtSec - nowMs / 1000;
  if (deltaSec <= 30) return 'Сейчас';
  return `Через ${formatMinutesRu(deltaSec)}`;
}
