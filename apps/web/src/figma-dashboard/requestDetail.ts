import type { DashboardSnapshot, EquipmentType, RequestView } from '../api/types';
import { assignmentFor, routeForEngineer } from '../domain/dashboard';
import { skillLabel } from '../lib/reasons';
import { formatClock } from '../lib/time';
import { requestUrgency } from './fromSnapshot';
import { type RequestTableRow, shortRequestId } from './requestsTable';

export const EQUIPMENT_LABELS: Record<EquipmentType, string> = {
  router: 'Роутер',
  set_top_box: 'ТВ-приставка',
  smart_speaker: 'Умная колонка',
};

export type RequestDetailModel = {
  id: string;
  title: string;
  numberLabel: string;
  primaryTags: string[];
  equipmentTags: string[];
  address: string;
  email: string | null;
  contactName: string | null;
  windowLabel: string;
  engineerLabel: string;
};

/** Dispatcher label for a stored equipment type. */
export function requestEquipmentLabel(type: EquipmentType): string {
  return EQUIPMENT_LABELS[type];
}

/**
 * Client window, plus planned arrival when the solver has one.
 * Example: `12:40-16:45 (расчетное 13:07)`.
 */
export function requestWindowLabel(
  windowStartAt: number,
  windowEndAt: number,
  etaAt: number | null,
): string {
  const window = `${formatClock(windowStartAt)}-${formatClock(windowEndAt)}`;
  if (etaAt == null) return window;
  return `${window} (расчетное ${formatClock(etaAt)})`;
}

/** Gray chips on REQUET: skill / urgency, then required equipment. */
export function requestDetailTags(request: RequestView): {
  primary: string[];
  equipment: string[];
} {
  const skill = request.requiredSkill ? capitalizeRu(skillLabel(request.requiredSkill)) : null;
  const primary: string[] = [];
  if (skill) primary.push(skill);
  const urgency = requestUrgency(request);
  if (urgency.tone !== 'neutral') primary.push(urgency.label);
  const equipment = request.requiredEquipment
    ? [requestEquipmentLabel(request.requiredEquipment)]
    : [];
  return { primary, equipment };
}

/**
 * Right-panel model for Figma REQUET (55:7636) from a live snapshot.
 * Client email is not in RequestView — the row stays, value is empty.
 */
export function requestDetailFromSnapshot(
  snapshot: DashboardSnapshot,
  requestId: string,
): RequestDetailModel | null {
  const request = snapshot.requests.find((item) => item.id === requestId);
  if (!request) return null;
  const assignment = assignmentFor(snapshot, request.id);
  const engineer = assignment
    ? (snapshot.engineers.find((item) => item.id === assignment.engineerId) ?? null)
    : null;
  const route = assignment?.engineerId ? routeForEngineer(snapshot, assignment.engineerId) : null;
  const stop = route?.stops.find((item) => item.requestId === request.id);
  const etaAt = stop?.arrivalAt ?? request.expectedCompletionAt ?? null;
  const tags = requestDetailTags(request);
  return {
    id: request.id,
    title: request.workTypeTitle || 'Заявка',
    numberLabel: `Заявка № ${shortRequestId(request.id)}`,
    primaryTags: tags.primary,
    equipmentTags: tags.equipment,
    address: request.addressText,
    email: null,
    contactName: request.contactName,
    windowLabel: requestWindowLabel(request.windowStartAt, request.windowEndAt, etaAt),
    engineerLabel: engineer ? `Инженер: ${engineer.displayName}` : 'Инженер: —',
  };
}

/** Offline table-row fallback when the dashboard snapshot is not loaded. */
export function requestDetailFromRow(row: RequestTableRow): RequestDetailModel {
  return {
    id: row.id,
    title: row.service,
    numberLabel: `Заявка № ${shortRequestId(row.id)}`,
    primaryTags: [row.service],
    equipmentTags: [],
    address: row.address,
    email: null,
    contactName: null,
    windowLabel: row.window,
    engineerLabel: row.engineer !== '—' ? `Инженер: ${row.engineer}` : 'Инженер: —',
  };
}

function capitalizeRu(value: string): string {
  if (!value) return value;
  return value.slice(0, 1).toLocaleUpperCase('ru') + value.slice(1);
}
