import '../support/env';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { confirmLogistics, logisticsView } from '../../src/orchestrator/equipment/logistics';
import { createTestClient, unique } from '../support/database';

describe('one-sided equipment logistics', () => {
  const prisma = createTestClient();
  const donor = unique('delivery-donor');
  const receiver = unique('delivery-receiver');
  const workDate = '2098-02-01';
  const now = 4_042_051_200;
  const ids: string[] = [];
  before(async () => {
    for (const engineerId of [donor, receiver]) {
      await prisma.engineer.create({
        data: {
          id: engineerId,
          displayName: engineerId,
          inputOrder: 9999,
          skills: ['connection'],
          transportType: 'walk',
          region: 'logistics-test',
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
          shiftEndAt: BigInt(now + 7200),
          equipmentRouter: engineerId === donor ? 2 : 0,
          equipmentIssuedAt: BigInt(now),
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
        },
      });
    }
  });
  after(async () => {
    await prisma.equipmentLogistics.deleteMany({ where: { id: { in: ids } } });
    await prisma.request.deleteMany({ where: { id: { in: ids } } });
    await prisma.engineer.deleteMany({ where: { id: { in: [donor, receiver] } } });
    await prisma.$disconnect();
  });
  async function setup(
    kind: 'donor_delivery' | 'office_pickup',
    lifecycle: 'in_progress' | 'completed' | 'submitted' = kind === 'office_pickup'
      ? 'submitted'
      : 'in_progress',
  ) {
    const id = unique('logistics');
    ids.push(id);
    if (kind === 'donor_delivery')
      await prisma.engineerDay.update({
        where: { engineerId_workDate: { engineerId: donor, workDate } },
        data: { equipmentRouter: 2 },
      });
    await prisma.request.create({
      data: {
        id,
        arrivalOrder: 99999,
        lifecycle,
        addressText: 'Delivery test',
        normProfileCode: 'test',
        normativeTravelDurationSec: 0,
        technicalDurationSec: 300,
        documentationDurationSec: 0,
        serviceDurationSec: 300,
        windowStartAt: BigInt(now),
        windowEndAt: BigInt(now + 7200),
        requiredSkill: 'connection',
        origin: 'manual',
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
        startedAt: lifecycle === 'submitted' ? null : BigInt(now),
        expectedCompletionAt: BigInt(now + 600),
      },
    });
    await prisma.equipmentLogistics.create({
      data: {
        id,
        workDate,
        kind,
        status: 'assigned',
        requestId: id,
        equipmentType: 'router',
        donorEngineerId: kind === 'donor_delivery' ? donor : null,
        receiverEngineerId: receiver,
        lat: 55.7,
        lon: 37.7,
        expectedAt: BigInt(now + 300),
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    return id;
  }
  const confirm = (id: string, engineerId: string, kind: 'donor_delivery' | 'office_pickup') =>
    prisma.$transaction((tx) => confirmLogistics(tx, id, engineerId, workDate, now + 300, kind));
  const stock = async (engineerId: string) =>
    (
      await prisma.engineerDay.findUniqueOrThrow({
        where: { engineerId_workDate: { engineerId, workDate } },
      })
    ).equipmentRouter;
  it('rejects receiver and wrong action; donor confirmation consumes exactly once without phantom receiver stock', async () => {
    const id = await setup('donor_delivery');
    await assert.rejects(confirm(id, receiver, 'donor_delivery'), /another engineer/);
    await assert.rejects(confirm(id, donor, 'office_pickup'), /does not match/);
    assert.equal(await stock(donor), 2);
    const before = await prisma.equipmentLogistics.findUniqueOrThrow({ where: { id } });
    assert.equal(logisticsView(before, receiver, 'Donor').action, null);
    assert.equal(logisticsView(before, donor, 'Donor').action?.kind, 'equipment_delivery_confirm');
    await Promise.all([confirm(id, donor, 'donor_delivery'), confirm(id, donor, 'donor_delivery')]);
    assert.equal(await stock(donor), 1);
    assert.equal(await stock(receiver), 0);
    const completed = await prisma.equipmentLogistics.findUniqueOrThrow({ where: { id } });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.actualAt, BigInt(now + 300));
  });
  it('does not debit equipment for a visit that has already finished', async () => {
    const id = await setup('donor_delivery', 'completed');
    await assert.rejects(confirm(id, donor, 'donor_delivery'), /no longer active/);
    assert.equal(await stock(donor), 2);
    assert.equal(
      (await prisma.equipmentLogistics.findUniqueOrThrow({ where: { id } })).status,
      'assigned',
    );
  });
  it('credits office pickup only to its owner and only once, respecting capacity', async () => {
    const id = await setup('office_pickup');
    await assert.rejects(confirm(id, donor, 'office_pickup'), /another engineer/);
    await prisma.engineerDay.update({
      where: { engineerId_workDate: { engineerId: receiver, workDate } },
      data: { equipmentRouter: 100000 },
    });
    await assert.rejects(confirm(id, receiver, 'office_pickup'), /cannot carry/);
    assert.equal(
      (await prisma.equipmentLogistics.findUniqueOrThrow({ where: { id } })).status,
      'assigned',
    );
    await prisma.engineerDay.update({
      where: { engineerId_workDate: { engineerId: receiver, workDate } },
      data: { equipmentRouter: 0 },
    });
    await confirm(id, receiver, 'office_pickup');
    await confirm(id, receiver, 'office_pickup');
    assert.equal(await stock(receiver), 1);
  });
  it('does not let a donor abandon an active visit to confirm a delivery', async () => {
    const id = await setup('donor_delivery');
    const own = await setup('donor_delivery');
    await prisma.requestFact.create({
      data: {
        requestId: own,
        engineerId: donor,
        kind: 'started',
        occurredAt: BigInt(now),
        recordedAt: BigInt(now),
      },
    });
    await assert.rejects(confirm(id, donor, 'donor_delivery'), /active visit/);
    assert.equal(await stock(donor), 2);
    await prisma.request.update({ where: { id: own }, data: { lifecycle: 'completed' } });
    await confirm(id, donor, 'donor_delivery');
    assert.equal(await stock(donor), 1);
  });
});
