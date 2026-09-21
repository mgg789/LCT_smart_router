import { formatTime } from '@/shared/lib';
import type { AlertView } from '../model/types';

/**
 * Russian names of the events the detectors raise — the same set `apps/web`
 * names. An unknown code is shown as it came: inventing a phrase for an event
 * nobody described is worse than showing its code.
 */
const EVENT_TITLES: Record<string, string> = {
  time_risk: 'Риск времени',
  engineer_line_started: 'Инженер вышел на линию',
  engineer_day_finished: 'Инженер завершил день',
  workday_finished_with_alerts: 'Остались нерешённые алерты',
  unassigned: 'Заявка не назначена',
  plan_degraded: 'План деградировал',
  plan_review_required: 'Ручной план требует проверки',
  lunch_conflict: 'Конфликт с обедом',
  engineer_overdue: 'Инженер задержался и не отмечается',
  shift_no_show: 'Не вышел на смену',
  plan_rebuilt: 'План перестроился',
  LIVE_TECHNICAL_BREAK_OVERRUN: 'Риск времени',
  LIVE_WINDOW_COMPLETION_RISK: 'Риск времени',
  // Solver reason codes, which older rows carry as their code.
  NO_SKILL_MATCH: 'Нет инженера с нужным навыком',
  NO_TRANSPORT_MATCH: 'Нет инженера с нужным транспортом',
  NO_EQUIPMENT_STOCK: 'Не хватает оборудования',
  NO_AVAILABLE_ENGINEER: 'Нет доступного инженера',
  NO_FEASIBLE_ASSIGNMENT_FOUND: 'Назначение не найдено в отведённом расчёте',
  LUNCH_NOT_PLACED: 'Обед не удалось поставить',
  LUNCH_SKIPPED_FOR_WORK: 'Обед пропущен ради заявки',
  REQUIRED_LUNCH_UNPLACED: 'Обязательный обед не поставлен',
  CONSTRAINTS_SATISFIED: 'Ограничения выполнены',
};

/** Names of the decisions the server offers, for the buttons that stand for them. */
export const ALERT_ACTION_LABELS: Readonly<Record<string, string>> = {
  reschedule: 'На другой день',
  move_window: 'Сменить окно',
  add_engineer: 'Вызвать доп. инженера',
  keep_manual: 'Оставить так',
  keep_as_is: 'Оставить так',
  restore_auto: 'Вернуть лучший авто-вариант',
  skip_lunch: 'Оставить без обеда',
  keep_lunch: 'Оставить обед',
  message: 'Написать',
  remove_shift: 'Снять со смены',
  message_remove: 'Написать и снять',
  extend: 'Дать ещё время',
};

export function alertTitle(alert: Pick<AlertView, 'code'>): string {
  return EVENT_TITLES[alert.code] ?? alert.code;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * One reason of an alert as a sentence, built from the facts the detector
 * recorded — ported from `apps/web`. A shape it does not know is not guessed at.
 */
export function alertReasonText(reason: unknown): string | null {
  if (typeof reason === 'string') return reason.trim() || null;
  if (!reason || typeof reason !== 'object') return null;
  const facts = reason as Record<string, unknown>;
  if (typeof facts.text === 'string') return facts.text;

  const shiftStartAt = num(facts.shiftStartAt);
  const thresholdAt = num(facts.thresholdAt);
  if (shiftStartAt !== undefined && thresholdAt !== undefined) {
    return `Смена началась в ${formatTime(shiftStartAt)}. К ${formatTime(thresholdAt)} отметка о выходе не поступила.`;
  }
  const plannedStartAt = num(facts.plannedStartAt);
  const windowEndAt = num(facts.windowEndAt);
  if (plannedStartAt !== undefined && windowEndAt !== undefined) {
    const late = Math.ceil((plannedStartAt - windowEndAt) / 60);
    return `Начало по плану — ${formatTime(plannedStartAt)}, конец окна — ${formatTime(windowEndAt)}. Опоздание: ${late} мин.`;
  }
  const expectedAt = num(facts.expectedAt);
  if (expectedAt !== undefined) {
    const last = num(facts.lastAttendanceAt);
    const lastText =
      last !== undefined ? `Последняя отметка: ${formatTime(last)}.` : 'Отметок пока нет.';
    return `Ожидалась отметка к ${formatTime(expectedAt)}. ${lastText}`;
  }
  if (facts.assignment === 'unassigned') {
    return 'Для заявки не найдено допустимое назначение. Нужно изменить условия или добавить инженера.';
  }
  if (typeof facts.lunchStatus === 'string') {
    return 'Обед не помещается в текущий маршрут. Требуется выбор диспетчера.';
  }
  const before = num(facts.assignedBefore);
  const after = num(facts.assignedAfter);
  if (before !== undefined && after !== undefined) return `Назначено заявок: ${before} → ${after}.`;
  return null;
}

/** Every reason of an alert that can be put into words, joined; the title otherwise. */
export function alertReason(alert: Pick<AlertView, 'code' | 'reasons'>): string {
  const lines = alert.reasons.map(alertReasonText).filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join(' · ') : alertTitle(alert);
}

/** An alert still waiting for a decision; reading it does not close it. */
export function isOpenAlert(alert: AlertView): boolean {
  return alert.kind !== 'notice' && alert.resolvedAt === null;
}

/** A notice the dispatcher has not hidden yet. */
export function isUnseenNotice(alert: AlertView): boolean {
  return alert.kind === 'notice' && alert.seenAt === null;
}

/** Decisions before information, then newest first. */
function byUrgency(left: AlertView, right: AlertView): number {
  const rank = Number(left.kind === 'notice') - Number(right.kind === 'notice');
  return rank !== 0 ? rank : right.createdAt - left.createdAt;
}

/** What still needs the dispatcher's eyes, decisions first. */
export function unseenAlerts(alerts: AlertView[]): AlertView[] {
  return alerts
    .filter((alert) => alert.seenAt === null && alert.resolvedAt === null)
    .sort(byUrgency);
}
