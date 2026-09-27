import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient, databaseUrl, unique } from '../support/database';

describe('two-step import preparation', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let token: string;
  const region = unique('prepared').replaceAll('-', '_');
  const secondRegion = unique('prepared_cancel').replaceAll('-', '_');
  const extraRegions: string[] = [];
  const preparationIds: string[] = [];

  const call = (path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const signIn = async (): Promise<string> => {
    const response = await fetch(`${baseUrl}/api/v1/auth/dispatcher/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: process.env.DISPATCHER_EMAIL,
        password: process.env.DISPATCHER_PASSWORD,
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return ((await response.json()) as { token: string }).token;
  };

  const today = () => {
    const now = Math.floor(Date.now() / 1000);
    const localDate = new Date((now + 3 * 3600) * 1000).toISOString().slice(0, 10);
    const midnight = Date.parse(`${localDate}T00:00:00.000Z`) / 1000 - 3 * 3600;
    return { start: midnight + 8 * 3600, end: midnight + 18 * 3600 };
  };

  const packageFor = (targetRegion: string) => {
    const day = today();
    return {
      operationId: randomUUID(),
      schemaVersion: '1.0',
      mode: 'new_region',
      region: targetRegion,
      sourceVersion: 'prepare-v1',
      depot: { addressText: 'Depot', lat: 55.7, lon: 37.6 },
      engineers: [
        {
          externalId: 'engineer-1',
          displayName: 'Prepared engineer',
          skills: ['connection'],
          transportType: 'car',
          start: { lat: 55.7, lon: 37.6 },
          shiftStartAt: day.start,
          shiftEndAt: day.end,
        },
      ],
      requests: [
        {
          externalId: 'request-1',
          addressText: 'Test address',
          lat: 55.71,
          lon: 37.61,
          serviceDurationSec: 1800,
          windowStartAt: day.start + 3600,
          windowEndAt: day.start + 4 * 3600,
          priority: 'normal',
          requiredSkill: 'connection',
        },
      ],
    };
  };

  before(async () => {
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'health/services'],
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new BigIntGuardInterceptor(true));
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    token = await signIn();
  });

  after(async () => {
    const requests = await prisma.request.findMany({
      where: { region: { in: [region, secondRegion, ...extraRegions] } },
      select: { id: true },
    });
    const engineers = await prisma.engineer.findMany({
      where: { region: { in: [region, secondRegion, ...extraRegions] } },
      select: { id: true },
    });
    await prisma.appliedPlanCurrent.deleteMany({});
    await prisma.appliedPlan.deleteMany({});
    await prisma.routingCurrent.deleteMany({});
    await prisma.routingSnapshot.deleteMany({});
    await prisma.externalIdMap.deleteMany({
      where: {
        source: { in: [region, secondRegion, ...extraRegions].map((item) => `region:${item}`) },
        internalId: { in: [...requests, ...engineers].map((item) => item.id) },
      },
    });
    await prisma.request.deleteMany({ where: { id: { in: requests.map((item) => item.id) } } });
    await prisma.engineerDay.deleteMany({
      where: { engineerId: { in: engineers.map((item) => item.id) } },
    });
    await prisma.engineer.deleteMany({ where: { id: { in: engineers.map((item) => item.id) } } });
    await prisma.depot.deleteMany({
      where: { region: { in: [region, secondRegion, ...extraRegions] } },
    });
    await prisma.importPackage.deleteMany({
      where: {
        source: {
          in: [region, secondRegion, ...extraRegions].map((item) => `upload:${item}:prepare-v1`),
        },
      },
    });
    await prisma.importPreparation.deleteMany({ where: { id: { in: preparationIds } } });
    await prisma.$disconnect();
    await app?.close();
  });

  it('confirms concurrent retries once and cancels without business writes', async () => {
    const preparedResponse = await call('/api/v1/dispatch/data/upload/prepare', packageFor(region));
    assert.equal(preparedResponse.status, 201, await preparedResponse.clone().text());
    const prepared = (await preparedResponse.json()) as {
      prepareId: string;
      immutableBatchHash: string;
      expiresAt: number;
      findings: unknown[];
    };
    preparationIds.push(prepared.prepareId);
    assert.match(prepared.immutableBatchHash, /^[a-f0-9]{64}$/u);
    assert.ok(prepared.expiresAt > Math.floor(Date.now() / 1000));
    assert.equal(await prisma.request.count({ where: { region } }), 0);
    assert.equal(await prisma.engineer.count({ where: { region } }), 0);

    const duplicatePrepared = await call(
      '/api/v1/dispatch/data/upload/prepare',
      packageFor(region),
    );
    assert.equal(duplicatePrepared.status, 201, await duplicatePrepared.clone().text());
    const duplicateView = (await duplicatePrepared.json()) as {
      prepareId: string;
      immutableBatchHash: string;
    };
    preparationIds.push(duplicateView.prepareId);
    assert.equal(duplicateView.immutableBatchHash, prepared.immutableBatchHash);
    const duplicateCancel = await call(
      `/api/v1/dispatch/data/upload/prepare/${duplicateView.prepareId}/cancel`,
      { operationId: randomUUID() },
    );
    assert.equal(duplicateCancel.status, 201, await duplicateCancel.clone().text());

    const confirmPath = `/api/v1/dispatch/data/upload/prepare/${prepared.prepareId}/confirm`;
    const [first, second] = await Promise.all([
      call(confirmPath, { operationId: randomUUID() }),
      call(confirmPath, { operationId: randomUUID() }),
    ]);
    assert.equal(first.status, 201, await first.clone().text());
    assert.equal(second.status, 201, await second.clone().text());
    assert.deepEqual(await first.json(), await second.json());
    assert.equal(await prisma.request.count({ where: { region } }), 1);
    assert.equal(
      await prisma.importPackage.count({ where: { source: `upload:${region}:prepare-v1` } }),
      1,
    );

    const cancelledPrepare = await call(
      '/api/v1/dispatch/data/upload/prepare',
      packageFor(secondRegion),
    );
    assert.equal(cancelledPrepare.status, 201, await cancelledPrepare.clone().text());
    const cancelledView = (await cancelledPrepare.json()) as { prepareId: string };
    preparationIds.push(cancelledView.prepareId);
    const cancel = await call(
      `/api/v1/dispatch/data/upload/prepare/${cancelledView.prepareId}/cancel`,
      { operationId: randomUUID() },
    );
    assert.equal(cancel.status, 201, await cancel.clone().text());
    assert.equal(await prisma.request.count({ where: { region: secondRegion } }), 0);
    const confirmCancelled = await call(
      `/api/v1/dispatch/data/upload/prepare/${cancelledView.prepareId}/confirm`,
      { operationId: randomUUID() },
    );
    assert.equal(confirmCancelled.status, 409, await confirmCancelled.clone().text());

    const expiredRegion = unique('prepared_expired').replaceAll('-', '_');
    extraRegions.push(expiredRegion);
    const expiredPrepare = await call(
      '/api/v1/dispatch/data/upload/prepare',
      packageFor(expiredRegion),
    );
    assert.equal(expiredPrepare.status, 201, await expiredPrepare.clone().text());
    const expiredView = (await expiredPrepare.json()) as { prepareId: string };
    preparationIds.push(expiredView.prepareId);
    await prisma.importPreparation.update({
      where: { id: expiredView.prepareId },
      data: { expiresAt: BigInt(Math.floor(Date.now() / 1000) - 1) },
    });
    const confirmExpired = await call(
      `/api/v1/dispatch/data/upload/prepare/${expiredView.prepareId}/confirm`,
      { operationId: randomUUID() },
    );
    assert.equal(confirmExpired.status, 409, await confirmExpired.clone().text());

    const otherOwnerId = randomUUID();
    const otherOwnerPreparationId = randomUUID();
    preparationIds.push(otherOwnerPreparationId);
    const now = Math.floor(Date.now() / 1000);
    await prisma.importPreparation.create({
      data: {
        id: otherOwnerPreparationId,
        source: 'upload:private:other-owner',
        ownerKind: 'account',
        ownerId: otherOwnerId,
        immutableBatchHash: '0'.repeat(64),
        versions: '{}',
        payload: '{}',
        findings: '[]',
        createdAt: BigInt(now),
        expiresAt: BigInt(now + 3600),
      },
    });
    const crossOwnerCancel = await call(
      `/api/v1/dispatch/data/upload/prepare/${otherOwnerPreparationId}/cancel`,
      { operationId: randomUUID() },
    );
    assert.equal(crossOwnerCancel.status, 404, await crossOwnerCancel.clone().text());
    assert.equal(
      (await prisma.importPreparation.findUniqueOrThrow({ where: { id: otherOwnerPreparationId } }))
        .status,
      'prepared',
    );

    const raceRegion = unique('prepared_race').replaceAll('-', '_');
    extraRegions.push(raceRegion);
    const racePrepared = await call('/api/v1/dispatch/data/upload/prepare', packageFor(raceRegion));
    assert.equal(racePrepared.status, 201, await racePrepared.clone().text());
    const raceView = (await racePrepared.json()) as { prepareId: string };
    preparationIds.push(raceView.prepareId);
    const racePath = `/api/v1/dispatch/data/upload/prepare/${raceView.prepareId}`;
    const [raceConfirm, raceCancel] = await Promise.all([
      call(`${racePath}/confirm`, { operationId: randomUUID() }),
      call(`${racePath}/cancel`, { operationId: randomUUID() }),
    ]);
    assert.deepEqual(
      [raceConfirm.status, raceCancel.status].sort((left, right) => left - right),
      [201, 409],
    );
    assert.equal(
      await prisma.request.count({ where: { region: raceRegion } }),
      raceConfirm.status === 201 ? 1 : 0,
    );

    const changedSettingsRegion = unique('prepared_settings').replaceAll('-', '_');
    extraRegions.push(changedSettingsRegion);
    const settingsPrepared = await call(
      '/api/v1/dispatch/data/upload/prepare',
      packageFor(changedSettingsRegion),
    );
    assert.equal(settingsPrepared.status, 201, await settingsPrepared.clone().text());
    const settingsView = (await settingsPrepared.json()) as { prepareId: string };
    preparationIds.push(settingsView.prepareId);
    await prisma.appState.upsert({
      where: { key: 'dispatcher.settings' },
      create: {
        key: 'dispatcher.settings',
        value: { equipmentCapacityCar: 29 },
        updatedAt: BigInt(Math.floor(Date.now() / 1000)),
      },
      update: { value: { equipmentCapacityCar: 29 } },
    });
    const confirmChangedSettings = await call(
      `/api/v1/dispatch/data/upload/prepare/${settingsView.prepareId}/confirm`,
      { operationId: randomUUID() },
    );
    assert.equal(confirmChangedSettings.status, 409, await confirmChangedSettings.clone().text());
    assert.equal(await prisma.request.count({ where: { region: changedSettingsRegion } }), 0);
    await prisma.appState.deleteMany({ where: { key: 'dispatcher.settings' } });

    const officialRequestCount = await prisma.request.count({ where: { region: 'east' } });
    const officialPrepared = await call('/api/v1/dispatch/data/import/prepare', {
      operationId: randomUUID(),
      region: 'east',
    });
    assert.equal(officialPrepared.status, 201, await officialPrepared.clone().text());
    const officialView = (await officialPrepared.json()) as { prepareId: string };
    preparationIds.push(officialView.prepareId);
    assert.equal(await prisma.request.count({ where: { region: 'east' } }), officialRequestCount);
    const officialCancelled = await call(
      `/api/v1/dispatch/data/import/prepare/${officialView.prepareId}/cancel`,
      { operationId: randomUUID() },
    );
    assert.equal(officialCancelled.status, 201, await officialCancelled.clone().text());
    assert.equal(await prisma.request.count({ where: { region: 'east' } }), officialRequestCount);
  });
});
