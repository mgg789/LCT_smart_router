import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuditService } from '../../src/operations/audit.service';
import type { PrismaService } from '../../src/persistence';

describe('AuditService.actorsFor', () => {
  it('reads the journal and keeps the earliest actor of each operation', async () => {
    const seen: unknown[] = [];
    const prisma = {
      auditLog: {
        findMany: async (query: unknown) => {
          seen.push(query);
          return [
            {
              operationId: 'op-1',
              actorKind: 'dispatcher',
              actorId: 'human-1',
              source: 'ui',
              action: 'request.cancel',
              at: 10n,
            },
            {
              operationId: 'op-1',
              actorKind: 'dispatcher',
              actorId: 'later',
              source: 'ui',
              action: 'request.cancel',
              at: 11n,
            },
            {
              operationId: null,
              actorKind: 'system',
              actorId: null,
              source: 'system',
              action: 'ignored',
              at: 12n,
            },
          ];
        },
      },
    } as unknown as PrismaService;
    const actors = await new AuditService(prisma).actorsFor(['op-1', 'op-1', '']);
    assert.equal(seen.length, 1);
    assert.deepEqual(actors.get('op-1'), {
      actorKind: 'dispatcher',
      actorId: 'human-1',
      source: 'ui',
      action: 'request.cancel',
    });
    assert.equal(actors.size, 1);
  });

  it('does not query when there is no operation id', async () => {
    let calls = 0;
    const prisma = {
      auditLog: {
        findMany: async () => {
          calls += 1;
          return [];
        },
      },
    } as unknown as PrismaService;
    const actors = await new AuditService(prisma).actorsFor(['', '']);
    assert.equal(calls, 0);
    assert.equal(actors.size, 0);
  });
});
