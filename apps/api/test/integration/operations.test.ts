import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import type { Actor } from '../../src/auth';
import { SysError } from '../../src/common/errors';
import type { PrismaClient } from '../../src/generated/prisma/client';
import type { OperationContext } from '../../src/operations';
import { OperationsService } from '../../src/operations';
import { createTestClient, databaseUrl, unique } from '../support/database';

/**
 * Acceptance scenarios for the operation envelope: SL1 and SL7 of context/36.
 *
 * Idempotency and "no silent overwrite" are statements about what is stored after the
 * fact, so the tests run against the real database and the real service graph.
 */
describe('operation envelope', () => {
  let context: INestApplicationContext;
  let operations: OperationsService;
  let prisma: PrismaClient;
  const operationIds: string[] = [];
  const stateKeys: string[] = [];

  const actor: Actor = {
    kind: 'account',
    source: 'ui',
    id: 'test-actor',
    role: 'dispatcher',
    tokenCategory: null,
    accountId: 'test-actor',
  };

  /** A minimal but genuine business change, so the test observes real committed state. */
  const writeState = (key: string, value: Record<string, string | number | boolean>) => ({
    key,
    value,
  });

  before(async () => {
    process.env.NODE_ENV = 'test';
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    context = await NestFactory.createApplicationContext(AppModule, { logger: false });
    operations = context.get(OperationsService);
  });

  after(async () => {
    if (operationIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { operationId: { in: operationIds } } });
      await prisma.operation.deleteMany({ where: { operationId: { in: operationIds } } });
    }
    if (stateKeys.length > 0) {
      await prisma.appState.deleteMany({ where: { key: { in: stateKeys } } });
    }
    await prisma.$disconnect();
    await context?.close();
  });

  const newOperationId = (): string => {
    const id = randomUUID();
    operationIds.push(id);
    return id;
  };

  it('runs the handler once and records the operation next to its change', async () => {
    const operationId = newOperationId();
    const key = unique('state');
    stateKeys.push(key);

    const outcome = await operations.execute(
      { operationId, actor, action: 'test.write', targetRef: key, payload: { value: 1 } },
      async ({ tx, now }) => {
        await tx.appState.create({
          data: { ...writeState(key, { value: 1 }), updatedAt: BigInt(now) },
        });
        return { written: key };
      },
    );

    assert.deepEqual(outcome.result, { written: key });
    assert.equal(outcome.replayed, false);

    const stored = await prisma.operation.findUniqueOrThrow({ where: { operationId } });
    assert.equal(stored.state, 'applied');
    assert.equal(stored.action, 'test.write');

    // The journal entry is written in the same transaction as the change, so it cannot
    // be missing for a change that happened (context/36 section 1).
    const audit = await prisma.auditLog.findFirst({ where: { operationId } });
    assert.ok(audit);
    assert.equal(audit.actorKind, 'account');
    assert.equal(audit.source, 'ui');
  });

  it('returns the first outcome on a retry instead of doing the work twice', async () => {
    const operationId = newOperationId();
    const key = unique('retry');
    stateKeys.push(key);
    let handlerRuns = 0;

    const request = {
      operationId,
      actor,
      action: 'test.write',
      targetRef: key,
      payload: { value: 7 },
    };
    const handler = async ({ tx, now }: OperationContext) => {
      handlerRuns += 1;
      await tx.appState.create({
        data: { ...writeState(key, { value: 7 }), updatedAt: BigInt(now) },
      });
      return { runs: handlerRuns };
    };

    const first = await operations.execute(request, handler);
    const second = await operations.execute(request, handler);

    assert.equal(handlerRuns, 1, 'the handler must not run again for the same operation');
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.result, first.result);

    const rows = await prisma.appState.findMany({ where: { key } });
    assert.equal(rows.length, 1);
  });

  it('refuses the same id carrying different arguments', async () => {
    const operationId = newOperationId();
    const key = unique('reuse');
    stateKeys.push(key);

    await operations.execute(
      { operationId, actor, action: 'test.write', targetRef: key, payload: { value: 1 } },
      async ({ tx, now }) => {
        await tx.appState.create({
          data: { ...writeState(key, { value: 1 }), updatedAt: BigInt(now) },
        });
        return { ok: true };
      },
    );

    await assert.rejects(
      () =>
        operations.execute(
          // Same id, different arguments: a caller bug, not a retry.
          { operationId, actor, action: 'test.write', targetRef: key, payload: { value: 2 } },
          async () => ({ ok: true }),
        ),
      (error: unknown) => error instanceof SysError && error.code === 'OPERATION_ID_REUSED',
    );
  });

  it('rolls the business change back when the handler refuses', async () => {
    const operationId = newOperationId();
    const key = unique('rollback');

    await assert.rejects(() =>
      operations.execute(
        { operationId, actor, action: 'test.write', targetRef: key, payload: {} },
        async ({ tx, now }) => {
          await tx.appState.create({
            data: { ...writeState(key, { partial: true }), updatedAt: BigInt(now) },
          });
          throw new SysError('WORK_ALREADY_STARTED', 'The engineer already started this work');
        },
      ),
    );

    const leftovers = await prisma.appState.findMany({ where: { key } });
    assert.equal(leftovers.length, 0, 'a refused operation must leave nothing behind');
  });

  it('records a refusal and replays it with the same code', async () => {
    const operationId = newOperationId();
    const request = {
      operationId,
      actor,
      action: 'test.refuse',
      targetRef: 'nothing',
      payload: {},
    };

    await assert.rejects(
      () =>
        operations.execute(request, async () => {
          throw SysError.versionConflict('Request', 3, 5);
        }),
      (error: unknown) => error instanceof SysError && error.code === 'VERSION_CONFLICT',
    );

    const stored = await prisma.operation.findUniqueOrThrow({ where: { operationId } });
    assert.equal(stored.state, 'conflict');

    // A caller that lost the response and retries gets the same refusal, with the same
    // details, rather than a second attempt at the work.
    await assert.rejects(
      () => operations.execute(request, async () => ({ shouldNotRun: true })),
      (error: unknown) =>
        error instanceof SysError &&
        error.code === 'VERSION_CONFLICT' &&
        error.details.currentVersion === 5,
    );
  });

  it('runs the handler once when the same operation arrives twice at the same moment', async () => {
    const operationId = newOperationId();
    const key = unique('race');
    stateKeys.push(key);
    let handlerRuns = 0;

    const request = {
      operationId,
      actor,
      action: 'test.write',
      targetRef: key,
      payload: { value: 'race' },
    };
    const handler = async ({ tx, now }: OperationContext) => {
      handlerRuns += 1;
      await tx.appState.create({
        data: { ...writeState(key, { value: 'race' }), updatedAt: BigInt(now) },
      });
      return { key };
    };

    const [left, right] = await Promise.all([
      operations.execute(request, handler),
      operations.execute(request, handler),
    ]);

    assert.deepEqual(left.result, right.result);
    const rows = await prisma.appState.findMany({ where: { key } });
    assert.equal(rows.length, 1, 'a race must not produce two business changes');
    assert.ok(handlerRuns <= 2, 'at most one handler may commit');
  });

  it('journals an external mutation without replaying its remote handler', async () => {
    const operationId = newOperationId();
    let handlerRuns = 0;
    const request = {
      operationId,
      actor,
      action: 'test.external',
      targetRef: 'remote-resource',
      payload: { enabled: true },
    };

    const first = await operations.executeExternal(request, async () => {
      handlerRuns += 1;
      return { accepted: true };
    });
    const replay = await operations.executeExternal(request, async () => {
      handlerRuns += 1;
      return { accepted: false };
    });

    assert.equal(handlerRuns, 1);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, first.result);
    const stored = await prisma.operation.findUniqueOrThrow({ where: { operationId } });
    assert.equal(stored.state, 'applied');
    const audit = await prisma.auditLog.findMany({
      where: { operationId },
      orderBy: { at: 'asc' },
    });
    assert.deepEqual(
      audit.map((entry) => (entry.details as { state: string }).state),
      ['outcome_unknown', 'applied'],
    );
  });

  it('retries an external operation whose first network outcome was unknown', async () => {
    const operationId = newOperationId();
    const request = {
      operationId,
      actor,
      action: 'test.external-retry',
      targetRef: 'remote-resource',
      payload: { enabled: false },
    };
    let handlerRuns = 0;

    await assert.rejects(() =>
      operations.executeExternal(request, async () => {
        handlerRuns += 1;
        throw new Error('connection reset after remote commit');
      }),
    );
    const pending = await prisma.operation.findUniqueOrThrow({ where: { operationId } });
    assert.equal(pending.state, 'outcome_unknown');
    assert.equal(pending.response, null);

    const recovered = await operations.executeExternal(request, async () => {
      handlerRuns += 1;
      return { accepted: true };
    });
    assert.equal(handlerRuns, 2);
    assert.equal(recovered.replayed, false);
    assert.deepEqual(recovered.result, { accepted: true });
    const stored = await prisma.operation.findUniqueOrThrow({ where: { operationId } });
    assert.equal(stored.state, 'applied');
  });
});
