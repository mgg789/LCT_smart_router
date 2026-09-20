import type { AlertView } from '../api/types';

/** Human-readable names for the server's finite set of dispatcher decisions. */
export const ALERT_ACTION_LABELS: Readonly<Record<string, string>> = {
  reschedule: 'На другой день',
  move_window: 'Подвинуть окно',
  add_engineer: 'Вызвать доп. инженера',
  keep_manual: 'Оставить так',
  restore_auto: 'Вернуть лучший auto-вариант',
  skip_lunch: 'Оставить без обеда',
  keep_lunch: 'Оставить обед',
  message: 'Написать',
  remove_shift: 'Снять со смены',
  message_remove: 'Написать и снять',
  extend: 'Дать ещё время',
};

/** Resolves known event codes without losing unknown server events. */
export function alertTitle(code: string): string {
  const titles: Readonly<Record<string, string>> = {
    time_risk: 'Риск сильного опоздания',
    unassigned: 'Заявка не назначена',
    plan_degraded: 'План деградировал',
    plan_review_required: 'Ручной план требует проверки',
    lunch_conflict: 'Конфликт с обедом',
    engineer_overdue: 'Инженер задержался и не отмечается',
    shift_no_show: 'Не вышел на смену',
    plan_rebuilt: 'План перестроился',
  };
  return titles[code] ?? code;
}

/** Read status never removes the requirement for a dispatcher decision. */
export function isOpenAlert(alert: AlertView): boolean {
  return alert.kind !== 'notice' && alert.resolvedAt === null;
}

/** The first 180 seconds are a grace period; elapsed second 181 is recorded as 1. */
export function alertDecisionSeconds(alert: AlertView, now: number): number {
  return alert.resolutionDelaySec ?? Math.max(0, (alert.resolvedAt ?? now) - alert.createdAt - 180);
}

/** Converts the UI's explicitly Moscow datetime input into Unix seconds. */
export function alertWindowSeconds(value: string): number {
  const result = Date.parse(`${value}:00+03:00`) / 1000;
  if (!Number.isInteger(result)) throw new Error('Укажите корректную дату и время окна');
  return result;
}

/** Formats persisted Unix time for a Moscow datetime-local input. */
export function alertWindowInput(seconds: number): string {
  return new Date((seconds + 3 * 3600) * 1000).toISOString().slice(0, 16);
}
