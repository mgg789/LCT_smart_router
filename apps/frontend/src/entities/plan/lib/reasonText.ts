import type { AssignmentReason } from '../model/types';

/**
 * Russian rendering of the reason codes the contract lists
 * (docs/frontend-api.md §10).
 *
 * An unknown code is shown as it came — the contract forbids inventing wording
 * for one, and a made-up explanation of a solver decision is worse than none.
 */
const REASON_TITLES: Record<string, string> = {
  skill_match: 'Подходит навык',
  skill_missing: 'Не хватает навыка',
  equipment_ok: 'Оборудование есть',
  equipment_missing: 'Не хватает оборудования',
  travel_delta: 'Выгодно по дороге',
  sla_margin: 'Запас до конца окна',
  window_tight: 'Окно почти без запаса',
  load_balance: 'Выравнивает загрузку',
  cluster: 'Рядом с соседними заявками',
  urgent_priority: 'Срочная заявка',
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

export function reasonText(reason: AssignmentReason): string {
  return REASON_TITLES[reason.code] ?? reason.code;
}

/**
 * Whether the reason is a checked constraint or the outcome of a limited search.
 * The difference is the whole point of `basis`: a search that did not find an
 * assignment has not proved one impossible.
 */
export function reasonIsProof(reason: AssignmentReason): boolean {
  return reason.basis === 'constraint_check';
}
