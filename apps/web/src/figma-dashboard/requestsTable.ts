import type { DashboardSnapshot, RequestView } from '../api/types';
import { assignmentFor } from '../domain/dashboard';
import { skillLabel } from '../lib/reasons';
import { formatClock } from '../lib/time';

export type RequestRowStatus = 'in_progress' | 'assigned' | 'done' | 'unassigned' | 'cancelled';

/** First UUID segment (8 chars) is what the dispatcher UI can fit. */
export const REQUEST_ID_SEGMENT = 8;

/**
 * Short request number for table cells and the dark plan panel.
 * Keeps the first hyphen-separated segment, then cuts to 8 characters.
 */
export function shortRequestId(id: string): string {
  const segment = id.trim().split('-')[0] ?? id;
  return segment.slice(0, REQUEST_ID_SEGMENT);
}

export type RequestSortId = 'usage' | 'number' | 'window';

export type RequestTableRow = {
  id: string;
  number: string;
  address: string;
  service: string;
  window: string;
  windowStartAt: number;
  engineer: string;
  status: RequestRowStatus;
};

export const REQUEST_SORT_OPTIONS = [
  { id: 'usage', label: 'По использованию' },
  { id: 'number', label: 'По номеру' },
  { id: 'window', label: 'По окну' },
] as const satisfies readonly { id: RequestSortId; label: string }[];

const USAGE_RANK: Record<RequestRowStatus, number> = {
  in_progress: 0,
  assigned: 1,
  unassigned: 2,
  done: 3,
  cancelled: 4,
};

/**
 * Figma REQUESTS chips. Unassigned is the leftover state the mock does not paint.
 */
export function requestStatusLabel(status: RequestRowStatus): string {
  if (status === 'in_progress') return 'В работе';
  if (status === 'assigned') return 'Назначена';
  if (status === 'done') return 'Выполнена';
  if (status === 'cancelled') return 'Отменена';
  return 'Без назначения';
}

/**
 * Maps a live request onto the Figma Tips chips (55:7485).
 */
export function requestRowStatus(request: RequestView): RequestRowStatus {
  if (request.lifecycle === 'cancelled' || request.cancelledAt) return 'cancelled';
  if (request.lifecycle === 'completed' || request.assignmentState === 'done') return 'done';
  if (request.assignmentState === 'in_progress' || request.lifecycle === 'in_progress') {
    return 'in_progress';
  }
  if (request.assignmentState === 'assigned') return 'assigned';
  return 'unassigned';
}

/**
 * Street + house from a full address so the Адрес column stays two lines max.
 */
export function shortRequestAddress(address: string): string {
  const parts = address
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 2) return address;
  return parts.slice(-2).join(', ');
}

/**
 * One table row per snapshot request, with the assigned engineer when the plan has one.
 */
export function rowsFromSnapshot(snapshot: DashboardSnapshot): RequestTableRow[] {
  return snapshot.requests.map((request) => {
    const assignment = assignmentFor(snapshot, request.id);
    const engineer = assignment
      ? (snapshot.engineers.find((item) => item.id === assignment.engineerId) ?? null)
      : null;
    return {
      id: request.id,
      number: request.id,
      address: shortRequestAddress(request.addressText),
      service: request.workTypeTitle ?? skillLabel(request.requiredSkill),
      window: `${formatClock(request.windowStartAt)}-${formatClock(request.windowEndAt)}`,
      windowStartAt: request.windowStartAt,
      engineer: engineer?.displayName ?? '—',
      status: requestRowStatus(request),
    };
  });
}

/**
 * Case-insensitive filter by number, address, service or engineer.
 */
export function filterRequestRows(
  rows: readonly RequestTableRow[],
  query: string,
): RequestTableRow[] {
  const needle = query.trim().toLocaleLowerCase('ru');
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [row.number, row.address, row.service, row.engineer].some((value) =>
      value.toLocaleLowerCase('ru').includes(needle),
    ),
  );
}

/**
 * Default Figma order: in-progress first, then assigned, unassigned, done.
 */
export function sortRequestRows(
  rows: readonly RequestTableRow[],
  sort: RequestSortId,
): RequestTableRow[] {
  return [...rows].sort((left, right) => {
    if (sort === 'number') {
      return left.number.localeCompare(right.number, 'ru', { numeric: true });
    }
    if (sort === 'window') {
      return left.windowStartAt - right.windowStartAt || left.number.localeCompare(right.number, 'ru');
    }
    const usage = USAGE_RANK[left.status] - USAGE_RANK[right.status];
    if (usage !== 0) return usage;
    return left.number.localeCompare(right.number, 'ru', { numeric: true });
  });
}

export const DEMO_REQUEST_ROWS: readonly RequestTableRow[] = [
  {
    id: '1024',
    number: '1024',
    address: 'ул. Таганская, 24',
    service: 'Подключение интернета',
    window: '12:00-14:00',
    windowStartAt: 12,
    engineer: 'Алексей Соколов',
    status: 'in_progress',
  },
  {
    id: '1039',
    number: '1039',
    address: 'ул. Таганская, 24',
    service: 'Подключение интернета',
    window: '12:00-14:00',
    windowStartAt: 12,
    engineer: 'Алексей Соколов',
    status: 'assigned',
  },
  {
    id: '1038',
    number: '1038',
    address: 'ул. Верхняя Радищевская, 5',
    service: 'IP-телефония',
    window: '13:30-14:40',
    windowStartAt: 13,
    engineer: 'Мария Александровна',
    status: 'done',
  },
  {
    id: '1065',
    number: '1065',
    address: 'ул. Пятницкая, 17',
    service: 'Диагностика сети',
    window: '11:00-13:00',
    windowStartAt: 11,
    engineer: 'Иван Столяров',
    status: 'in_progress',
  },
  {
    id: '1170',
    number: '1170',
    address: 'ул. Таганская, 24',
    service: 'Подключение интернета',
    window: '12:00-14:00',
    windowStartAt: 12,
    engineer: 'Алексей Соколов',
    status: 'assigned',
  },
  {
    id: '1098',
    number: '1098',
    address: 'ул. Верхняя Радищевская, 5',
    service: 'IP-телефония',
    window: '13:30-14:40',
    windowStartAt: 13,
    engineer: 'Мария Александровна',
    status: 'done',
  },
  {
    id: '1097',
    number: '1097',
    address: 'ул. Пятницкая, 17',
    service: 'Диагностика сети',
    window: '11:00-13:00',
    windowStartAt: 11,
    engineer: 'Иван Столяров',
    status: 'in_progress',
  },
  {
    id: '1254',
    number: '1254',
    address: 'ул. Пятницкая, 17',
    service: 'Диагностика сети',
    window: '11:00-13:00',
    windowStartAt: 11,
    engineer: 'Иван Столяров',
    status: 'in_progress',
  },
  {
    id: '1133',
    number: '1133',
    address: 'ул. Верхняя Радищевская, 5',
    service: 'IP-телефония',
    window: '13:30-14:40',
    windowStartAt: 13,
    engineer: 'Мария Александровна',
    status: 'done',
  },
];
