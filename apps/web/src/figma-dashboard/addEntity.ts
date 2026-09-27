import { useEffect, useState } from 'react';
import type { DashboardSnapshot } from '../api/types';
import { regionOptions, regionStyle } from '../domain/regions';
import { t } from '../i18n';
import { moscowAt } from '../lib/time';

export const ADD_TABS = ['request', 'engineer', 'region'] as const;
export type AddTab = (typeof ADD_TABS)[number];

export const ADD_TAB_LABEL: Record<AddTab, string> = {
  request: t('figma-dashboard.addEntity.77b3e0166b'),
  engineer: t('figma-dashboard.addEntity.88d71676fa'),
  region: t('figma-dashboard.addEntity.d7506709ce'),
};

export const SKILL_OPTIONS = [
  { id: 'local', label: t('figma-dashboard.addEntity.d90d1d1aa8') },
  { id: 'connection', label: t('figma-dashboard.addEntity.ab71afb97f') },
  { id: 'emergency', label: t('figma-dashboard.addEntity.b8cbf459a0') },
] as const;

export type SkillId = (typeof SKILL_OPTIONS)[number]['id'];

export const TRANSPORT_OPTIONS = [
  { id: 'car', label: t('figma-dashboard.addEntity.8dca2f7831') },
  { id: 'walk', label: t('figma-dashboard.addEntity.7e072732b4') },
  { id: 'bike', label: t('figma-dashboard.addEntity.06458c4e6b') },
] as const;

export type TransportId = (typeof TRANSPORT_OPTIONS)[number]['id'];

/**
 * Dispatcher-facing alert kinds. The live alert engine is not createable yet;
 * these labels seed the inbox card until POST /dispatch/alerts exists.
 */
export const ALERT_TYPE_OPTIONS = [
  { id: 'sla', label: t('figma-dashboard.addEntity.ad9e05b4a9') },
  { id: 'window', label: t('figma-dashboard.addEntity.a0d7e011c3') },
  { id: 'skill', label: t('figma-dashboard.addEntity.97b480d8d7') },
  { id: 'lunch', label: t('figma-dashboard.addEntity.6183795ae0') },
  { id: 'coverage', label: t('figma-dashboard.addEntity.a47331f22c') },
  { id: 'other', label: t('figma-dashboard.addEntity.001f75c6b3') },
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

/** Stretch a typed window so the work norm actually fits. */
export function fitWindowToService(
  window: { windowStartAt: number; windowEndAt: number },
  service: number,
): { windowStartAt: number; windowEndAt: number } {
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
  if (!start || !end) return t('figma-dashboard.addEntity.7bf6526c33');
  const windowStartAt = moscowAt(workDate, start.hour, start.minute);
  const windowEndAt = moscowAt(workDate, end.hour, end.minute);
  if (windowEndAt <= windowStartAt) return t('figma-dashboard.addEntity.1694ee9e17');
  return { windowStartAt, windowEndAt };
}

export function validateRequestDraft(
  draft: {
    workType: string;
    addressText: string;
    startClock: string;
    endClock: string;
    lat?: number | null;
    lon?: number | null;
  },
  workTypes: readonly { code: string }[],
): string | null {
  if (!workTypes.some((item) => item.code === draft.workType))
    return t('figma-dashboard.addEntity.ac2f9dd3d7');
  if (!draft.addressText.trim()) return t('figma-dashboard.addEntity.adb52cde02');
  if (draft.lat == null || draft.lon == null) {
    return t('figma-dashboard.addEntity.4dd430a328');
  }
  if (!parseClock(draft.startClock) || !parseClock(draft.endClock))
    return t('figma-dashboard.addEntity.7bf6526c33');
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
  if (!draft.displayName.trim()) return t('figma-dashboard.addEntity.833dc660a6');
  if (draft.skills.length === 0) return t('figma-dashboard.addEntity.6a4298336b');
  if (!TRANSPORT_OPTIONS.some((item) => item.id === draft.transportType))
    return t('figma-dashboard.addEntity.1840f4cded');
  if (!draft.region) return t('figma-dashboard.addEntity.afd076294c');
  if (draft.homeLat == null || draft.homeLon == null) {
    return t('figma-dashboard.addEntity.21cfc912d9');
  }
  if (draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
    return t('figma-dashboard.addEntity.932880ca99');
  }
  return null;
}

export function validateRegionDraft(name: string): string | null {
  return name.trim() ? null : t('figma-dashboard.addEntity.d14b4e74e2');
}

export function validateOfficeDraft(region: string, addressText: string): string | null {
  if (!region) return t('figma-dashboard.addEntity.4244bde3da');
  if (!addressText.trim()) return t('figma-dashboard.addEntity.cec37ac4e6');
  return null;
}

export function validateAlertDraft(draft: {
  title: string;
  type: string;
  reason: string;
}): string | null {
  if (!draft.title.trim()) return t('figma-dashboard.addEntity.e45da69c3e');
  if (!ALERT_TYPE_OPTIONS.some((item) => item.id === draft.type))
    return t('figma-dashboard.addEntity.056218708b');
  if (!draft.reason.trim()) return t('figma-dashboard.addEntity.0f285212ad');
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
