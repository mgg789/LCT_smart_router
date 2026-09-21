import type { AlertView } from '../model/types';

/**
 * Russian wording for the alert codes the contract documents
 * (docs/frontend-api.md §10). An unknown code is shown as it came: the contract
 * is explicit that we must not invent a phrase for it.
 */
const TITLES: Record<string, string> = {
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

export function alertTitle(alert: AlertView): string {
  return TITLES[alert.code] ?? alert.code;
}

/** Freshest first, and only what still needs the dispatcher's eyes. */
export function unseenAlerts(alerts: AlertView[]): AlertView[] {
  return alerts.filter((alert) => alert.seenAt === null && alert.resolvedAt === null);
}
