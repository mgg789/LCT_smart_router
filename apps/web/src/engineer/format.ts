import { formatClock } from '../lib/time';

/** Remaining time until `targetAt`, in the engineer's list language. */
export function formatCountdown(nowAt: number, targetAt: number): string {
  const delta = targetAt - nowAt;
  if (delta <= 0) {
    return 'время вышло';
  }
  const hours = Math.floor(delta / 3600);
  const minutes = Math.floor((delta % 3600) / 60);
  if (hours > 0) {
    return `${hours} ч ${minutes} мин`;
  }
  return `${minutes} мин`;
}

/** Window / arrival line used on the engineer request card. */
export function formatWindow(windowStartAt: number, windowEndAt: number): string {
  return `${formatClock(windowStartAt)}–${formatClock(windowEndAt)}`;
}

/** Countdown relative to the SLA window, not the planned arrival. */
export function formatWindowCountdown(
  nowAt: number,
  windowStartAt: number,
  windowEndAt: number,
): string {
  if (nowAt < windowStartAt) {
    return `до окна ${formatCountdown(nowAt, windowStartAt)}`;
  }
  if (nowAt < windowEndAt) {
    return `до конца окна ${formatCountdown(nowAt, windowEndAt)}`;
  }
  return 'окно закрыто';
}
