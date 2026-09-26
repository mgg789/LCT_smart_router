import '../support/env';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  assertNoPendingHandoff,
  confirmHandoff,
  handoffView,
} from '../../src/orchestrator/equipment/handoffs';
import { createTestClient, unique } from '../support/database';

describe('physical equipment handoffs', () => {
  const prisma = createTestClient();
  const donor = unique('donor');
  const receiver = unique('receiver');
  const id = unique('meeting');
  const requestId = unique('after-meeting');
  const workDate = '2098-01-01';
  const now = 4_039_372_800;
  let planId: string;
  before(async () => {
    for (const [index, engineerId] of [donor, receiver].entries()) {
      await prisma.engineer.create({
        data: {
          id: engineerId,
          displayName: engineerId,
          inputOrder: 9990 + index,
          skills: ['connection'],
          transportType: 'walk',
          region: 'handoff-test',
          origin: 'manual',
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
        },
      });
      await prisma.engineerDay.create({
        data: {
          engineerId,
          workDate,
          shiftStartAt: BigInt(now),
          shiftEndAt: BigInt(now + 3600),
          equipmentRouter: index === 0 ? 2 : 0,
          equipmentIssuedAt: BigInt(now),
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
        },
      });
    }
    const plan = await prisma.appliedPlan.create({
      data: { origin: 'manual', planAsOf: BigInt(now), appliedAt: BigInt(now) },
    });
    planId = plan.id;
    await prisma.request.create({
      data: {
        id: requestId,
        arrivalOrder: 99999,
        addressText: 'Meeting continuation',
        normProfileCode: 'test',
        normativeTravelDurationSec: 0,
        technicalDurationSec: 300,
        documentationDurationSec: 0,
        serviceDurationSec: 300,
        windowStartAt: BigInt(now),
        windowEndAt: BigInt(now + 3600),
        requiredSkill: 'connection',
        origin: 'manual',
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    await prisma.appliedPlanCurrent.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', planId, updatedAt: BigInt(now) },
      update: { planId, updatedAt: BigInt(now) },
    });
    const metadata = {
      handoff_id: id,
      donor_engineer_id: donor,
      receiver_engineer_id: receiver,
      request_id: 'dependent-request',
      items: { router: 1, set_top_box: 0, smart_speaker: 0 },
    };
    for (const engineerId of [donor, receiver]) {
      const route = await prisma.appliedPlanRoute.create({
        data: {
          planId,
          engineerId,
          startLat: 55.7,
          startLon: 37.7,
          lunchStatus: 'disabled',
          reasons: [],
        },
      });
      await prisma.appliedPlanStop.create({
        data: {
          routeId: route.id,
          sequence: 0,
          kind: 'handoff',
          handoff: metadata,
          lat: 55.7,
          lon: 37.7,
          arrivalAt: BigInt(now),
          startAt: BigInt(now),
          endAt: BigInt(now + 300),
        },
      });
      await prisma.appliedPlanStop.create({
        data: {
          routeId: route.id,
          sequence: 1,
          kind: 'job',
          requestId,
          lat: 55.7,
          lon: 37.7,
          arrivalAt: BigInt(now + 300),
          startAt: BigInt(now + 300),
          endAt: BigInt(now + 600),
        },
      });
    }
    await prisma.equipmentHandoff.create({
      data: {
        id,
        workDate,
        donorEngineerId: donor,
        receiverEngineerId: receiver,
        requestId: 'dependent-request',
        items: metadata.items,
        lat: 55.7,
        lon: 37.7,
        meetingAt: BigInt(now),
        createdAt: BigInt(now),
      },
    });
  });
  after(async () => {
    await prisma.equipmentHandoff.deleteMany({ where: { id } });
    await prisma.appliedPlanCurrent.deleteMany({ where: { planId } });
    if (planId) await prisma.appliedPlan.deleteMany({ where: { id: planId } });
    await prisma.request.deleteMany({ where: { id: requestId } });
    await prisma.engineer.deleteMany({ where: { id: { in: [donor, receiver] } } });
    await prisma.$disconnect();
  });
  it('rejects third-party confirmation and early arrival without touching stock', async () => {
    await assert.rejects(
      prisma.$transaction((tx) => confirmHandoff(tx, id, 'outsider', workDate, now)),
      /other engineers/,
    );
    await assert.rejects(
      prisma.$transaction((tx) => confirmHandoff(tx, id, donor, workDate, now - 1)),
      /not started/,
    );
  });
  it('reserves after one confirmation and moves stock only once after both', async () => {
    await prisma.$transaction((tx) => confirmHandoff(tx, id, donor, workDate, now));
    const first = await prisma.equipmentHandoff.findUniqueOrThrow({ where: { id } });
    assert.equal(handoffView(first).completedAt, null);
    await assert.rejects(
      prisma.$transaction((tx) => assertNoPendingHandoff(tx, receiver, requestId, now + 300)),
      /confirm the equipment meeting/,
    );
    assert.equal(
      (
        await prisma.engineerDay.findUniqueOrThrow({
          where: { engineerId_workDate: { engineerId: donor, workDate } },
        })
      ).equipmentRouter,
      2,
    );
    await Promise.all([
      prisma.$transaction((tx) => confirmHandoff(tx, id, receiver, workDate, now + 1)),
      prisma.$transaction((tx) => confirmHandoff(tx, id, donor, workDate, now + 1)),
    ]);
    await prisma.$transaction((tx) => confirmHandoff(tx, id, receiver, workDate, now + 400));
    const days = await prisma.engineerDay.findMany({
      where: { workDate, engineerId: { in: [donor, receiver] } },
    });
    assert.equal(days.find((day) => day.engineerId === donor)?.equipmentRouter, 1);
    assert.equal(days.find((day) => day.engineerId === receiver)?.equipmentRouter, 1);
    assert.equal(
      handoffView(await prisma.equipmentHandoff.findUniqueOrThrow({ where: { id } })).completedAt,
      now + 1,
    );
    await assert.rejects(
      prisma.$transaction((tx) => assertNoPendingHandoff(tx, receiver, requestId, now + 299)),
      /confirm the equipment meeting/,
    );
    await prisma.$transaction((tx) => assertNoPendingHandoff(tx, receiver, requestId, now + 300));
  });
  it('rejects a corrupt meeting with the same donor and receiver', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.equipmentHandoff.update({ where: { id }, data: { receiverEngineerId: donor } });
      await assert.rejects(
        confirmHandoff(tx, id, donor, workDate, now + 400),
        /Invalid or changed/,
      );
      await tx.equipmentHandoff.update({ where: { id }, data: { receiverEngineerId: receiver } });
    });
  });
});
