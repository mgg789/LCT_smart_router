import type { DashboardSnapshot, PlanRouteView, RequestView } from '../api/types';

export const ALL_REGIONS = 'all' as const;
export type RegionSelection = typeof ALL_REGIONS | string;

const REGION_STYLES: Record<string, { readonly label: string; readonly color: string }> = {
  east: { label: 'Восточный округ', color: '#E5B900' },
  southeast: { label: 'Юго-Восточный округ', color: '#159A8C' },
  south_central: { label: 'Южный и Центральный округа', color: '#7C5CDB' },
  moscow: { label: 'Москва', color: '#E5B900' },
};

const FALLBACK_PALETTE = ['#2B6CB0', '#C05621', '#2F855A', '#B83280', '#6B46C1', '#0F766E'];

export interface RegionOption {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly requestCount: number;
  readonly engineerCount: number;
}

/** Returns the stable display label and color for official and uploaded regions. */
export function regionStyle(region: string | null): {
  readonly label: string;
  readonly color: string;
} {
  if (!region) {
    return { label: 'Регион не указан', color: '#7A7E83' };
  }
  return REGION_STYLES[region] ?? { label: humanizeRegion(region), color: hashColor(region) };
}

/** Derives selectable regions from both requests and engineers. */
export function regionOptions(snapshot: DashboardSnapshot): RegionOption[] {
  const ids = new Set<string>();
  for (const request of snapshot.requests) {
    if (request.region) ids.add(request.region);
  }
  for (const engineer of snapshot.engineers) {
    if (engineer.region) ids.add(engineer.region);
  }
  return [...ids]
    .sort((left, right) => regionOrder(left) - regionOrder(right) || left.localeCompare(right))
    .map((id) => ({
      id,
      ...regionStyle(id),
      requestCount: snapshot.requests.filter((request) => request.region === id).length,
      engineerCount: snapshot.engineers.filter((engineer) => engineer.region === id).length,
    }));
}

/** Restricts every plan-facing collection to one region while preserving snapshot metadata. */
export function filterSnapshotByRegion(
  snapshot: DashboardSnapshot,
  selected: RegionSelection,
): DashboardSnapshot {
  if (selected === ALL_REGIONS) {
    return snapshot;
  }
  const engineers = snapshot.engineers.filter((engineer) => engineer.region === selected);
  const engineerIds = new Set(engineers.map((engineer) => engineer.id));
  const requests = snapshot.requests.filter((request) => request.region === selected);
  const requestIds = new Set(requests.map((request) => request.id));
  const plan = snapshot.plan.plan;
  return {
    ...snapshot,
    engineers,
    requests,
    alerts: snapshot.alerts.filter(
      (alert) =>
        alert.engineerIds.some((id) => engineerIds.has(id)) ||
        alert.requestIds.some((id) => requestIds.has(id)),
    ),
    plan: {
      ...snapshot.plan,
      plan: plan
        ? {
            ...plan,
            routes: plan.routes.filter((route) => engineerIds.has(route.engineerId)),
            assignments: plan.assignments.filter((assignment) =>
              requestIds.has(assignment.requestId),
            ),
          }
        : null,
    },
  };
}

/** Resolves a request region and falls back to its assigned engineer for legacy rows. */
export function requestRegion(snapshot: DashboardSnapshot, request: RequestView): string | null {
  if (request.region) {
    return request.region;
  }
  const engineerId = snapshot.plan.plan?.assignments.find(
    (assignment) => assignment.requestId === request.id,
  )?.engineerId;
  return snapshot.engineers.find((engineer) => engineer.id === engineerId)?.region ?? null;
}

/** Finds a route region from its engineer. */
export function routeRegion(snapshot: DashboardSnapshot, route: PlanRouteView): string | null {
  return snapshot.engineers.find((engineer) => engineer.id === route.engineerId)?.region ?? null;
}

function regionOrder(region: string): number {
  const official = ['east', 'southeast', 'south_central'];
  const index = official.indexOf(region);
  return index < 0 ? official.length : index;
}

function humanizeRegion(region: string): string {
  return region
    .split('_')
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function hashColor(region: string): string {
  let hash = 0;
  for (const character of region) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length] ?? '#2B6CB0';
}
