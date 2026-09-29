import { Injectable } from '@nestjs/common';
import { canonicalHash } from '../../common/json';
import { Clock } from '../../common/time';
import { type Tx, UnitOfWork } from '../../persistence';
import {
  PUBLICATION_TRIGGERS,
  SnapshotBuilder,
  SnapshotPublisher,
} from '../../routing/mount-data-eng';
import { AppliedPlanService } from '../../routing/router-gateway';
import {
  type LogisticsProposalInput,
  RouterClient,
} from '../../routing/router-gateway/router-client.port';
import { NotificationsService } from '../../notifications';
import { LiveDayState } from '../live/live-day-state';

/** Durable search queue: network previews run between two short, fenced transactions. */
@Injectable()
export class EquipmentLogisticsService {
  private inFlight: Promise<void> | null = null;
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly snapshots: SnapshotBuilder,
    private readonly router: RouterClient,
    private readonly plans: AppliedPlanService,
    private readonly publisher: SnapshotPublisher,
    private readonly days: LiveDayState,
    private readonly notifications: NotificationsService,
  ) {}

  /** Polls persisted attempts; process restarts and concurrent callers are harmless. */
  runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const pending = this.process().finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }

  private async process(): Promise<void> {
    const wallNow = this.clock.nowSeconds();
    await this.uow.run(async (tx) => {
      const pending = await tx.equipmentLogistics.findMany({ where: { status: 'assigned' } });
      for (const row of pending) {
        const request = await tx.request.findUnique({
          where: { id: row.requestId },
          select: { lifecycle: true },
        });
        if (request && !['completed', 'cancelled'].includes(request.lifecycle)) continue;
        await tx.equipmentLogistics.update({
          where: { id: row.id },
          data: { status: 'cancelled', updatedAt: BigInt(wallNow) },
        });
        const day = await tx.liveWorkday.findFirst({
          where: { workDate: row.workDate, status: 'running' },
        });
        if (day)
          await this.publisher.publishIfChanged(
            tx,
            this.days.liveNow(day, wallNow),
            PUBLICATION_TRIGGERS.REQUEST_CANCELLED,
            { businessTime: true },
          );
      }
    });
    const rows = await this.uow.observe((tx) =>
      tx.equipmentLogistics.findMany({
        where: {
          status: { in: ['searching', 'error'] },
          OR: [{ retryAt: null }, { retryAt: { lte: BigInt(wallNow) } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 1,
      }),
    );
    for (const row of rows) {
      try {
        const settings = await this.router.getTechnicalSettings();
        if (!settings.equipmentTransfersEnabled) {
          await this.uow.run((tx) =>
            tx.equipmentLogistics.updateMany({
              where: { id: row.id, status: { in: ['searching', 'error'] } },
              data: { status: 'cancelled', retryAt: null, updatedAt: BigInt(wallNow) },
            }),
          );
          continue;
        }
        const capture = await this.uow.run((tx) => this.capture(tx, row.id));
        if (!capture) continue;
        const input: LogisticsProposalInput = {
          ...capture.input,
          expected_context_version: settings.routerContextVersion,
        };
        const witness = await this.router.proposeLogistics(input);
        if (
          witness.router_context_version !== settings.routerContextVersion ||
          (await this.router.getActiveContextVersion()) !== settings.routerContextVersion
        )
          throw new Error('Equipment context changed');
        await this.uow.run(async (tx) => {
          const fresh = await this.capture(tx, row.id, capture.input.snapshot.planning_as_of);
          if (!fresh || fresh.fingerprint !== capture.fingerprint) return;
          const now = this.days.liveNow(fresh.day, this.clock.nowSeconds());
          if (witness.status === 'none') {
            const current = fresh.request;
            await tx.request.update({
              where: { id: row.requestId },
              data: {
                lifecycle: 'cancelled',
                assignmentState: 'unassigned',
                cancelledAt: BigInt(now),
                updatedAt: BigInt(now),
                version: { increment: 1 },
              },
            });
            await tx.requestConditionHistory.create({
              data: {
                requestId: row.requestId,
                changedAt: BigInt(now),
                previous: {
                  windowStartAt: Number(current.windowStartAt),
                  windowEndAt: Number(current.windowEndAt),
                  priority: current.priority,
                  requiredEquipment: current.requiredEquipment,
                  version: current.version,
                },
                reason: 'не найдено оборудование',
              },
            });
            await this.notifications.record(tx, now, {
              category: 'request_cancelled',
              businessEventKey: `request_cancelled:${row.requestId}`,
              recipientAccountId: current.clientAccountId,
              payload: { requestId: row.requestId, reason: 'не найдено оборудование' },
            });
            await tx.alert.create({
              data: {
                dedupKey: `equipment:none:${row.workDate}:${row.requestId}`,
                kind: 'notice',
                code: 'EQUIPMENT_LOGISTICS_NONE',
                severity: 'warning',
                engineerIds: [row.receiverEngineerId],
                requestIds: [row.requestId],
                reasons: [
                  {
                    code: 'EQUIPMENT_LOGISTICS_NONE',
                    text: 'Заявка отменена: не найдено оборудование для доставки.',
                    facts: { requestId: row.requestId },
                  },
                ],
                workDate: row.workDate,
                isBlocking: false,
                createdAt: BigInt(now),
              },
            });
            await tx.liveEngineerState.updateMany({
              where: { workdayId: fresh.day.id, engineerId: row.receiverEngineerId },
              data: {
                routeAnchorRequestId: row.requestId,
                routeAnchorReachedAt: BigInt(now),
                routeAnchorDepartedAt: BigInt(now),
                updatedAt: BigInt(wallNow),
                version: { increment: 1 },
              },
            });
            await tx.equipmentLogistics.update({
              where: { id: row.id },
              data: {
                status: 'none',
                failureCode: 'NO_FEASIBLE_LOGISTICS',
                retryAt: null,
                updatedAt: BigInt(wallNow),
              },
            });
            await this.publisher.publishIfChanged(tx, now, PUBLICATION_TRIGGERS.REQUEST_CANCELLED, {
              businessTime: true,
            });
            return;
          }
          const proposal = witness.proposal;
          if (
            !proposal ||
            proposal.at < now ||
            proposal.location.lat !== row.lat ||
            proposal.location.lon !== row.lon ||
            !fresh.input.snapshot.engineers.some(
              (engineer) => engineer.engineer_id === proposal.donor_engineer_id,
            )
          )
            return;
          const expectedAt = BigInt(proposal.at);
          await this.plans.insertDelivery(tx, now, fresh.revision, {
            ...row,
            donorEngineerId: proposal.donor_engineer_id,
            expectedAt,
            travelDeltaSec: proposal.travel_delta_sec,
            distanceDeltaM: proposal.distance_delta_m,
            waitDeltaSec: proposal.wait_delta_sec,
            occupiedFrom: proposal.occupied_from_at,
            occupiedUntil: proposal.occupied_until_at,
          });
          const wait = Math.max(0, proposal.at - Number(row.waitStartedAt ?? BigInt(now)));
          const expected =
            Number(row.baselineCompletionAt ?? fresh.request.expectedCompletionAt ?? BigInt(now)) +
            wait;
          const duration = Math.max(
            fresh.request.serviceDurationSec,
            expected - Number(fresh.request.startedAt),
          );
          await tx.request.update({
            where: { id: row.requestId },
            data: {
              expectedCompletionAt: BigInt(expected),
              continuationAvailableAt: BigInt(expected),
              serviceDurationSec: duration,
              technicalDurationSec: duration - fresh.request.documentationDurationSec,
              updatedAt: BigInt(now),
              version: { increment: 1 },
            },
          });
          await tx.equipmentLogistics.update({
            where: { id: row.id },
            data: {
              status: 'assigned',
              donorEngineerId: proposal.donor_engineer_id,
              expectedAt,
              failureCode: null,
              retryAt: null,
              updatedAt: BigInt(wallNow),
            },
          });
        });
      } catch {
        // Failure is not an infeasibility witness. Keep the active visit and retry durably.
        await this.uow.run((tx) =>
          tx.equipmentLogistics.updateMany({
            where: { id: row.id, status: { in: ['searching', 'error'] } },
            data: {
              status: 'error',
              failureCode: 'ROUTER_UNAVAILABLE',
              retryAt: BigInt(wallNow + 5),
              updatedAt: BigInt(wallNow),
            },
          }),
        );
      }
    }
  }

  private async capture(tx: Tx, id: string, planningAsOf?: number) {
    const row = await tx.equipmentLogistics.findUnique({ where: { id } });
    if (!row || !['searching', 'error'].includes(row.status)) return null;
    const day = await tx.liveWorkday.findFirst({
      where: { workDate: row.workDate, status: 'running' },
      orderBy: { createdAt: 'desc' },
    });
    const request = await tx.request.findUnique({ where: { id: row.requestId } });
    if (!day || request?.lifecycle !== 'in_progress' || request.startedAt === null) {
      await tx.equipmentLogistics.update({
        where: { id },
        data: { status: 'cancelled', updatedAt: BigInt(this.clock.nowSeconds()) },
      });
      return null;
    }
    const now = planningAsOf ?? this.days.liveNow(day, this.clock.nowSeconds());
    const current = await this.plans.current(tx);
    if (!current) throw new Error('No applied route for equipment delivery');
    const built = await this.snapshots.build(tx, now);
    const online = new Set(
      (
        await tx.liveEngineerState.findMany({ where: { workdayId: day.id, lineStatus: 'online' } })
      ).map((item) => item.engineerId),
    );
    const snapshot = {
      ...built.snapshot,
      engineers: built.snapshot.engineers.filter((item) => online.has(item.engineer_id)),
    };
    if (!snapshot.engineers.some((item) => item.engineer_id === row.receiverEngineerId))
      throw new Error('Receiver is not online');
    snapshot.requests = [
      ...snapshot.requests.filter((item) => item.request_id !== row.requestId),
      {
        request_id: row.requestId,
        region: request.region,
        arrival_order: Math.max(0, ...snapshot.requests.map((item) => item.arrival_order)) + 1,
        location: { lat: row.lat, lon: row.lon },
        service_duration_sec: request.serviceDurationSec,
        window_start_at: Number(request.windowStartAt),
        window_end_at: Number(request.windowEndAt),
        priority: request.priority,
        required_skill: request.requiredSkill,
        required_transport: request.requiredTransport,
        required_equipment: row.equipmentType,
      },
    ];
    const routes = Object.fromEntries(
      current.routes.map((route) => [
        route.engineerId,
        route.stops.map((stop) => ({
          kind: stop.kind,
          request_id: stop.requestId,
          lat: stop.lat,
          lon: stop.lon,
          start_at: Number(stop.startAt),
          end_at: Number(stop.endAt),
        })),
      ]),
    );
    const input = {
      snapshot,
      request_id: row.requestId,
      receiver_engineer_id: row.receiverEngineerId,
      routes,
      depots: [],
    };
    const mutations = await tx.operation.findMany({
      where: { action: { in: ['router.technical-settings.replace', 'router.road_import'] } },
      select: { operationId: true, state: true },
      orderBy: { operationId: 'asc' },
    });
    if (mutations.some((operation) => operation.state === 'outcome_unknown'))
      throw new Error('Router context mutation is pending');
    return {
      input,
      day,
      request,
      revision: current.revision,
      fingerprint: canonicalHash({
        input,
        mutations,
        requestVersion: request.version,
        revision: current.revision,
        ledger: row.updatedAt.toString(),
      }),
    };
  }
}
