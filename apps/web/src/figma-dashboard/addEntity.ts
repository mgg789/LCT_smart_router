import { useEffect, useState } from 'react';
import type { DashboardSnapshot } from '../api/types';
import { regionOptions, regionStyle } from '../domain/regions';
import { moscowAt } from '../lib/time';

export const ADD_TABS = ['request', 'engineer', 'region'] as const;
export type AddTab = (typeof ADD_TABS)[number];

export const ADD_TAB_LABEL: Record<AddTab, string> = {
  request: 'Заявка',
  engineer: 'Инженер',
  region: 'Регион',
};

/**
 * Work types shown in the add-request form. Codes match GET /client/work-types
 * and POST /dispatch/requests {workType}.
 */
export const WORK_TYPE_OPTIONS = [
  { code: 'connection_request', title: 'Заявка на подключение' },
  { code: 'convergence', title: 'Конвергенция абонента' },
  { code: 'equipment_order', title: 'Дозаказ оборудования' },
  { code: 'router_replacement', title: 'Роутер. Замена' },
  { code: 'stb_replacement', title: 'ТВ/TVE/ENT. Замена приставки' },
  { code: 'gigabit_switch', title: 'Переключение на Гбит/с' },
  { code: 'outage', title: 'Авария' },
  { code: 'no_link', title: 'Нет линка' },
  { code: 'disconnects', title: 'Разрывы' },
  { code: 'low_speed', title: 'Низкая скорость' },
  { code: 'port_errors', title: 'Рост ошибок на порту' },
  { code: 'ip_169', title: 'IP-адрес 169...' },
  { code: 'cable_work', title: 'Работа с кабелем' },
  { code: 'monitoring', title: 'Мониторинг' },
  { code: 'other_errors', title: 'TVE/ENT. Другие ошибки' },
  { code: 'information', title: 'Информация' },
] as const;

export type WorkTypeCode = (typeof WORK_TYPE_OPTIONS)[number]['code'];

export const SKILL_OPTIONS = [
  { id: 'local', label: 'Локальные работы' },
  { id: 'connection', label: 'Подключение' },
  { id: 'emergency', label: 'Авария' },
] as const;

export type SkillId = (typeof SKILL_OPTIONS)[number]['id'];

export const TRANSPORT_OPTIONS = [
  { id: 'car', label: 'Авто' },
  { id: 'walk', label: 'Пешком' },
  { id: 'bike', label: 'Велосипед' },
  { id: 'transit', label: 'Общественный транспорт' },
] as const;

export type TransportId = (typeof TRANSPORT_OPTIONS)[number]['id'];

/**
 * Dispatcher-facing alert kinds. The live alert engine is not createable yet;
 * these labels seed the inbox card until POST /dispatch/alerts exists.
 */
export const ALERT_TYPE_OPTIONS = [
  { id: 'sla', label: 'Риск SLA' },
  { id: 'window', label: 'Окно заявки' },
  { id: 'skill', label: 'Нет навыка' },
  { id: 'lunch', label: 'Обед не влезает' },
  { id: 'coverage', label: 'Непокрытие' },
  { id: 'other', label: 'Другое' },
] as const;

export type AlertTypeId = (typeof ALERT_TYPE_OPTIONS)[number]['id'];

export type SessionRegion = { id: string; label: string };
export type SessionOffice = { id: string; region: string; addressText: string };

type SessionState = {
  regions: SessionRegion[];
  offices: SessionOffice[];
};

type SessionListener = () => void;

let session: SessionState = { regions: [], offices: [] };
const listeners = new Set<SessionListener>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Regions the dispatcher added this session (no create-region API yet). */
export function addedRegions(): readonly SessionRegion[] {
  return session.regions;
}

/** Offices the dispatcher added this session (no create-depot API yet). */
export function addedOffices(): readonly SessionOffice[] {
  return session.offices;
}

export function subscribeAddedEntities(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test helper: drop session regions and offices. */
export function resetAddedEntities(): void {
  session = { regions: [], offices: [] };
  emit();
}

export function useAddedEntities(): SessionState {
  const [value, setValue] = useState(session);
  useEffect(() => subscribeAddedEntities(() => setValue({ ...session })), []);
  return value;
}

/** Slug for a region title: lowercase, spaces to underscore, keep Cyrillic. */
export function regionIdFromLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

export function addSessionRegion(label: string): SessionRegion {
  const trimmed = label.trim();
  const id = regionIdFromLabel(trimmed);
  const existing = session.regions.find((item) => item.id === id);
  if (existing) return existing;
  const next = { id, label: trimmed };
  session = { ...session, regions: [...session.regions, next] };
  emit();
  return next;
}

export function addSessionOffice(region: string, addressText: string): SessionOffice {
  const next: SessionOffice = {
    id: `office-${region}-${session.offices.length + 1}`,
    region,
    addressText: addressText.trim(),
  };
  session = { ...session, offices: [...session.offices, next] };
  emit();
  return next;
}

export function parseClock(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** On-site norms mirrored from the System Layer catalogue. */
export const WORK_TYPE_SERVICE_SEC: Record<WorkTypeCode, number> = {
  connection_request: 4200,
  convergence: 4200,
  equipment_order: 1200,
  router_replacement: 1200,
  stb_replacement: 1200,
  gigabit_switch: 4200,
  outage: 4800,
  no_link: 4800,
  disconnects: 4800,
  low_speed: 4800,
  port_errors: 4800,
  ip_169: 4800,
  cable_work: 1800,
  monitoring: 1800,
  other_errors: 1800,
  information: 1800,
};

/** Stretch a typed window so the work norm actually fits. */
export function fitWindowToService(
  window: { windowStartAt: number; windowEndAt: number },
  workType: string,
): { windowStartAt: number; windowEndAt: number } {
  const service =
    workType in WORK_TYPE_SERVICE_SEC ? WORK_TYPE_SERVICE_SEC[workType as WorkTypeCode] : 0;
  if (window.windowEndAt - window.windowStartAt >= service) return window;
  return { windowStartAt: window.windowStartAt, windowEndAt: window.windowStartAt + service };
}

/** Converts two HH:MM fields on the snapshot work date into Unix seconds. */
export function windowFromClocks(
  workDate: string,
  startClock: string,
  endClock: string,
): { windowStartAt: number; windowEndAt: number } | string {
  const start = parseClock(startClock);
  const end = parseClock(endClock);
  if (!start || !end) return 'Укажите окно в формате ЧЧ:ММ';
  const windowStartAt = moscowAt(workDate, start.hour, start.minute);
  const windowEndAt = moscowAt(workDate, end.hour, end.minute);
  if (windowEndAt <= windowStartAt) return 'Окно должно заканчиваться позже начала';
  return { windowStartAt, windowEndAt };
}

export function validateRequestDraft(draft: {
  workType: string;
  addressText: string;
  startClock: string;
  endClock: string;
  lat?: number | null;
  lon?: number | null;
}): string | null {
  if (!WORK_TYPE_OPTIONS.some((item) => item.code === draft.workType)) return 'Выберите тип заявки';
  if (!draft.addressText.trim()) return 'Укажите адрес';
  if (draft.lat == null || draft.lon == null) {
    return 'Выберите адрес из подсказки или точку на карте';
  }
  if (!parseClock(draft.startClock) || !parseClock(draft.endClock))
    return 'Укажите окно в формате ЧЧ:ММ';
  return null;
}

export function validateEngineerDraft(draft: {
  displayName: string;
  skills: readonly string[];
  transportType: string;
  region: string;
  email: string;
  homeLat?: number | null;
  homeLon?: number | null;
}): string | null {
  if (!draft.displayName.trim()) return 'Укажите имя инженера';
  if (draft.skills.length === 0) return 'Выберите хотя бы один навык';
  if (!TRANSPORT_OPTIONS.some((item) => item.id === draft.transportType))
    return 'Выберите транспорт';
  if (!draft.region) return 'Выберите регион';
  if (draft.homeLat == null || draft.homeLon == null) {
    return 'Укажите адрес офиса из подсказки или точку на карте';
  }
  if (draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
    return 'Проверьте адрес почты';
  }
  return null;
}

export function validateRegionDraft(name: string): string | null {
  return name.trim() ? null : 'Укажите название региона';
}

export function validateOfficeDraft(region: string, addressText: string): string | null {
  if (!region) return 'Выберите регион привязки';
  if (!addressText.trim()) return 'Укажите адрес офиса';
  return null;
}

export function validateAlertDraft(draft: {
  title: string;
  type: string;
  reason: string;
}): string | null {
  if (!draft.title.trim()) return 'Укажите название';
  if (!ALERT_TYPE_OPTIONS.some((item) => item.id === draft.type)) return 'Выберите тип алёрта';
  if (!draft.reason.trim()) return 'Укажите причину';
  return null;
}

export function alertTypeLabel(type: string): string {
  return ALERT_TYPE_OPTIONS.find((item) => item.id === type)?.label ?? type;
}

/** Snapshot regions plus session-added ones, for the engineer/office pickers. */
export function selectableRegions(snapshot: DashboardSnapshot | null): Array<{
  id: string;
  label: string;
}> {
  const fromSnapshot = snapshot ? regionOptions(snapshot) : [];
  const seen = new Set(fromSnapshot.map((item) => item.id));
  const extra = session.regions.filter((item) => !seen.has(item.id));
  return [
    ...fromSnapshot.map((item) => ({ id: item.id, label: item.label })),
    ...extra.map((item) => ({ id: item.id, label: item.label })),
  ];
}

/** Session offices for one region. Live depots are not in the snapshot yet. */
export function officesForRegion(region: string): SessionOffice[] {
  return session.offices.filter((item) => item.region === region);
}

export function regionPickerLabel(region: string): string {
  const added = session.regions.find((item) => item.id === region);
  return added?.label ?? regionStyle(region).label;
}
