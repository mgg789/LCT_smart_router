import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { FixedClock } from '../../src/common/time';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { PerformanceService } from '../../src/orchestrator/performance/performance.service';
import { createTestClient, databaseUrl } from '../support/database';

const start = Math.floor(Date.parse('2026-09-22T09:00:00+03:00') / 1000);
const end = start + 8 * 3600;

/** Regression coverage for factual performance projections against PostgreSQL. */
describe('performance analytics projection', () => {
  let prisma: PrismaClient;
  const ids = {
    engineer: randomUUID(),
    request: randomUUID(),
    tomorrow: randomUUID(),
    workday: randomUUID(),
    plan: randomUUID(),
    route: randomUUID(),
  };

  before(async () => {
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    await prisma.engineer.create({
      data: {
        id: ids.engineer,
        displayName: 'Факт Инженер',
        inputOrder: 99_001,
        skills: ['connection'],
        transportType: 'car',
        origin: 'manual',
        createdAt: BigInt(start),
        updatedAt: BigInt(start),
      },
    });
    await prisma.engineerDay.create({
      data: {
        engineerId: ids.engineer,
        workDate: '2026-09-22',
        shiftStartAt: BigInt(start),
        shiftEndAt: BigInt(end),
        createdAt: BigInt(start),
        updatedAt: BigInt(start),
      },
    });
    await prisma.liveWorkday.create({
      data: {
        id: ids.workday,
        generation: 99_001,
        workDate: '2026-09-22',
        status: 'finished',
        logicalStartAt: BigInt(start),
        logicalEndAt: BigInt(end),
        finishedAt: BigInt(end),
        createdAt: BigInt(start),
        updatedAt: BigInt(end),
      },
    });
    await prisma.request.createMany({
      data: [
        requestData(ids.request, 1, start + 3600, start + 7200),
        requestData(ids.tomorrow, 2, start + 86_400, start + 90_000),
      ],
    });
    await prisma.liveRequestState.create({
      data: {
        workdayId: ids.workday,
        requestId: ids.request,
        createdAt: BigInt(start),
        updatedAt: BigInt(start),
      },
    });
    await prisma.appliedPlan.create({
      data: {
        id: ids.plan,
        origin: 'auto',
        planAsOf: BigInt(start),
        appliedAt: BigInt(start),
        createdBy: 'test',
      },
    });
    await prisma.appliedPlanRoute.create({
      data: {
        id: ids.route,
        planId: ids.plan,
        engineerId: ids.engineer,
        startLat: 55.7,
        startLon: 37.6,
        lunchStatus: 'not_required',
        reasons: {},
      },
    });
    await prisma.appliedPlanStop.create({
      data: {
        routeId: ids.route,
        sequence: 1,
        kind: 'job',
        requestId: ids.request,
        lat: 55.7,
        lon: 37.6,
        arrivalAt: BigInt(start + 3500),
        startAt: BigInt(start + 3600),
        endAt: BigInt(start + 5400),
      },
    });
    await prisma.requestFact.createMany({
      data: [
        {
          requestId: ids.request,
          engineerId: ids.engineer,
          kind: 'started',
          occurredAt: BigInt(start + 3600),
          recordedAt: BigInt(start + 3600),
        },
        {
          requestId: ids.request,
          engineerId: ids.engineer,
          kind: 'finished',
          occurredAt: BigInt(start + 5700),
          recordedAt: BigInt(start + 5700),
        },
        // A replayed fact may exist after a transport retry; it must not double the projection.
        {
          requestId: ids.request,
          engineerId: ids.engineer,
          kind: 'finished',
          occurredAt: BigInt(start + 5700),
          recordedAt: BigInt(start + 5701),
        },
      ],
    });
  });

  after(async () => {
    await prisma.liveWorkday.deleteMany({ where: { id: ids.workday } });
    await prisma.appliedPlan.deleteMany({ where: { id: ids.plan } });
    await prisma.request.deleteMany({ where: { id: { in: [ids.request, ids.tomorrow] } } });
    await prisma.engineer.deleteMany({ where: { id: ids.engineer } });
    await prisma.$disconnect();
  });

  it('deduplicates finishes, uses the accepted plan before start, and keeps next-day open work visible', async () => {
    const service = new PerformanceService(prisma as never, new FixedClock(end));
    const snapshot = await service.buildSnapshot(prisma as never, ids.workday, end, end);
    assert.equal(snapshot.engineers[0]?.workMinutes, 35);
    assert.equal(snapshot.analytics?.engineers[0]?.completed, 1);
    assert.equal(snapshot.analytics?.engineers[0]?.punctualCompletion.sampleCount, 1);
    assert.equal(snapshot.analytics?.engineers[0]?.punctualCompletion.averageLatenessMinutes, 5);
    assert.equal(snapshot.nextDay?.openRequestCount, 1);
    assert.equal(snapshot.nextDay?.requests[0]?.requestId, ids.tomorrow);
  });
});

function requestData(id: string, arrivalOrder: number, windowStartAt: number, windowEndAt: number) {
  return {
    id,
    arrivalOrder,
    addressText: `Москва, тест ${arrivalOrder}`,
    normProfileCode: 'connection',
    normativeTravelDurationSec: 0,
    technicalDurationSec: 1800,
    documentationDurationSec: 0,
    serviceDurationSec: 1800,
    windowStartAt: BigInt(windowStartAt),
    windowEndAt: BigInt(windowEndAt),
    requiredSkill: 'connection' as const,
    priority: 'normal' as const,
    origin: 'manual' as const,
    createdAt: BigInt(start),
    updatedAt: BigInt(start),
    lifecycle: 'submitted' as const,
  };
}
