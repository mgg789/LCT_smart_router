import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { canonicalHash } from '../../common/json';
import { Clock } from '../../common/time';
import { zonedDayEnd } from '../../common/time/zone';
import { UnitOfWork } from '../../persistence';
import { SnapshotBuilder } from '../../routing/mount-data-eng';
import { RouterClient } from '../../routing/router-gateway/router-client.port';
import { businessNow } from '../live/business-clock';

type PreparedWindow = {
  requestVersion: number;
  input: Parameters<RouterClient['proposeWindow']>[0];
  identity: string;
};

/** Builds the immutable request for a window preview while holding no DB lock during Router I/O. */
@Injectable()
export class AlertWindowQuery {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly builder: SnapshotBuilder,
  ) {}

  /** Reads the alert, planning snapshot and current route context in one short transaction. */
  async prepare(id: string, planningAt?: number): Promise<PreparedWindow> {
    return this.uow.run(async (tx) => {
      const alert = await tx.alert.findUnique({ where: { id } });
      if (!alert || alert.resolvedAt !== null || !alert.requestIds[0]) {
        throw new SysError('VALIDATION_FAILED', 'An open request alert is required');
      }
      const request = await tx.request.findUnique({ where: { id: alert.requestIds[0] } });
      if (request?.workCategory === 'emergency')
        throw SysError.validationFailed(
          'Авария планируется с поступления: вместо переноса окна нужен подходящий свободный инженер.',
        );
      if (request?.lifecycle !== 'submitted')
        throw new SysError('WORK_ALREADY_STARTED', 'Only submitted work can change windows');
      const now = planningAt ?? (await businessNow(tx, this.clock.nowSeconds()));
      const built = await this.builder.build(tx, now);
      const current = await tx.appliedPlanCurrent.findUnique({
        where: { id: 'singleton' },
        include: {
          plan: { include: { routes: { include: { stops: { orderBy: { sequence: 'asc' } } } } } },
        },
      });
      const ids = new Set(built.snapshot.requests.map((item) => item.request_id));
      if (!ids.has(request.id))
        throw new SysError('VALIDATION_FAILED', 'Request is outside the current planning horizon');
      const engineers = new Set(built.snapshot.engineers.map((item) => item.engineer_id));
      const routes = Object.fromEntries(
        (current?.plan.routes ?? [])
          .filter((route) => engineers.has(route.engineerId))
          .map((route) => [
            route.engineerId,
            route.stops.flatMap((stop) =>
              stop.requestId && ids.has(stop.requestId) ? [stop.requestId] : [],
            ),
          ]),
      );
      return {
        requestVersion: request.version,
        input: {
          snapshot: built.snapshot,
          request_id: request.id,
          routes,
          day_end_at: zonedDayEnd(now),
        },
        identity: canonicalHash({
          task: built.taskFingerprint,
          plan: current?.planId ?? null,
          version: request.version,
        }),
      };
    });
  }
}
