import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RoleProfileService, segmentsFor } from '../../src/ai/tools/role-profile';
import type { Actor } from '../../src/auth';
import { FixedClock } from '../../src/common/time';
import type { PrismaService } from '../../src/persistence';
import { APP_STATE_KEYS } from '../../src/persistence/app-state.keys';

const sessionActor = (role: 'client' | 'engineer' | 'dispatcher'): Actor => ({
  kind: 'account',
  source: 'ui',
  id: 'account-1',
  role,
  tokenCategory: null,
  accountId: 'account-1',
});

/** A minimal double for the one `AppState` row `RoleProfileService` reads and writes. */
function fakePrisma(initial?: string): { prisma: PrismaService; rows: Map<string, string> } {
  const rows = new Map<string, string>();
  if (initial !== undefined) {
    rows.set(APP_STATE_KEYS.AI_DISPATCHER_ASSIST_MODE, initial);
  }
  const prisma = {
    appState: {
      findUnique: ({ where }: { where: { key: string } }) => {
        const value = rows.get(where.key);
        return Promise.resolve(value === undefined ? null : { key: where.key, value });
      },
      upsert: ({ create }: { create: { key: string; value: string } }) => {
        rows.set(create.key, create.value);
        return Promise.resolve(create);
      },
    },
  };
  return { prisma: prisma as unknown as PrismaService, rows };
}

describe('RoleProfileService.forActor', () => {
  it('derives client and engineer profiles from the role alone', async () => {
    const { prisma } = fakePrisma();
    const service = new RoleProfileService(prisma, new FixedClock(1_000));
    assert.equal(await service.forActor(sessionActor('client')), 'client');
    assert.equal(await service.forActor(sessionActor('engineer')), 'engineer');
  });

  it('starts a dispatcher read-only when no assist-mode row exists yet', async () => {
    const { prisma } = fakePrisma();
    const service = new RoleProfileService(prisma, new FixedClock(1_000));
    assert.equal(await service.forActor(sessionActor('dispatcher')), 'dispatcher_readonly');
  });

  it('reads the durable AppState flag, not a conversation, for the dispatcher lane', async () => {
    const { prisma } = fakePrisma('fix');
    const service = new RoleProfileService(prisma, new FixedClock(1_000));
    assert.equal(await service.forActor(sessionActor('dispatcher')), 'dispatcher_fix');
  });

  it('setDispatcherAssistMode changes what forActor returns next, immediately', async () => {
    const { prisma } = fakePrisma('fix');
    const service = new RoleProfileService(prisma, new FixedClock(1_000));
    assert.equal(await service.forActor(sessionActor('dispatcher')), 'dispatcher_fix');
    await service.setDispatcherAssistMode('help');
    assert.equal(await service.forActor(sessionActor('dispatcher')), 'dispatcher_readonly');
  });
});

describe('segmentsFor', () => {
  it('scopes client and engineer to their own segment only', () => {
    assert.deepEqual(segmentsFor('client'), ['client']);
    assert.deepEqual(segmentsFor('engineer'), ['engineer']);
  });

  it('gives both dispatcher lanes every segment', () => {
    assert.deepEqual(segmentsFor('dispatcher_readonly'), ['client', 'engineer', 'dispatcher']);
    assert.deepEqual(segmentsFor('dispatcher_fix'), ['client', 'engineer', 'dispatcher']);
  });
});
