import { Injectable } from '@nestjs/common';
import type { PlanView } from '../../api/plan-view';
import { PrismaService, type Tx } from '../../persistence';
import { RouterClient } from '../../routing/router-gateway/router-client.port';
import { workDateOf } from '../engineers/workday';
import { DispatcherSettingsService } from './dispatcher-settings.service';
import { type ForecastRequest, forecastMovements, projectMapForecast } from './map-plan-forecast';
import { type MapQuote, MapRoutingClient } from './map-routing-client';

export type { MapProvider, MapProviderStatus, MapRoute } from './map-routing-client';

/** Shared fixed-order ETA observations. No write to assignments, stored plans or execution facts. */
@Injectable()
export class MapRoutingService {
  private readonly client = new MapRoutingClient();
  private trafficEnabled = true;
  private trafficCheckedAt = 0;
  private trafficRead: Promise<void> | null = null;

  constructor(
    private readonly settings: DispatcherSettingsService,
    private readonly prisma: PrismaService,
    private readonly router: RouterClient,
  ) {}

  /** Warm provider observations outside DB transactions, then project coherent route times. */
  async enrichPlan(plan: PlanView, trafficEnabled?: boolean): Promise<PlanView> {
    if (trafficEnabled !== undefined) {
      this.trafficEnabled = trafficEnabled;
      this.trafficCheckedAt = Date.now();
    }
    return this.project(plan, this.prisma, true);
  }

  /** LIVE may use these forecasts under its row lock; this path never performs network I/O. */
  async cachedPlan(plan: PlanView, tx: Tx): Promise<PlanView> {
    return this.project(plan, tx, false);
  }

  /** Observed health only: reading diagnostics consumes zero billable requests. */
  async probe() {
    const settings = await this.settings.read();
    const twogis = this.client.status('twogis', settings.twogisApiKey);
    const yandex = this.client.status('yandex', settings.yandexApiKey);
    const active = twogis.ok
      ? ('twogis' as const)
      : yandex.ok
        ? ('yandex' as const)
        : ('none' as const);
    return { active, twogis, yandex };
  }

  private async project(
    plan: PlanView,
    db: PrismaService | Tx,
    refresh: boolean,
  ): Promise<PlanView> {
    const keys = await this.settings.read(db);
    if (!keys.twogisApiKey && !keys.yandexApiKey) return plan;
    if (refresh) await this.refreshTrafficPolicy();
    const traffic = this.trafficEnabled;
    const ids = plan.routes.flatMap((route) =>
      route.stops.flatMap((stop) => (stop.requestId ? [stop.requestId] : [])),
    );
    // This also runs on one transactional connection during LIVE, so reads are ordered.
    const rows = await db.request.findMany({
      where: { id: { in: ids } },
      include: {
        liveStates: { where: { workday: { status: 'running' } } },
      },
    });
    const engineers = await db.engineer.findMany({
      where: { id: { in: plan.routes.map((route) => route.engineerId) } },
    });
    const days = await db.engineerDay.findMany({
      where: {
        engineerId: { in: plan.routes.map((route) => route.engineerId) },
        workDate: workDateOf(plan.planAsOf, 'Europe/Moscow'),
      },
    });
    const requests = new Map<string, ForecastRequest>(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          windowStartAt: Number(row.windowStartAt),
          windowEndAt: Number(row.windowEndAt),
          serviceDurationSec: row.serviceDurationSec,
          lifecycle: row.lifecycle,
          startedAt: seconds(row.startedAt),
          completedAt: seconds(row.completedAt),
          expectedCompletionAt: seconds(row.expectedCompletionAt),
          assumedCompleted: row.liveStates.some((state) => state.assumedCompletedAt !== null),
          pinnedStartAt: seconds(
            row.liveStates[0]?.reportedEtaAt ?? row.liveStates[0]?.assumedStartedAt ?? null,
          ),
        },
      ]),
    );
    const profiles = new Map(engineers.map((engineer) => [engineer.id, engineer.transportType]));
    const routes = await Promise.all(
      plan.routes.map(async (route) => {
        const transport = profiles.get(route.engineerId);
        if (!transport) return route;
        const quotes = await Promise.all(
          forecastMovements(route, requests).map(async (movement): Promise<MapQuote> => {
            if (movement.protected) return { route: null, failure: null };
            // Pass coordinate-only objects: stop metadata must never affect cache identity.
            const from = { lat: movement.from.lat, lon: movement.from.lon };
            const to = { lat: movement.to.lat, lon: movement.to.lon };
            if (from.lat === to.lat && from.lon === to.lon) return { route: null, failure: null };
            return refresh
              ? this.client.quote(from, to, traffic, transport, keys)
              : this.client.peek(from, to, traffic, transport, keys);
          }),
        );
        return projectMapForecast(
          route,
          requests,
          quotes,
          transport,
          plan.planAsOf,
          seconds(days.find((day) => day.engineerId === route.engineerId)?.shiftEndAt ?? null),
        );
      }),
    );
    return { ...plan, routes };
  }

  private async refreshTrafficPolicy(): Promise<void> {
    if (!this.router.isConfigured() || Date.now() - this.trafficCheckedAt < 5000) return;
    if (this.trafficRead) return this.trafficRead;
    const previous = this.trafficCheckedAt;
    this.trafficRead = this.router
      .getTechnicalSettings()
      .then((settings) => {
        if (this.trafficCheckedAt === previous)
          this.trafficEnabled = settings.trafficEnabled ?? true;
      })
      .catch(() => {
        /* Retain the last policy during Router outage; map observations remain usable. */
      })
      .finally(() => {
        this.trafficCheckedAt = Date.now();
        this.trafficRead = null;
      });
    return this.trafficRead;
  }
}

function seconds(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
