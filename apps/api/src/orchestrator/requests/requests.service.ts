import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { EquipmentType, Priority, Prisma, Request } from '../../generated/prisma/client';
import { NotificationsService } from '../../notifications';
import { assertWriteApplied, type OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { nearestRegion, regionCenters, type RegionPoint } from './region-geocenter';
import { findWorkType } from './work-type.catalog';

export interface PrepareRequestInput {
  readonly contactName: string | null;
  readonly addressText: string;
  readonly lat?: number | null;
  readonly lon?: number | null;
  readonly workType: string;
  readonly requiredEquipment?: EquipmentType | null;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly urgent: boolean;
  readonly problemText?: string | null;
}

export interface RescheduleInput {
  readonly windowStartAt: number;
  readonly windowEndAt: number;
}

export interface DispatcherUpdateInput {
  readonly windowStartAt?: number;
  readonly windowEndAt?: number;
  readonly addressText?: string;
  readonly lat?: number | null;
  readonly lon?: number | null;
  readonly urgent?: boolean;
  readonly requiredEquipment?: EquipmentType | null;
}

/**
 * Lifecycle of a request.
 *
 * Three things are kept apart on purpose and never collapsed into one status
 * (context/36 section 3):
 *   * `lifecycle` -- the business stage;
 *   * `assignmentState` -- the outcome of distribution, owned by an accepted plan;
 *   * facts in `request_facts` -- what an engineer actually confirmed.
 *
 * `pending` means "waiting for a current result". It is not a refusal, and an ongoing
 * calculation or a Router error must never turn it into `unassigned` with an invented
 * reason (context/36 section 3).
 */
@Injectable()
export class RequestsService {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly publisher: SnapshotPublisher,
  ) {}

  /**
   * Prepares a request from what the customer described.
   *
   * A draft is not yet a task for anyone: it is not in the free pool, it produces no mail
   * and it is not published. Only an explicit confirmation makes it real
   * (context/42 DF-04).
   */
  async prepare(
    context: OperationContext,
    clientAccountId: string | null,
    input: PrepareRequestInput,
  ): Promise<Request> {
    const spec = findWorkType(input.workType);
    if (!spec) {
      throw new SysError('VALIDATION_FAILED', 'Unknown type of work', {
        details: { workType: input.workType },
      });
    }
    assertWindow(input.windowStartAt, input.windowEndAt);

    const lat = input.lat ?? null;
    const lon = input.lon ?? null;
    const hasPoint = typeof lat === 'number' && typeof lon === 'number';
    const region = hasPoint ? await resolveRegion(context.tx, { lat, lon }) : null;

    return context.tx.request.create({
      data: {
        clientAccountId,
        // Assigned on submission, when the request actually arrives in the system.
        arrivalOrder: 0,
        contactName: input.contactName,
        addressText: input.addressText,
        region,
        lat,
        lon,
        // A request without a point is excluded from the published snapshot with a
        // counted diagnostic rather than given invented coordinates.
        needsGeocoding: !hasPoint,
        problemText: input.problemText ?? null,
        workTypeHd: spec.code,
        // Derived by rule from the type of work; the customer never types these
        // (context/32 section 4.1).
        requiredSkill: spec.skill,
        normProfileCode: spec.normProfileCode,
        normativeTravelDurationSec: spec.normativeTravelDurationSec,
        technicalDurationSec: spec.technicalDurationSec,
        documentationDurationSec: spec.documentationDurationSec,
        serviceDurationSec: spec.serviceDurationSec,
        requiredTransport: null,
        requiredEquipment:
          input.requiredEquipment === undefined
            ? defaultEquipment(spec.code)
            : input.requiredEquipment,
        priority: resolvePriority(spec.priority, input.urgent),
        windowStartAt: BigInt(input.windowStartAt),
        windowEndAt: BigInt(input.windowEndAt),
        lifecycle: 'draft',
        assignmentState: 'pending',
        origin: 'system_rule',
        createdAt: BigInt(context.now),
        updatedAt: BigInt(context.now),
      },
    });
  }

  /**
   * Confirms the prepared content and lets the request into distribution.
   *
   * Confirming twice does not produce a second `request_id` or a second mail event: the
   * operation envelope stops the replay, and this method is written so that even a
   * direct second call finds the request already submitted (context/36 section 13).
   */
  async submit(
    context: OperationContext,
    requestId: string,
    expectedVersion: number | null | undefined,
  ): Promise<Request> {
    const current = await this.loadOwned(context.tx, requestId);

    if (current.lifecycle !== 'draft') {
      if (current.lifecycle === 'submitted') {
        return current;
      }
      throw new SysError('VALIDATION_FAILED', 'This request can no longer be submitted', {
        details: { lifecycle: current.lifecycle },
      });
    }

    const arrivalOrder = await nextArrivalOrder(context.tx);
    const updated = await context.tx.request.updateMany({
      where: { id: requestId, version: expectedVersion ?? current.version },
      data: {
        lifecycle: 'submitted',
        assignmentState: 'pending',
        arrivalOrder,
        submittedAt: BigInt(context.now),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    assertWriteApplied('Request', updated.count, expectedVersion, current.version);

    // The mail says the request was received. It promises no engineer: the assignment is
    // a separate business transition with its own letter (context/36 section 10).
    await this.notifications.record(context.tx, context.now, {
      category: 'request_received',
      businessEventKey: `request_received:${requestId}`,
      recipientAccountId: current.clientAccountId,
      payload: { requestId },
    });

    // A confirmed request is new work to distribute, so the task changed and is
    // republished in the same transaction (context/42 DF-10).
    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.REQUEST_SUBMITTED,
    );

    return this.reload(context.tx, requestId);
  }

  /**
   * Immediate reschedule (SL3).
   *
   * After the button, the new date and window are the only live conditions of the same
   * request. There is no second active visit and no "old window kept until the new one is
   * confirmed": the previous conditions go to history, which is a journal and not a second
   * promise to the customer (context/36 section 4).
   */
  async reschedule(
    context: OperationContext,
    requestId: string,
    expectedVersion: number | null | undefined,
    input: RescheduleInput,
  ): Promise<Request> {
    assertWindow(input.windowStartAt, input.windowEndAt);
    const current = await this.loadOwned(context.tx, requestId);
    assertChangeable(current);

    await this.archiveConditions(context, current);

    const updated = await context.tx.request.updateMany({
      where: { id: requestId, version: expectedVersion ?? current.version },
      data: {
        windowStartAt: BigInt(input.windowStartAt),
        windowEndAt: BigInt(input.windowEndAt),
        windowOrigin: 'explicit',
        // The previous assignment does not confirm the new conditions, so the outcome
        // returns to pending and waits for a current result (context/36 section 3).
        assignmentState: 'pending',
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    assertWriteApplied('Request', updated.count, expectedVersion, current.version);

    // The customer moved the window themselves, so the letter confirms the new time rather
    // than asking to pick one. One letter per proposed window: repeating the same change
    // stays a no-op, moving to another window confirms again (context/36 section 10).
    await this.notifications.record(context.tx, context.now, {
      category: 'request_rescheduled',
      businessEventKey: `request_rescheduled:${requestId}:${input.windowStartAt}:${input.windowEndAt}`,
      recipientAccountId: current.clientAccountId,
      payload: {
        requestId,
        windowStartAt: input.windowStartAt,
        windowEndAt: input.windowEndAt,
      },
    });

    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.REQUEST_CONDITIONS_CHANGED,
    );

    return this.reload(context.tx, requestId);
  }

  /** Dispatcher edits to the conditions of a request that has not started. */
  async updateConditions(
    context: OperationContext,
    requestId: string,
    expectedVersion: number | null | undefined,
    input: DispatcherUpdateInput,
  ): Promise<Request> {
    const current = await this.loadOwned(context.tx, requestId);
    assertChangeable(current);

    const windowStartAt = input.windowStartAt ?? Number(current.windowStartAt);
    const windowEndAt = input.windowEndAt ?? Number(current.windowEndAt);
    assertWindow(windowStartAt, windowEndAt);

    await this.archiveConditions(context, current);

    const movingPoint = input.lat !== undefined || input.lon !== undefined;
    const lat = input.lat === undefined ? current.lat : input.lat;
    const lon = input.lon === undefined ? current.lon : input.lon;
    const region =
      typeof lat === 'number' && typeof lon === 'number'
        ? await resolveRegion(context.tx, { lat, lon }, current.id)
        : current.region;

    const updated = await context.tx.request.updateMany({
      where: { id: requestId, version: expectedVersion ?? current.version },
      data: {
        windowStartAt: BigInt(windowStartAt),
        windowEndAt: BigInt(windowEndAt),
        addressText: input.addressText ?? current.addressText,
        region,
        lat,
        lon,
        needsGeocoding: movingPoint ? lat === null || lon === null : current.needsGeocoding,
        priority:
          input.urgent === undefined ? current.priority : input.urgent ? 'urgent' : 'normal',
        requiredEquipment:
          input.requiredEquipment === undefined
            ? current.requiredEquipment
            : input.requiredEquipment,
        assignmentState: 'pending',
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    assertWriteApplied('Request', updated.count, expectedVersion, current.version);

    // When the office moves the agreed window, the customer must re-agree or cancel; an
    // address-only edit asks for no letter. One letter per proposed window (context/36
    // section 10), with the two answer buttons the letter template provides.
    if (
      windowStartAt !== Number(current.windowStartAt) ||
      windowEndAt !== Number(current.windowEndAt)
    ) {
      await this.notifications.record(context.tx, context.now, {
        category: 'visit_change_required',
        businessEventKey: `visit_change_required:${requestId}:${windowStartAt}:${windowEndAt}`,
        recipientAccountId: current.clientAccountId,
        payload: { requestId },
      });
    }

    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.REQUEST_CONDITIONS_CHANGED,
    );

    return this.reload(context.tx, requestId);
  }

  /**
   * Dispatcher cancellation.
   *
   * A state change with its own timestamp, not a deletion: the record and its history
   * stay (context/42 DF-05). Cancellation never follows automatically from a request
   * going unassigned.
   */
  async cancel(
    context: OperationContext,
    requestId: string,
    expectedVersion: number | null | undefined,
    reason: string | null,
  ): Promise<Request> {
    const current = await this.loadOwned(context.tx, requestId);
    if (current.lifecycle === 'cancelled') {
      return current;
    }
    assertChangeable(current);

    const updated = await context.tx.request.updateMany({
      where: { id: requestId, version: expectedVersion ?? current.version },
      data: {
        lifecycle: 'cancelled',
        assignmentState: 'unassigned',
        cancelledAt: BigInt(context.now),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    assertWriteApplied('Request', updated.count, expectedVersion, current.version);

    await context.tx.requestConditionHistory.create({
      data: {
        requestId,
        changedAt: BigInt(context.now),
        operationId: context.operationId,
        previous: conditionsOf(current),
        reason: reason ?? 'cancelled by dispatcher',
      },
    });

    // The customer learns the work will not happen from sys, not from silence
    // (card #65, 2026-09-20 decision). One letter per cancelled request.
    await this.notifications.record(context.tx, context.now, {
      category: 'request_cancelled',
      businessEventKey: `request_cancelled:${requestId}`,
      recipientAccountId: current.clientAccountId,
      payload: { requestId, reason: reason ?? null },
    });

    // The free pool changed, so the task changed.
    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.REQUEST_CANCELLED,
    );

    return this.reload(context.tx, requestId);
  }

  /** Loads a request, or reports that it does not exist. */
  private async loadOwned(tx: Tx, requestId: string): Promise<Request> {
    const request = await tx.request.findUnique({ where: { id: requestId } });
    if (!request) {
      throw SysError.notFound('Request', { requestId });
    }
    return request;
  }

  private async reload(tx: Tx, requestId: string): Promise<Request> {
    return tx.request.findUniqueOrThrow({ where: { id: requestId } });
  }

  private async archiveConditions(context: OperationContext, current: Request): Promise<void> {
    await context.tx.requestConditionHistory.create({
      data: {
        requestId: current.id,
        changedAt: BigInt(context.now),
        operationId: context.operationId,
        previous: conditionsOf(current),
      },
    });
  }
}

/**
 * The boundary the whole request lifecycle turns on.
 *
 * Once the engineer has recorded a start, ordinary changes to the conditions and
 * reassignment are closed -- through every path, including a stale screen, a link from an
 * old email, a new session, an integration key or an AI fix. The check is on the server
 * for exactly that reason (context/42 DF-05).
 */
function assertChangeable(request: Request): void {
  if (request.lifecycle === 'in_progress' || request.startedAt !== null) {
    throw new SysError('WORK_ALREADY_STARTED', 'The engineer has already started this work', {
      details: { requestId: request.id, startedAt: numberOrNull(request.startedAt) },
    });
  }
  if (request.lifecycle === 'completed') {
    throw new SysError('WORK_ALREADY_STARTED', 'This work is already finished', {
      details: { requestId: request.id },
    });
  }
  if (request.lifecycle === 'cancelled') {
    throw new SysError('VALIDATION_FAILED', 'This request is cancelled', {
      details: { requestId: request.id },
    });
  }
}

function assertWindow(startAt: number, endAt: number): void {
  if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt)) {
    throw new SysError('VALIDATION_FAILED', 'A time window is whole Unix seconds');
  }
  // A single-instant window is allowed if the work is physically possible; only a
  // reversed pair is a data error (context/33 section 10.2).
  if (endAt < startAt) {
    throw new SysError('VALIDATION_FAILED', 'The window ends before it starts', {
      details: { windowStartAt: startAt, windowEndAt: endAt },
    });
  }
}

/**
 * Urgency raises the priority but never lowers it: a customer calling an outage routine
 * does not make it routine.
 */
function resolvePriority(fromWorkType: Priority, urgentRequested: boolean): Priority {
  return fromWorkType === 'urgent' || urgentRequested ? 'urgent' : 'normal';
}

/** The conditions as they were, in the shape the journal stores. */
function conditionsOf(request: Request): Prisma.InputJsonObject {
  return {
    windowStartAt: Number(request.windowStartAt),
    windowEndAt: Number(request.windowEndAt),
    windowOrigin: request.windowOrigin,
    addressText: request.addressText,
    lat: request.lat,
    lon: request.lon,
    priority: request.priority,
    requiredSkill: request.requiredSkill,
    requiredEquipment: request.requiredEquipment,
    normProfileCode: request.normProfileCode,
    normativeTravelDurationSec: request.normativeTravelDurationSec,
    technicalDurationSec: request.technicalDurationSec,
    documentationDurationSec: request.documentationDurationSec,
    serviceDurationSec: request.serviceDurationSec,
    version: request.version,
  };
}

/** Work types whose wording itself names the consumed device need no extra user choice. */
function defaultEquipment(workType: string): EquipmentType | null {
  if (workType === 'router_replacement') {
    return 'router';
  }
  if (workType === 'stb_replacement') {
    return 'set_top_box';
  }
  return null;
}

function numberOrNull(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * Picks the planning region whose existing-request geocenter is closest to the
 * new point. Regions without request points fall back to engineer homes, then depots.
 */
async function resolveRegion(
  tx: Tx,
  point: { lat: number; lon: number },
  excludeRequestId?: string,
): Promise<string | null> {
  const requestRows = await tx.request.findMany({
    where: {
      region: { not: null },
      lat: { not: null },
      lon: { not: null },
      lifecycle: { not: 'cancelled' },
      ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
    },
    select: { region: true, lat: true, lon: true },
  });
  let centers = regionCenters(toRegionPoints(requestRows));
  if (centers.size === 0) {
    const engineerRows = await tx.engineer.findMany({
      where: {
        archivedAt: null,
        region: { not: null },
        homeLat: { not: null },
        homeLon: { not: null },
      },
      select: { region: true, homeLat: true, homeLon: true },
    });
    centers = regionCenters(
      engineerRows.flatMap((row) =>
        row.region && row.homeLat !== null && row.homeLon !== null
          ? [{ region: row.region, lat: row.homeLat, lon: row.homeLon }]
          : [],
      ),
    );
  }
  if (centers.size === 0) {
    const depotRows = await tx.depot.findMany({
      where: { lat: { not: null }, lon: { not: null } },
      select: { region: true, lat: true, lon: true },
    });
    centers = regionCenters(toRegionPoints(depotRows));
  }
  return nearestRegion(point, centers);
}

function toRegionPoints(
  rows: ReadonlyArray<{ region: string | null; lat: number | null; lon: number | null }>,
): RegionPoint[] {
  return rows.flatMap((row) =>
    row.region && row.lat !== null && row.lon !== null
      ? [{ region: row.region, lat: row.lat, lon: row.lon }]
      : [],
  );
}

async function nextArrivalOrder(tx: Tx): Promise<number> {
  // A database sequence rather than max()+1: arrival order is the baseline's iteration
  // order (context/33 section 5), and two concurrent submissions must not receive the
  // same position.
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('request_arrival_order_seq') AS value
  `;
  const value = rows[0]?.value;
  if (value === undefined) {
    throw new SysError('INTERNAL_ERROR', 'Could not allocate an arrival order');
  }
  return Number(value);
}
