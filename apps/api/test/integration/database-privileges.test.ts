import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient } from '../support/database';

/**
 * Router Core reads the published sector directly and must not be able to reach anything
 * else -- not sessions, not contacts, not the optional GPS observations
 * (context/37 section 4.4).
 *
 * These checks assert real GRANTs. A naming convention would pass a code review and fail
 * in production, which is exactly the failure the concept warns about: "separating the
 * areas is accompanied by real access rights, not just names".
 */
describe('database privileges: router_readonly', () => {
  let prisma: PrismaClient;

  before(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it('may read the published snapshot and its pointer', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE router_readonly');
      await tx.$queryRawUnsafe('SELECT count(*) FROM routing_snapshots');
      await tx.$queryRawUnsafe('SELECT count(*) FROM routing_current');
    });
  });

  it('may not read business data', async () => {
    await assert.rejects(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE router_readonly');
          await tx.$queryRawUnsafe('SELECT count(*) FROM requests');
        }),
      /permission denied/i,
    );
  });

  it('may not read sessions, tokens or telemetry', async () => {
    for (const table of ['sessions', 'api_tokens', 'gps_observations']) {
      await assert.rejects(
        () =>
          prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE router_readonly');
            await tx.$queryRawUnsafe(`SELECT count(*) FROM ${table}`);
          }),
        /permission denied/i,
        `expected router_readonly to be denied on ${table}`,
      );
    }
  });

  it('may not write to the sector it reads', async () => {
    await assert.rejects(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE router_readonly');
          await tx.$executeRawUnsafe("DELETE FROM routing_snapshots WHERE id = 'nothing'");
        }),
      /permission denied/i,
    );
  });
});
