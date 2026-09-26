import type { PrismaService } from '../../persistence';
import type {
  RouterClient,
  RouterSimulation,
  RouterSimulationPatch,
  RouterTechnicalSettings,
  SimulationCounts,
} from '../../routing/router-gateway';
import { rememberSimulation, simulationPatchHash } from '../simulator/simulation-store';

const POLICY_TITLE: Record<string, string> = {
  fast: 'Быстрее',
  compact: 'Дешевле',
  sla: 'По окнам',
  balanced: 'Ровнее загрузка',
  eco: 'Короче пробег',
  covering: 'Полное покрытие',
  baseline: 'FIFO',
};

const SELECTABLE = ['fast', 'compact', 'sla', 'balanced', 'eco', 'covering'] as const;

export interface OptimizeLever {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly kind: 'policy' | 'settings' | 'engineer';
  readonly policyId?: string;
  readonly settings?: Partial<
    Pick<
      RouterTechnicalSettings,
      'lunchesEnabled' | 'metroEnabled' | 'trafficEnabled' | 'equipmentEnabled'
    >
  >;
  readonly engineerId?: string;
}

/**
 * True when the unassigned count or lateness falls and neither rises.
 * Equal service numbers can still improve on distance.
 */
export function countsImprove(before: SimulationCounts, after: SimulationCounts): boolean {
  if (after.unassigned_count > before.unassigned_count) return false;
  if (after.late_assigned_count > before.late_assigned_count) return false;
  if (after.unassigned_count < before.unassigned_count) return true;
  if (after.late_assigned_count < before.late_assigned_count) return true;
  return after.distance_km + 0.05 < before.distance_km;
}

/** One Russian line of assigned, open, late and distance. */
export function describeCounts(before: SimulationCounts, after: SimulationCounts): string {
  const base =
    `назначено ${before.assigned_count}→${after.assigned_count}, ` +
    `без назначения ${before.unassigned_count}→${after.unassigned_count}, ` +
    `опоздания ${before.late_assigned_count}→${after.late_assigned_count}, ` +
    `пробег ${before.distance_km}→${after.distance_km} км`;
  if (before.engineers_used === undefined || after.engineers_used === undefined) return base;
  const extraBefore = before.additional_engineers ?? 0;
  const extraAfter = after.additional_engineers ?? 0;
  return (
    `${base}, инженеров в работе ${before.engineers_used}→${after.engineers_used}, ` +
    `дополнительных экипажей ${extraBefore}→${extraAfter} (резерв covering, не люди со смены)`
  );
}

/**
 * Catalog deltas against the current policy, including rows that do not improve.
 * `choosePolicy` and the optimize button share this wording.
 */
export function catalogDeltaLines(
  currentPolicyId: string,
  strategies: ReadonlyArray<{ strategy_id: string; metrics: SimulationCounts }>,
): string[] {
  const current =
    strategies.find((row) => row.strategy_id === currentPolicyId) ??
    strategies.find((row) => row.strategy_id === 'baseline');
  if (!current) return [];
  return strategies
    .filter(
      (row) =>
        row.strategy_id !== current.strategy_id &&
        (SELECTABLE as readonly string[]).includes(row.strategy_id),
    )
    .map((row) => {
      const title = POLICY_TITLE[row.strategy_id] ?? row.strategy_id;
      return `Политика «${title}»: ${describeCounts(current.metrics, row.metrics)}`;
    });
}

/**
 * Runs the catalog once, then one bounded solve per toggle that would change,
 * then one bring-online copy. Only improving levers are returned.
 * Every successful solve is stored so the action guard can read the delta.
 */
export async function collectOptimizeLevers(input: {
  readonly router: RouterClient;
  readonly prisma: PrismaService;
  readonly currentPolicyId: string;
}): Promise<OptimizeLever[]> {
  const levers: OptimizeLever[] = [];
  const catalog = await safeSimulate(input.router, { catalog: true });
  if (catalog?.strategies) {
    const current =
      catalog.strategies.find((row) => row.strategy_id === input.currentPolicyId) ??
      catalog.strategies.find((row) => row.strategy_id === 'baseline');
    if (current) {
      for (const row of catalog.strategies) {
        if (!(SELECTABLE as readonly string[]).includes(row.strategy_id)) continue;
        if (row.strategy_id === current.strategy_id) continue;
        const patch: RouterSimulationPatch = { policy_id: row.strategy_id };
        await rememberSimulation(input.prisma, patch, {
          ...catalog,
          patch_hash: simulationPatchHash(patch),
          delta: deltaFromCounts(current.metrics, row.metrics),
        });
        if (!countsImprove(current.metrics, row.metrics)) continue;
        const title = POLICY_TITLE[row.strategy_id] ?? row.strategy_id;
        levers.push({
          id: `policy:${row.strategy_id}`,
          label: `Политика: ${title}`,
          detail: describeCounts(current.metrics, row.metrics),
          kind: 'policy',
          policyId: row.strategy_id,
        });
      }
    }
  }

  const settings = await input.router.getTechnicalSettings().catch(() => null);
  if (settings) {
    const toggles: ReadonlyArray<{
      id: string;
      labelOn: string;
      labelOff: string;
      current: boolean | undefined;
      patch: RouterSimulationPatch;
      settings: OptimizeLever['settings'];
    }> = [
      {
        id: 'lunchesEnabled',
        labelOn: 'Обеды: включить',
        labelOff: 'Обеды: выключить',
        current: settings.lunchesEnabled,
        patch: { lunches_enabled: !settings.lunchesEnabled },
        settings: { lunchesEnabled: !settings.lunchesEnabled },
      },
      {
        id: 'metroEnabled',
        labelOn: 'Метро: включить',
        labelOff: 'Метро: выключить',
        current: settings.metroEnabled,
        patch: { metro_enabled: !(settings.metroEnabled ?? false) },
        settings: { metroEnabled: !(settings.metroEnabled ?? false) },
      },
      {
        id: 'trafficEnabled',
        labelOn: 'Пробки: включить',
        labelOff: 'Пробки: выключить',
        current: settings.trafficEnabled,
        patch: { traffic_enabled: !(settings.trafficEnabled ?? false) },
        settings: { trafficEnabled: !(settings.trafficEnabled ?? false) },
      },
      {
        id: 'equipmentEnabled',
        labelOn: 'Проверка оборудования: включить',
        labelOff: 'Проверка оборудования: выключить',
        current: settings.equipmentEnabled,
        patch: { equipment_enabled: !(settings.equipmentEnabled ?? false) },
        settings: { equipmentEnabled: !(settings.equipmentEnabled ?? false) },
      },
    ];
    for (const toggle of toggles) {
      const result = await safeSimulate(input.router, toggle.patch);
      if (!result?.delta?.before || !result.delta.after) continue;
      await rememberSimulation(input.prisma, toggle.patch, result);
      if (!countsImprove(result.delta.before, result.delta.after)) continue;
      const turningOn = toggle.current === false || toggle.current === undefined;
      levers.push({
        id: `setting:${toggle.id}`,
        label: turningOn ? toggle.labelOn : toggle.labelOff,
        detail: describeCounts(result.delta.before, result.delta.after),
        kind: 'settings',
        settings: toggle.settings,
      });
    }
  }

  const engineer = await suitableOfflineEngineer(input.prisma);
  if (engineer) {
    const patch: RouterSimulationPatch = { bring_online_engineer_id: engineer.id };
    const result = await safeSimulate(input.router, patch);
    if (result?.delta?.before && result.delta.after) {
      await rememberSimulation(input.prisma, patch, result);
      if (countsImprove(result.delta.before, result.delta.after)) {
        levers.push({
          id: `engineer:${engineer.id}`,
          label: `Вызвать инженера: ${engineer.name}`,
          detail: describeCounts(result.delta.before, result.delta.after),
          kind: 'engineer',
          engineerId: engineer.id,
        });
      }
    }
  }
  return levers;
}

function deltaFromCounts(before: SimulationCounts, after: SimulationCounts): NonNullable<RouterSimulation['delta']> {
  return {
    assigned: after.assigned_count - before.assigned_count,
    unassigned: after.unassigned_count - before.unassigned_count,
    late_assigned: after.late_assigned_count - before.late_assigned_count,
    total_lateness_sec: after.total_lateness_sec - before.total_lateness_sec,
    distance_km: Math.round((after.distance_km - before.distance_km) * 1000) / 1000,
    transfers: 0,
    before,
    after,
  };
}

async function safeSimulate(
  router: RouterClient,
  patch: RouterSimulationPatch,
): Promise<RouterSimulation | null> {
  try {
    return await router.simulate(patch);
  } catch {
    return null;
  }
}

/**
 * One offline engineer who matches an open request by skill and region.
 * The live roster is not changed here.
 */
async function suitableOfflineEngineer(
  prisma: PrismaService,
): Promise<{ id: string; name: string } | null> {
  const day = await prisma.liveWorkday.findFirst({
    where: { status: 'running' },
    select: { workDate: true },
  });
  if (!day) return null;
  const [open, offline] = await Promise.all([
    prisma.request.findMany({
      where: { lifecycle: 'submitted', assignmentState: { in: ['unassigned', 'pending'] } },
      select: { requiredSkill: true, region: true },
      take: 80,
    }),
    prisma.engineerDay.findMany({
      where: { workDate: day.workDate, availability: 'offline' },
      include: { engineer: true },
    }),
  ]);
  const ranked = offline
    .flatMap((row) => {
      if (row.engineer.archivedAt !== null) return [];
      const score = open.filter(
        (request) =>
          row.engineer.skills.includes(request.requiredSkill) &&
          (!request.region || row.engineer.region === request.region),
      ).length;
      if (score === 0) return [];
      return [{ id: row.engineerId, name: row.engineer.displayName, score }];
    })
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, 'ru'));
  const best = ranked[0];
  return best ? { id: best.id, name: best.name } : null;
}
