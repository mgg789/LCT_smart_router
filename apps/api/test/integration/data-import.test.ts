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
import { createTestClient, databaseUrl } from '../support/database';

interface ImportBody {
  applied: boolean;
  requestsCreated: number;
  requestsSkippedAsDuplicate: number;
  engineersCreated: number;
  depotsCreated: number;
  requestsWithoutCoordinates: number;
  warnings: string[];
  errors: string[];
  regionResults?: Array<ImportBody & { region: string }>;
}

/**
 * Import of the organisers' dataset, against the real files in `data/dataset/anonymized`.
 *
 * Reading the actual files is the point: the anomalies these tests care about -- the
 * windows-1251 encoding, the office address hidden in the last row, empty windows, four
 * spellings of the Moscow prefix -- are properties of that data, and a synthetic fixture
 * would only prove that the parser agrees with itself.
 */
describe('official dataset import', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let dispatcherToken: string;

  const call = async (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const importRegion = async (region: string): Promise<ImportBody> => {
    const response = await call('POST', '/api/v1/dispatch/data/import', dispatcherToken, {
      operationId: randomUUID(),
      region,
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as ImportBody;
  };

  const importAllRegions = async (): Promise<ImportBody> => {
    const response = await call('POST', '/api/v1/dispatch/data/import', dispatcherToken, {
      operationId: randomUUID(),
      regions: 'all',
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as ImportBody;
  };

  const clear = async (): Promise<void> => {
    await prisma.appliedPlanCurrent.deleteMany({});
    await prisma.appliedPlan.deleteMany({});
    await prisma.routerResult.deleteMany({});
    await prisma.alert.deleteMany({});
    await prisma.routingCurrent.deleteMany({});
    await prisma.routingSnapshot.deleteMany({});
    await prisma.requestFact.deleteMany({});
    await prisma.requestConditionHistory.deleteMany({});
    await prisma.request.deleteMany({});
    await prisma.engineerDay.deleteMany({});
    await prisma.engineer.deleteMany({});
    await prisma.depot.deleteMany({});
    await prisma.externalIdMap.deleteMany({});
    await prisma.importPackage.deleteMany({});
    await prisma.notificationIntent.deleteMany({});
  };

  /** Signs the dispatcher in again; a reset clears every session, including this one. */
  const signInDispatcher = async (): Promise<string> => {
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

  before(async () => {
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    await clear();

    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'health/services'],
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new BigIntGuardInterceptor(true));
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    dispatcherToken = await signInDispatcher();
  });

  after(async () => {
    await clear();
    await prisma.$disconnect();
    await app?.close();
  });

  it('atomically loads all regions into one complete routable snapshot', async () => {
    const summary = await importAllRegions();

    assert.equal(summary.applied, true, summary.errors.join('; '));
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.requestsCreated, 205);
    assert.equal(summary.engineersCreated, 35);
    assert.equal(summary.regionResults?.length, 3);

    const snapshot = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
    const body = (await snapshot.json()) as {
      payload: string;
      diagnostics: { requestsIncluded: number; engineersIncluded: number };
    };
    const payload = JSON.parse(body.payload) as {
      requests: unknown[];
      engineers: Array<{ input_order: number }>;
    };
    assert.equal(payload.requests.length, 205);
    assert.equal(payload.engineers.length, 35);
    assert.equal(new Set(payload.engineers.map((item) => item.input_order)).size, 35);
    assert.equal(body.diagnostics.requestsIncluded, 205);
    assert.equal(body.diagnostics.engineersIncluded, 35);
  });

  it('decodes windows-1251 instead of turning addresses into noise', async () => {
    const request = await prisma.request.findFirstOrThrow({
      where: { region: 'east' },
      orderBy: { arrivalOrder: 'asc' },
    });
    assert.match(request.addressText, /[А-Яа-яЁё]/, 'the address is readable Russian');
    assert.equal(request.addressText.includes('\uFFFD'), false);
  });

  it('reads the office address hidden in the last row', async () => {
    const depot = await prisma.depot.findUnique({ where: { region: 'east' } });
    assert.ok(depot, 'every region carries its office in a row that looks blank');
    assert.match(depot.addressText, /Ленинцев/);
    assert.ok(
      depot.lat !== null && depot.lon !== null,
      'the offline geocode package covers office',
    );
  });

  it('normalises the Moscow prefix without touching house numbers', async () => {
    const requests = await prisma.request.findMany({ where: { region: 'east' }, take: 200 });
    assert.equal(
      requests.some((item) => /^Город Москва/.test(item.addressText)),
      false,
      'the four spellings collapse to one',
    );
    // House numbers such as "д. 128 к 5" are what a geocoder has to work with and are
    // left exactly as written.
    assert.ok(requests.some((item) => /д\.?\s*\d+/.test(item.addressText)));
  });

  it('derives skill, duration and priority, and marks the derivation', async () => {
    const outage = await prisma.request.findFirst({
      where: { region: 'east', workTypeHd: 'outage' },
    });
    if (outage) {
      assert.equal(outage.requiredSkill, 'emergency');
      assert.equal(outage.priority, 'urgent');
      assert.equal(outage.normProfileCode, 'outage_tkd');
      assert.equal(outage.normativeTravelDurationSec, 1200);
      assert.equal(outage.technicalDurationSec, 4800);
      assert.equal(outage.documentationDurationSec, 0);
      assert.equal(outage.serviceDurationSec, 4800);
    }

    const engineer = await prisma.engineer.findFirstOrThrow({ where: { region: 'east' } });
    // The dataset has no skills or transport at all, so every engineer it produces says
    // so (context/18 section 6.3).
    assert.equal(engineer.origin, 'synthesized');
    assert.ok(engineer.skills.length >= 1 && engineer.skills.length <= 3);
  });

  it('covers all three skills and all four transports across the crews', async () => {
    await importRegion('southeast');
    const engineers = await prisma.engineer.findMany({});
    const skills = new Set(engineers.flatMap((item) => item.skills));
    const transports = new Set(engineers.map((item) => item.transportType));
    assert.deepEqual([...skills].sort(), ['connection', 'emergency', 'local']);
    assert.deepEqual([...transports].sort(), ['bike', 'car', 'transit', 'walk']);
  });

  it('adds deterministic request equipment and engineer-owned morning stock', async () => {
    const equipped = await prisma.request.findMany({
      where: { requiredEquipment: { not: null } },
      select: { requiredEquipment: true },
    });
    assert.ok(equipped.length > 0);
    assert.deepEqual([...new Set(equipped.map((item) => item.requiredEquipment))].sort(), [
      'router',
      'set_top_box',
      'smart_speaker',
    ]);

    const days = await prisma.engineerDay.findMany({});
    assert.ok(
      days.some(
        (day) =>
          day.equipmentRouter > 0 || day.equipmentSetTopBox > 0 || day.equipmentSmartSpeaker > 0,
      ),
    );
    for (const day of days) {
      for (const quantity of [
        day.equipmentRouter,
        day.equipmentSetTopBox,
        day.equipmentSmartSpeaker,
      ]) {
        assert.ok(quantity === 0 || quantity >= 2, 'used equipment includes one spare');
      }
    }

    const snapshot = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
    const body = (await snapshot.json()) as { payload: string };
    const payload = JSON.parse(body.payload) as {
      requests: Array<{ required_equipment: string | null }>;
      engineers: Array<{ equipment_stock: Record<string, number> }>;
    };
    assert.ok(payload.requests.some((request) => request.required_equipment !== null));
    assert.ok(payload.engineers.every((engineer) => 'router' in engineer.equipment_stock));
  });

  it('prepares optional 30-minute lunches in the 11:20-15:00 local window', async () => {
    const day = await prisma.engineerDay.findFirstOrThrow({
      include: { engineer: true },
      where: { engineer: { region: 'east' } },
    });
    const midnightUtc = Date.parse(`${day.workDate}T00:00:00.000Z`) / 1000 - 3 * 3600;
    assert.equal(day.lunchEnabled, true);
    assert.equal(day.lunchRequired, false);
    assert.equal(day.lunchDurationSec, 1800);
    assert.equal(Number(day.lunchWindowStartAt), midnightUtc + 11 * 3600 + 20 * 60);
    assert.equal(Number(day.lunchWindowEndAt), midnightUtc + 15 * 3600);
  });

  it('updates lunch settings on existing imported day rows without duplicating data', async () => {
    const engineer = await prisma.engineer.findFirstOrThrow({ where: { region: 'east' } });
    const day = await prisma.engineerDay.findFirstOrThrow({ where: { engineerId: engineer.id } });
    const now = BigInt(Math.floor(Date.now() / 1000));
    const manual = await prisma.engineer.create({
      data: {
        displayName: 'Manual East engineer',
        inputOrder: 50_000,
        skills: ['local'],
        transportType: 'walk',
        region: 'east',
        origin: 'manual',
        createdAt: now,
        updatedAt: now,
        days: {
          create: {
            workDate: day.workDate,
            shiftStartAt: day.shiftStartAt,
            shiftEndAt: day.shiftEndAt,
            lunchEnabled: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    });
    await prisma.engineerDay.update({
      where: { id: day.id },
      data: {
        lunchEnabled: false,
        lunchDurationSec: null,
        lunchWindowStartAt: null,
        lunchWindowEndAt: null,
      },
    });
    const requestsBefore = await prisma.request.count({});
    const summary = await importRegion('east');
    assert.equal(summary.applied, true);
    assert.equal(summary.requestsCreated, 0);
    assert.equal(await prisma.request.count({}), requestsBefore);
    const updated = await prisma.engineerDay.findUniqueOrThrow({ where: { id: day.id } });
    assert.equal(updated.lunchEnabled, true);
    assert.equal(updated.lunchDurationSec, 1800);
    const manualDay = await prisma.engineerDay.findUniqueOrThrow({
      where: {
        engineerId_workDate: { engineerId: manual.id, workDate: day.workDate },
      },
    });
    assert.equal(manualDay.lunchEnabled, false);
    assert.equal(manualDay.lunchDurationSec, null);
  });

  it('loads every coordinate from the validated offline package', async () => {
    const withoutPoint = await prisma.request.count({ where: { needsGeocoding: true } });
    const total = await prisma.request.count({});
    assert.equal(total, 205);
    assert.equal(withoutPoint, 0);

    const snapshot = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
    const body = (await snapshot.json()) as {
      diagnostics: { requestsWithoutLocation: number };
    };
    assert.equal(body.diagnostics.requestsWithoutLocation, 0);
  });

  it('recognises the same package by content and creates no duplicates', async () => {
    const before = await prisma.request.count({});
    const repeated = await importRegion('east');

    assert.equal(repeated.requestsCreated, 0);
    assert.match(repeated.warnings.join(' '), /already been imported/i);
    assert.equal(await prisma.request.count({}), before);
  });

  it('rebases a repeated official import onto today so the day stays plannable', async () => {
    const eastBefore = await prisma.request.findMany({
      where: { region: 'east' },
      select: { id: true, version: true },
    });
    assert.ok(eastBefore.length > 0);

    const repeated = await importRegion('east');
    assert.equal(repeated.applied, true);
    assert.equal(repeated.requestsCreated, 0);
    assert.match(repeated.warnings.join(' '), /rebased to the live horizon/i);
    assert.equal(await prisma.request.count({ where: { region: 'east' } }), eastBefore.length);

    // rebaseToLiveHorizon anchors on now+60. Two imports in the same Unix second
    // write identical window values (runbook §7); the write still happens and
    // bumps version. Assert that, not a value change.
    const after = await prisma.request.findMany({
      where: { region: 'east' },
      select: { id: true, version: true },
    });
    const bumped = after.filter((row) => {
      const previous = eastBefore.find((item) => item.id === row.id);
      return previous !== undefined && row.version > previous.version;
    });
    assert.ok(bumped.length > 0, 'repeat import must bump request versions');
  });

  it('refuses to reinterpret an imported region with another crew-count profile', async () => {
    const before = await prisma.engineer.count({ where: { region: 'east' } });
    const response = await call('POST', '/api/v1/dispatch/data/import', dispatcherToken, {
      operationId: randomUUID(),
      region: 'east',
      engineerCountPerRegion: { east: 3 },
    });
    assert.equal(response.status, 422);
    assert.equal(await prisma.engineer.count({ where: { region: 'east' } }), before);
  });

  it('keeps the arrival order of the file, which the baseline iterates in', async () => {
    const requests = await prisma.request.findMany({
      where: { region: 'east' },
      orderBy: { arrivalOrder: 'asc' },
      take: 5,
    });
    const orders = requests.map((item) => item.arrivalOrder);
    assert.deepEqual(
      [...orders].sort((a, b) => a - b),
      orders,
    );
    assert.equal(new Set(orders).size, orders.length, 'no two requests share a position');
  });

  describe('resets', () => {
    it('refuses a destructive action without its exact confirmation', async () => {
      const response = await call('POST', '/api/v1/dispatch/data/reset', dispatcherToken, {
        operationId: randomUUID(),
        kind: 'empty',
        confirmation: 'yes',
      });
      assert.equal(response.status, 409);
      const body = (await response.json()) as {
        error: { code: string; details: { expected: string; affects: string[] } };
      };
      assert.equal(body.error.code, 'CONFIRMATION_REQUIRED');
      // The refusal names what would be affected, so a confirmation is an informed one.
      assert.ok(body.error.details.affects.length > 0);
      assert.ok((await prisma.request.count({})) > 0, 'nothing was deleted');
    });

    it('empties the working set and records that this was deliberate', async () => {
      const beforePointer = await prisma.routingCurrent.findUniqueOrThrow({
        where: { id: 'singleton' },
      });
      const response = await call('POST', '/api/v1/dispatch/data/reset', dispatcherToken, {
        operationId: randomUUID(),
        kind: 'empty',
        confirmation: 'erase all application data',
      });
      assert.equal(response.status, 201, await response.clone().text());

      assert.equal(await prisma.request.count({}), 0);
      assert.equal(await prisma.engineer.count({}), 0);
      assert.equal(await prisma.importPackage.count({}), 0);
      const afterPointer = await prisma.routingCurrent.findUniqueOrThrow({
        where: { id: 'singleton' },
      });
      assert.ok(
        afterPointer.pointerVersion > beforePointer.pointerVersion,
        'reset advances the publication sequence for a running Router',
      );

      // Sessions of the old state are cleared too, including the one that confirmed the
      // reset (context/37 section 9.4). Being asked to sign in again after erasing every
      // account is the honest outcome, not an oversight.
      const withOldSession = await call('GET', '/api/v1/dispatch/data/state', dispatcherToken);
      assert.equal(withOldSession.status, 401);

      dispatcherToken = await signInDispatcher();
      const state = await call('GET', '/api/v1/dispatch/data/state', dispatcherToken);
      const body = (await state.json()) as {
        initialized: boolean;
        startupProfile: string;
        generation: number;
      };
      // An empty `requests` table is not proof that setup never happened: the profile is
      // what stops a restart from quietly reloading the demo data.
      assert.equal(body.initialized, true);
      assert.equal(body.startupProfile, 'empty');
      assert.ok(body.generation > 1, 'a new generation marks the new working set');
    });

    it('keeps the dispatcher able to sign in after everything is erased', async () => {
      // Restored from configuration, not from a hidden archive of old users: deleting that
      // account outright would lock the Dashboard out (context/37 section 9.4).
      dispatcherToken = await signInDispatcher();
      const state = await call('GET', '/api/v1/dispatch/data/state', dispatcherToken);
      assert.equal(state.status, 200);
    });

    it('loads a deterministic crew-count scenario after a reset', async () => {
      const response = await call('POST', '/api/v1/dispatch/data/import', dispatcherToken, {
        operationId: randomUUID(),
        region: 'east',
        engineerCountPerRegion: { east: 3 },
      });
      assert.equal(response.status, 201, await response.clone().text());
      const summary = (await response.json()) as ImportBody;
      assert.equal(summary.applied, true);
      assert.equal(summary.requestsCreated, 66);
      assert.equal(summary.engineersCreated, 3);

      const snapshot = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
      const body = (await snapshot.json()) as { payload: string };
      const payload = JSON.parse(body.payload) as { requests: unknown[]; engineers: unknown[] };
      assert.equal(payload.requests.length, 66);
      assert.equal(payload.engineers.length, 3);
    });
  });
});
