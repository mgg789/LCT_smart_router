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

describe('JSON region and request package upload', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let token: string;
  const region = unique('uploaded').replaceAll('-', '_');

  const call = async (body: unknown) =>
    fetch(`${baseUrl}/api/v1/dispatch/data/upload`, {
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

  const today = (): { start: number; end: number; lunchStart: number; lunchEnd: number } => {
    const now = Math.floor(Date.now() / 1000);
    const localDate = new Date((now + 3 * 3600) * 1000).toISOString().slice(0, 10);
    const midnight = Date.parse(`${localDate}T00:00:00.000Z`) / 1000 - 3 * 3600;
    return {
      start: midnight + 8 * 3600,
      end: midnight + 18 * 3600,
      lunchStart: midnight + 11 * 3600 + 20 * 60,
      lunchEnd: midnight + 15 * 3600,
    };
  };

  const basePackage = () => {
    const day = today();
    return {
      operationId: randomUUID(),
      schemaVersion: '1.0',
      mode: 'new_region' as const,
      region,
      sourceVersion: 'test-v1',
      depot: { addressText: 'Test depot', lat: 55.7, lon: 37.6 },
      engineers: [
        {
          externalId: 'engineer-1',
          displayName: 'Test Engineer',
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
          addressText: 'Test address 1',
          lat: 55.71,
          lon: 37.61,
          serviceDurationSec: 1800,
          windowStartAt: day.start + 3600,
          windowEndAt: day.start + 4 * 3600,
          priority: 'normal',
          requiredSkill: 'connection',
          requiredEquipment: 'router',
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
    const requests = await prisma.request.findMany({ where: { region }, select: { id: true } });
    const engineers = await prisma.engineer.findMany({ where: { region }, select: { id: true } });
    await prisma.appliedPlanCurrent.deleteMany({});
    await prisma.appliedPlan.deleteMany({});
    await prisma.routingCurrent.deleteMany({});
    await prisma.routingSnapshot.deleteMany({});
    await prisma.externalIdMap.deleteMany({
      where: {
        source: {
          in: [`region:${region}`, `upload:${region}:test-v1`, `upload:${region}:test-v2`],
        },
      },
    });
    await prisma.request.deleteMany({ where: { id: { in: requests.map((item) => item.id) } } });
    await prisma.engineerDay.deleteMany({
      where: { engineerId: { in: engineers.map((item) => item.id) } },
    });
    await prisma.engineer.deleteMany({ where: { id: { in: engineers.map((item) => item.id) } } });
    await prisma.depot.deleteMany({ where: { region } });
    await prisma.importPackage.deleteMany({
      where: { source: { startsWith: `upload:${region}:` } },
    });
    await prisma.$disconnect();
    await app?.close();
  });

  it('creates a complete region, publishes region-safe data and exact lunch bounds', async () => {
    const response = await call(basePackage());
    assert.equal(response.status, 201, await response.clone().text());
    const body = (await response.json()) as {
      applied: boolean;
      requestsCreated: number;
      engineersCreated: number;
      publicationId: string | null;
      inputHash: string | null;
    };
    assert.equal(body.applied, true);
    assert.equal(body.requestsCreated, 1);
    assert.equal(body.engineersCreated, 1);
    assert.ok(body.publicationId);
    assert.ok(body.inputHash);

    const engineer = await prisma.engineer.findFirstOrThrow({ where: { region } });
    const day = await prisma.engineerDay.findFirstOrThrow({ where: { engineerId: engineer.id } });
    const bounds = today();
    assert.equal(day.lunchEnabled, true);
    assert.equal(day.lunchDurationSec, 2700);
    assert.equal(Number(day.lunchWindowStartAt), bounds.lunchStart);
    assert.equal(Number(day.lunchWindowEndAt), bounds.lunchEnd);
    assert.equal(day.equipmentRouter, 2);

    const current = await prisma.routingCurrent.findUniqueOrThrow({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    const snapshot = JSON.parse(current.snapshot.payload) as {
      requests: Array<{ region: string | null }>;
      engineers: Array<{ region: string | null }>;
    };
    assert.ok(snapshot.requests.some((item) => item.region === region));
    assert.ok(snapshot.engineers.some((item) => item.region === region));
  });

  it('treats the same package as idempotent even with a new operation id', async () => {
    const repeated = { ...basePackage(), operationId: randomUUID() };
    const response = await call(repeated);
    assert.equal(response.status, 201, await response.clone().text());
    const body = (await response.json()) as { applied: boolean; warnings: string[] };
    assert.equal(body.applied, false);
    assert.match(body.warnings.join(' '), /already been imported/i);
    assert.equal(await prisma.request.count({ where: { region } }), 1);
  });

  it('appends requests and rolls back the whole package on an external-id conflict', async () => {
    const day = today();
    const append = {
      operationId: randomUUID(),
      schemaVersion: '1.0',
      mode: 'append_requests',
      region,
      sourceVersion: 'test-v2',
      requests: [
        {
          externalId: 'request-2',
          addressText: 'Test address 2',
          lat: 55.72,
          lon: 37.62,
          serviceDurationSec: 1200,
          windowStartAt: day.start + 2 * 3600,
          windowEndAt: day.start + 5 * 3600,
          priority: 'urgent',
          requiredSkill: 'connection',
        },
      ],
    };
    const accepted = await call(append);
    assert.equal(accepted.status, 201, await accepted.clone().text());
    assert.equal(await prisma.request.count({ where: { region } }), 2);

    const changedVersion = await call({
      ...append,
      operationId: randomUUID(),
      requests: [{ ...append.requests[0], externalId: 'request-version-conflict' }],
    });
    assert.equal(changedVersion.status, 422, await changedVersion.clone().text());
    assert.equal(await prisma.request.count({ where: { region } }), 2);

    const beforePackages = await prisma.importPackage.count({
      where: { source: { startsWith: `upload:${region}:` } },
    });
    const conflict = await call({
      ...append,
      operationId: randomUUID(),
      sourceVersion: 'test-v3',
      requests: [
        { ...append.requests[0], addressText: 'Changed address' },
        { ...append.requests[0], externalId: 'request-3' },
      ],
    });
    assert.equal(conflict.status, 422, await conflict.clone().text());
    assert.equal(await prisma.request.count({ where: { region } }), 2);
    assert.equal(
      await prisma.importPackage.count({ where: { source: { startsWith: `upload:${region}:` } } }),
      beforePackages,
    );
  });

  it('returns the uploaded region in state and request API views', async () => {
    const state = await fetch(`${baseUrl}/api/v1/dispatch/data/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const stateBody = (await state.json()) as { availableRegions: string[] };
    assert.ok(stateBody.availableRegions.includes(region));

    const response = await fetch(`${baseUrl}/api/v1/dispatch/requests`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as { requests: Array<{ region: string | null }> };
    assert.ok(body.requests.some((request) => request.region === region));
  });
});
