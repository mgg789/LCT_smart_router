import { t } from '../i18n';
import { formatClock } from '../lib/time';

/** Remaining time until `targetAt`, in the engineer's list language. */
export function formatCountdown(nowAt: number, targetAt: number): string {
  const delta = targetAt - nowAt;
  if (delta <= 0) {
    return t('engineer.format.a2b9428711');
  }
  const hours = Math.floor(delta / 3600);
  const minutes = Math.floor((delta % 3600) / 60);
  if (hours > 0) {
    return t('engineer.format.623d4010c6', { value0: hours, value1: minutes });
  }
  return t('engineer.format.d662a84f53', { value0: minutes });
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
    return t('engineer.format.32baa84f0f', { value0: formatCountdown(nowAt, windowStartAt) });
  }
  if (nowAt < windowEndAt) {
    return t('engineer.format.e1a36b2ba6', { value0: formatCountdown(nowAt, windowEndAt) });
  }
  return t('engineer.format.5a96a9aa65');
}
