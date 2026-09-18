import type {
  DashboardSnapshot,
  EngineerDayView,
  EngineerPlanResponse,
  EngineerView,
} from '../api/types';
import { routeForEngineer } from '../domain/dashboard';
import { moscowAt } from '../lib/time';

export const ENGINEER_ROSTER_KEY = 'lct.engineer.preview.roster';

export interface EngineerPreview {
  readonly profile: EngineerView;
  readonly day: EngineerDayView;
  readonly plan: EngineerPlanResponse;
}

/**
 * Local-only login address for a brigade that still has none.
 *
 * The recorded demo snapshot has no emails; the dispatcher still needs a visible address
 * to open the Engineer App as that person.
 */
export function localEngineerEmail(engineer: {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
}): string {
  if (engineer.email) {
    return engineer.email;
  }
  const slug = engineer.displayName
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '.')
    .replace(/^\.+|\.+$/g, '');
  return `${slug || engineer.id}@demo.local`;
}

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True only in the Vite dev server — production still requires the emailed code. */
export function isLocalEngineerBypass(): boolean {
  return import.meta.env.DEV;
}

/** Builds what `/engineer/` would show for one crew from the dispatcher snapshot. */
export function buildEngineerPreview(
  snapshot: DashboardSnapshot,
  engineerId: string,
): EngineerPreview | null {
  const engineer = snapshot.engineers.find((item) => item.id === engineerId);
  if (!engineer) {
    return null;
  }
  const route = routeForEngineer(snapshot, engineerId);
  const requestIds = new Set(
    (route?.stops ?? [])
      .map((stop) => stop.requestId)
      .filter((requestId): requestId is string => requestId !== null),
  );
  const { day: _day, ...profileFields } = engineer;
  return {
    profile: {
      ...profileFields,
      email: localEngineerEmail(engineer),
    },
    day: engineer.day ?? fallbackDay(engineer.id, snapshot.workDate),
    plan: {
      planAsOf: snapshot.plan.plan?.planAsOf ?? snapshot.nowAt,
      origin: snapshot.plan.plan?.origin ?? null,
      revision: snapshot.plan.plan?.revision ?? null,
      route,
      requests: snapshot.requests.filter((request) => requestIds.has(request.id)),
    },
  };
}

/** Writes every brigade of the current dispatcher day so email login can pick one. */
export function writeEngineerRoster(storage: Storage, snapshot: DashboardSnapshot): void {
  const previews = snapshot.engineers.flatMap((engineer) => {
    const preview = buildEngineerPreview(snapshot, engineer.id);
    return preview === null ? [] : [preview];
  });
  storage.setItem(ENGINEER_ROSTER_KEY, JSON.stringify({ previews }));
}

/** Finds a stored local preview by the address shown on the dispatcher roster. */
export function findEngineerPreview(storage: Storage, email: string): EngineerPreview | null {
  const raw = storage.getItem(ENGINEER_ROSTER_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { previews?: EngineerPreview[] };
    const wanted = normalizeLoginEmail(email);
    return (
      parsed.previews?.find(
        (item) => item.profile.email !== null && normalizeLoginEmail(item.profile.email) === wanted,
      ) ?? null
    );
  } catch {
    return null;
  }
}

export function clearEngineerRoster(storage: Storage): void {
  storage.removeItem(ENGINEER_ROSTER_KEY);
}

function fallbackDay(engineerId: string, workDate: string): EngineerDayView {
  return {
    engineerId,
    workDate,
    version: 1,
    shiftStartAt: moscowAt(workDate, 9),
    shiftEndAt: moscowAt(workDate, 18),
    availability: 'offline',
    expectedOnlineAt: null,
    equipmentStock: { router: 0, setTopBox: 0, smartSpeaker: 0 },
    equipmentIssuedAt: null,
    lunch: {
      enabled: false,
      durationSec: null,
      windowStartAt: null,
      windowEndAt: null,
      required: false,
      taken: false,
      startedAt: null,
    },
  };
}
