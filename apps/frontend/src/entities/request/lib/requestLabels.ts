import type { RequestLifecycle, RequestView, RequiredSkill } from '../model/types';

/** Russian names of the three skills the contract knows. */
const SKILL_TITLES: Record<RequiredSkill, string> = {
  local: 'Локальные работы',
  connection: 'Подключение',
  emergency: 'Авария',
};

/** Short badge for a skill, as the mockup marks points on the map (Л / П / А). */
const SKILL_BADGES: Record<RequiredSkill, string> = {
  local: 'Л',
  connection: 'П',
  emergency: 'А',
};

const LIFECYCLE_TITLES: Record<RequestLifecycle, string> = {
  draft: 'Черновик',
  submitted: 'Назначена',
  in_progress: 'В работе',
  completed: 'Выполнена',
  cancelled: 'Отменена',
};

export function skillTitle(skill: RequiredSkill): string {
  return SKILL_TITLES[skill] ?? skill;
}

export function skillBadge(skill: RequiredSkill): string {
  return SKILL_BADGES[skill] ?? '?';
}

/**
 * What the dispatcher sees in the status column.
 *
 * A request waiting for a fresh calculation says so: `pending` is not a refusal
 * and must never read as "unassigned" (docs/frontend-api.md §12).
 */
export function requestStatusTitle(request: RequestView): string {
  if (request.lifecycle === 'cancelled') return 'Отменена';
  if (request.lifecycle === 'completed') return 'Выполнена';
  if (request.lifecycle === 'in_progress') return 'В работе';
  if (request.assignmentState === 'pending') return 'Ждёт расчёта';
  if (request.assignmentState === 'unassigned') return 'Без назначения';
  return LIFECYCLE_TITLES[request.lifecycle] ?? request.lifecycle;
}

/** Requests the router could not place; the day header counts them. */
export function unassignedRequests(requests: RequestView[]): RequestView[] {
  return requests.filter(
    (request) => request.assignmentState === 'unassigned' && request.lifecycle !== 'cancelled',
  );
}

/** Everything that is still part of today's work, cancellations excluded. */
export function activeRequests(requests: RequestView[]): RequestView[] {
  return requests.filter((request) => request.lifecycle !== 'cancelled');
}
