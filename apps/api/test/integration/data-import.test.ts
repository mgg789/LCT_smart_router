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

  it('loads a region, mapping every type of work in the file', async () => {
    const summary = await importRegion('east');

    assert.equal(summary.applied, true, summary.errors.join('; '));
    // Nothing is applied when a type cannot be interpreted, so an empty error list is the
    // proof that the catalogue covers the real data.
    assert.deepEqual(summary.errors, []);
    assert.ok(
      summary.requestsCreated > 50,
      `expected the region's requests, got ${summary.requestsCreated}`,
    );
    assert.ok(summary.engineersCreated > 5, 'crews come from the control distribution');
  });

  it('decodes windows-1251 instead of turning addresses into noise', async () => {
    const request = await prisma.request.findFirstOrThrow({
      where: { region: 'east' },
      orderBy: { arrivalOrder: 'asc' },
    });
    assert.match(request.addressText, /[А-Яа-яЁё]/, 'the address is readable Russian');
    assert.equal(request.addressText.includes('�'), false);
  });

  it('reads the office address hidden in the last row', async () => {
    const depot = await prisma.depot.findUnique({ where: { region: 'east' } });
    assert.ok(depot, 'every region carries its office in a row that looks blank');
    assert.match(depot.addressText, /Ленинцев/);
    // The file has no coordinates for it either, and none are invented.
    assert.equal(depot.lat, null);
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
      assert.ok(outage.serviceDurationSec > 0);
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

  it('marks imported requests as awaiting coordinates rather than inventing them', async () => {
    const withoutPoint = await prisma.request.count({ where: { needsGeocoding: true } });
    const total = await prisma.request.count({});
    assert.equal(withoutPoint, total, 'the dataset has addresses, not coordinates');

    const snapshot = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
    const body = (await snapshot.json()) as {
      diagnostics: { requestsWithoutLocation: number };
    };
    // Counted and visible, not silently missing from the plan.
    assert.ok(body.diagnostics.requestsWithoutLocation > 0);
  });

  it('recognises the same package by content and creates no duplicates', async () => {
    const before = await prisma.request.count({});
    const repeated = await importRegion('east');

    assert.equal(repeated.applied, false);
    assert.equal(repeated.requestsCreated, 0);
    assert.match(repeated.warnings.join(' '), /already been imported/i);
    assert.equal(await prisma.request.count({}), before);
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
      const response = await call('POST', '/api/v1/dispatch/data/reset', dispatcherToken, {
        operationId: randomUUID(),
        kind: 'empty',
        confirmation: 'erase all application data',
      });
      assert.equal(response.status, 201, await response.clone().text());

      assert.equal(await prisma.request.count({}), 0);
      assert.equal(await prisma.engineer.count({}), 0);
      assert.equal(await prisma.importPackage.count({}), 0);

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

    it('lets the dataset be loaded again after a reset', async () => {
      const summary = await importRegion('east');
      assert.equal(summary.applied, true);
      assert.ok(summary.requestsCreated > 50);
    });
  });
});
