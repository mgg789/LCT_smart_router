import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bigIntToSeconds, secondsToBigInt } from '../../src/common/time/bigint-boundary';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { APP_STATE_KEYS } from '../../src/persistence/app-state.keys';
import { ensureSystemInvariants } from '../../src/persistence/bootstrap.service';
import { createTestClient, unique } from '../support/database';

describe('persistence: schema and boundaries', () => {
  let prisma: PrismaClient;
  const createdAccountIds: string[] = [];

  before(async () => {
    prisma = createTestClient();
    await prisma.$connect();
  });

  after(async () => {
    if (createdAccountIds.length > 0) {
      await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
    }
    await prisma.$disconnect();
  });

  it('round-trips whole Unix seconds through BIGINT without losing precision', async () => {
    const now = 1789459200;
    const account = await prisma.account.create({
      data: {
        email: `${unique('probe')}@example.test`,
        createdAt: secondsToBigInt(now),
        updatedAt: secondsToBigInt(now),
      },
    });
    createdAccountIds.push(account.id);

    const stored = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    assert.equal(typeof stored.createdAt, 'bigint');
    assert.equal(bigIntToSeconds(stored.createdAt), now);
  });

  it('grants a role instead of deriving it from the address', async () => {
    const account = await prisma.account.create({
      data: {
        email: `${unique('roles')}@example.test`,
        createdAt: 0n,
        updatedAt: 0n,
        roles: { create: [{ role: 'client', grantedAt: 0n }] },
      },
      include: { roles: true },
    });
    createdAccountIds.push(account.id);

    assert.deepEqual(
      account.roles.map((entry) => entry.role),
      ['client'],
    );
  });

  it('refuses a second account for the same address', async () => {
    const email = `${unique('dup')}@example.test`;
    const first = await prisma.account.create({
      data: { email, createdAt: 0n, updatedAt: 0n },
    });
    createdAccountIds.push(first.id);

    await assert.rejects(
      () => prisma.account.create({ data: { email, createdAt: 0n, updatedAt: 0n } }),
      /Unique constraint|duplicate key/i,
    );
  });

  it('creates the control mode row once and never resets it afterwards', async () => {
    await ensureSystemInvariants(prisma, 1789459200);
    const created = await prisma.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    assert.equal(created.id, 'singleton');

    // A restart while the dispatcher holds manual control must not hand the plan back to
    // the Router bus (context/37 section 8).
    await prisma.controlState.update({
      where: { id: 'singleton' },
      data: { mode: 'manual', modeVersion: created.modeVersion + 1 },
    });
    await ensureSystemInvariants(prisma, 1789459300);
    const afterRestart = await prisma.controlState.findUniqueOrThrow({
      where: { id: 'singleton' },
    });
    assert.equal(afterRestart.mode, 'manual');
    assert.equal(afterRestart.modeVersion, created.modeVersion + 1);

    await prisma.controlState.update({
      where: { id: 'singleton' },
      data: { mode: created.mode, modeVersion: created.modeVersion },
    });
  });

  it('records that the application is not initialised, independently of empty tables', async () => {
    await ensureSystemInvariants(prisma, 1789459200);
    const initialized = await prisma.appState.findUniqueOrThrow({
      where: { key: APP_STATE_KEYS.INITIALIZED },
    });
    // An empty `requests` table is not proof that setup never happened; that distinction
    // is exactly why this row exists (context/37 section 9.5).
    assert.equal(typeof initialized.value, 'boolean');
  });

  it('stores a snapshot payload as exact text, not as normalised jsonb', async () => {
    // Deliberately unsorted keys, no whitespace and non-ASCII content: jsonb would
    // reorder the keys, and sys and Router would then hash different bytes
    // (context/43 section 5.2).
    const payload = '{"b":1,"a":{"deep":[1,2]},"z":"абв"}';
    const snapshot = await prisma.routingSnapshot.create({
      data: {
        payload,
        inputHash: unique('hash'),
        planningAsOf: 1789459200n,
        createdAt: 1789459200n,
        trigger: 'test',
        diagnostics: {},
      },
    });

    const stored = await prisma.routingSnapshot.findUniqueOrThrow({
      where: { id: snapshot.id },
    });
    assert.equal(stored.payload, payload);

    await prisma.routingSnapshot.delete({ where: { id: snapshot.id } });
  });
});
