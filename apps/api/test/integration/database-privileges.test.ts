import '../support/env';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient } from '../support/database';

/**
 * Router Core reads the published sector directly and must not be able to reach anything
 * else -- not sessions, tokens or customer/engineer business data
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

  it('may not read sessions or tokens', async () => {
    for (const table of ['sessions', 'api_tokens']) {
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

  /**
   * The exact query Router Core issues (`core/runtime.py`, `PostgresSnapshotSource`).
   *
   * It is spelled out literally rather than built from the model, because the point of
   * the check is that the other zone's hard-coded SQL keeps working. Router fetches two
   * rows and refuses anything but one, so the view must project the singleton pointer and
   * not the snapshot history.
   */
  it('serves the router_active_snapshot read contract to router_readonly', async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE router_readonly');
      return tx.$queryRawUnsafe<
        Array<{
          publication_id: string;
          publication_seq: number;
          payload_utf8: string;
          payload_sha256: string;
          published_at_epoch: bigint;
        }>
      >(
        'SELECT publication_id, publication_seq, payload_utf8, payload_sha256, ' +
          'published_at_epoch FROM router_active_snapshot',
      );
    });

    // Zero rows is a legitimate state -- nothing published yet -- and Router reports it as
    // SNAPSHOT_VIEW_INVALID rather than planning on nothing. Two rows never is.
    assert.ok(rows.length <= 1, 'the view must never expose more than one active row');
    if (rows.length === 0) {
      return;
    }

    const [row] = rows;
    assert.ok(row);
    assert.ok(row.publication_id.length > 0);
    assert.ok(Number(row.publication_seq) >= 0);
    assert.match(row.payload_sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number(row.published_at_epoch) >= 0);
    // Router verifies the declared hash against the bytes it was handed. If these two ever
    // disagree the whole exchange stops, so the view is the right place to notice.
    assert.equal(
      createHash('sha256').update(Buffer.from(row.payload_utf8, 'utf8')).digest('hex'),
      row.payload_sha256,
      'payload_sha256 must be the hash of payload_utf8',
    );
  });

  it('may not write through the read contract', async () => {
    await assert.rejects(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE router_readonly');
          await tx.$executeRawUnsafe(
            "DELETE FROM router_active_snapshot WHERE publication_id = 'nothing'",
          );
        }),
      /permission denied|cannot delete/i,
    );
  });
});
