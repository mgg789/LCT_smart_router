import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../persistence';
import type {
  RouterSimulation,
  RouterSimulationPatch,
  SimulationRoute,
} from '../../routing/router-gateway';
export interface SimulationPatchInput {
  readonly catalog?: boolean;
  readonly policyId?: string;
  readonly lunchesEnabled?: boolean;
  readonly metroEnabled?: boolean;
  readonly trafficEnabled?: boolean;
  readonly equipmentEnabled?: boolean;
  readonly equipmentTransfersEnabled?: boolean;
  readonly window?: {
    readonly requestId: string;
    readonly windowStartAt: number;
    readonly windowEndAt: number;
  };
  readonly pin?: { readonly requestId: string; readonly engineerId: string };
  readonly unassignRequestId?: string;
}

const POLICY_NAMES: Record<string, string> = {
  fast: 'быструю',
  compact: 'компактную',
  sla: 'по окнам',
  balanced: 'сбалансированную',
  eco: 'экономную',
  covering: 'полное покрытие',
};

export interface SimulationDeltaView {
  readonly assigned: number;
  readonly unassigned: number;
  readonly lateAssigned: number;
  readonly totalLatenessSec: number;
  readonly distanceKm: number;
  readonly transfers: number;
  readonly beforeLate: number;
  readonly afterLate: number;
  readonly beforeUnassigned: number;
  readonly afterUnassigned: number;
}

/** True when lateness or the unassigned count grows. Distance alone does not warn. */
export function worsensPlan(delta: SimulationDeltaView | null): boolean {
  if (!delta) return false;
  return delta.lateAssigned > 0 || delta.unassigned > 0;
}

/** Camel patch from the dispatcher becomes the snake patch the solver validates. */
export function toRouterPatch(input: SimulationPatchInput): RouterSimulationPatch {
  return {
    ...(input.catalog ? { catalog: true } : {}),
    ...(input.policyId ? { policy_id: input.policyId } : {}),
    ...(input.lunchesEnabled !== undefined ? { lunches_enabled: input.lunchesEnabled } : {}),
    ...(input.metroEnabled !== undefined ? { metro_enabled: input.metroEnabled } : {}),
    ...(input.trafficEnabled !== undefined ? { traffic_enabled: input.trafficEnabled } : {}),
    ...(input.equipmentEnabled !== undefined ? { equipment_enabled: input.equipmentEnabled } : {}),
    ...(input.equipmentTransfersEnabled !== undefined
      ? { equipment_transfers_enabled: input.equipmentTransfersEnabled }
      : {}),
    ...(input.window
      ? {
          window: {
            request_id: input.window.requestId,
            window_start_at: input.window.windowStartAt,
            window_end_at: input.window.windowEndAt,
          },
        }
      : {}),
    ...(input.pin
      ? { pin: { request_id: input.pin.requestId, engineer_id: input.pin.engineerId } }
      : {}),
    ...(input.unassignRequestId ? { unassign_request_id: input.unassignRequestId } : {}),
  };
}

export function toRouteView(route: SimulationRoute) {
  return {
    engineerId: route.engineer_id,
    segments: route.segments.map((segment) => ({
      travelSource: segment.travel_source,
      points: segment.points.map((point) => ({ lat: point.lat, lon: point.lon })),
    })),
  };
}

/** Same bytes Python hashes: sorted keys, no nulls, no spaces. */
export function simulationPatchHash(patch: RouterSimulationPatch): string {
  return createHash('sha256').update(canonicalJson(patch)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined && item !== null)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export function russianDelta(patch: RouterSimulationPatch, result: RouterSimulation): string {
  const delta = result.delta;
  if (!delta) return 'Сравнение стратегий посчитано. Рабочий план не изменён.';
  const late = `опозданий было ${delta.before.late_assigned_count}, станет ${delta.after.late_assigned_count}`;
  const open = `без назначения было ${delta.before.unassigned_count}, станет ${delta.after.unassigned_count}`;
  const distance = `пробег ${delta.before.distance_km} → ${delta.after.distance_km} км`;
  const moves = `переносов ${delta.transfers}`;
  return `${patchLead(patch)}. ${late}; ${open}; ${distance}; ${moves}. Рабочий план не изменён.`;
}

function patchLead(patch: RouterSimulationPatch): string {
  if (patch.policy_id) return `Политика «${POLICY_NAMES[patch.policy_id] ?? 'другая'}»`;
  if (patch.window) return 'Сдвиг окна';
  if (patch.pin) return 'Закрепление заявки за инженером';
  if (patch.unassign_request_id) return 'Снятие назначения';
  if (
    patch.lunches_enabled !== undefined ||
    patch.metro_enabled !== undefined ||
    patch.traffic_enabled !== undefined ||
    patch.equipment_enabled !== undefined ||
    patch.equipment_transfers_enabled !== undefined
  ) {
    return 'Смена технических настроек';
  }
  return 'Проверка изменения';
}

export function toDeltaView(result: RouterSimulation): SimulationDeltaView | null {
  if (!result.delta?.before || !result.delta.after) return null;
  return {
    assigned: result.delta.assigned,
    unassigned: result.delta.unassigned,
    lateAssigned: result.delta.late_assigned,
    totalLatenessSec: result.delta.total_lateness_sec,
    distanceKm: result.delta.distance_km,
    transfers: result.delta.transfers,
    beforeLate: result.delta.before.late_assigned_count,
    afterLate: result.delta.after.late_assigned_count,
    beforeUnassigned: result.delta.before.unassigned_count,
    afterUnassigned: result.delta.after.unassigned_count,
  };
}

/** Writes the Router answer. A repeat of the same key keeps the first row. */
export async function rememberSimulation(
  prisma: PrismaService,
  patch: RouterSimulationPatch,
  result: RouterSimulation,
): Promise<void> {
  const delta = result.delta ?? {};
  await prisma.$executeRaw`
    INSERT INTO plan_simulations (
      id, base_hash, context_version, patch_hash, patch, method, summary, routes, delta, created_at
    ) VALUES (
      ${randomUUID()},
      ${result.input_hash},
      ${result.router_context_version},
      ${result.patch_hash},
      ${JSON.stringify(patch)}::jsonb,
      ${result.method},
      ${JSON.stringify({ routes: result.routes ?? [], strategies: result.strategies ?? [] })}::jsonb,
      ${JSON.stringify(result.routes ?? result.strategies ?? [])}::jsonb,
      ${JSON.stringify(delta)}::jsonb,
      ${BigInt(Math.floor(Date.now() / 1000))}
    )
    ON CONFLICT (base_hash, context_version, patch_hash) DO NOTHING
  `;
}

export async function readSimulation(
  prisma: PrismaService,
  baseHash: string,
  contextVersion: string,
  patchHash: string,
): Promise<RouterSimulation | null> {
  const rows = await prisma.$queryRaw<
    Array<{
      method: string;
      summary: unknown;
      routes: unknown;
      delta: unknown;
      patch_hash: string;
      base_hash: string;
      context_version: string;
    }>
  >`
    SELECT base_hash, context_version, patch_hash, method, summary, routes, delta
    FROM plan_simulations
    WHERE base_hash = ${baseHash}
      AND context_version = ${contextVersion}
      AND patch_hash = ${patchHash}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const summary = asRecord(row.summary);
  const delta = asRecord(row.delta);
  return {
    input_hash: row.base_hash,
    input_publication_id: 'stored',
    router_context_version: row.context_version,
    patch_hash: row.patch_hash,
    method: row.method as RouterSimulation['method'],
    cached: true,
    ...(Object.keys(delta).length > 0 ? { delta: delta as RouterSimulation['delta'] } : {}),
    routes: Array.isArray(summary.routes) ? (summary.routes as RouterSimulation['routes']) : [],
    strategies: Array.isArray(summary.strategies)
      ? (summary.strategies as RouterSimulation['strategies'])
      : undefined,
  };
}

/** Numbers already in the store. Never starts a solve. */
export async function storedGuardLine(
  prisma: PrismaService,
  baseHash: string,
  contextVersion: string,
  action: string,
): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ patch: unknown; delta: unknown }>>`
    SELECT patch, delta
    FROM plan_simulations
    WHERE base_hash = ${baseHash} AND context_version = ${contextVersion}
    ORDER BY created_at DESC
    LIMIT 8
  `;
  for (const row of rows) {
    const patch = asRecord(row.patch);
    const delta = asRecord(row.delta);
    const before = asRecord(delta.before);
    const after = asRecord(delta.after);
    if (!matchesAction(action, patch)) continue;
    if (typeof before.late_assigned_count !== 'number' || typeof after.late_assigned_count !== 'number') {
      continue;
    }
    return `опозданий было ${before.late_assigned_count}, станет ${after.late_assigned_count}`;
  }
  return '';
}

function matchesAction(action: string, patch: Record<string, unknown>): boolean {
  if (action === 'policy.select') return typeof patch.policy_id === 'string';
  if (action === 'move_window' || action === 'request.update') return patch.window !== undefined;
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}
