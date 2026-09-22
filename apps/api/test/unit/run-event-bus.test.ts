import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Subject } from 'rxjs';
import type { AiRunEvent } from '../../src/ai/runtime/ai-event.types';
import { RunEventBus } from '../../src/ai/runtime/run-event.bus';
import type { RunHandle } from '../../src/ai/runtime/run-registry';
import { FixedClock } from '../../src/common/time';
import { assertNoBigInt } from '../../src/common/time/bigint-boundary';
import type { PrismaService } from '../../src/persistence';

interface StoredEventRow {
  readonly runId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

/** A minimal double for the two Prisma calls `RunEventBus` actually makes. Nothing else
 *  in this codebase fakes `PrismaService` for a unit test -- Prisma-touching logic is
 *  normally exercised against the real database in `test/integration` -- but the bus's
 *  surface here is narrow enough (one `$transaction` of a `create` and an `update`) that
 *  faking it is simpler than standing up a database connection for what is otherwise a
 *  pure sequencing test. */
function fakePrisma(): { prisma: PrismaService; stored: StoredEventRow[] } {
  const stored: StoredEventRow[] = [];
  const prisma = {
    // Real Prisma calls are already invoked (constructing the array element) by the time
    // `$transaction` sees them, so recording synchronously here mirrors that ordering
    // without needing a real thenable/query-builder.
    aiRunEvent: {
      create: (args: { data: StoredEventRow }) => {
        stored.push(args.data);
        return Promise.resolve(args.data);
      },
    },
    aiRun: {
      update: (_args: unknown) => Promise.resolve({}),
    },
    $transaction: async (ops: readonly unknown[]) => Promise.all(ops),
  };
  return { prisma: prisma as unknown as PrismaService, stored };
}

function fakeHandle(runId: string): RunHandle {
  return { runId, abort: new AbortController(), events: new Subject<AiRunEvent>() };
}

describe('run event bus', () => {
  it('assigns a strictly increasing seq per run, starting at 1', async () => {
    const { prisma } = fakePrisma();
    const bus = new RunEventBus(prisma, new FixedClock(1_000));
    const handle = fakeHandle('run-1');

    const first = await bus.emit(handle, {
      type: 'run_started',
      runId: 'run-1',
      conversationId: 'conv-1',
    });
    const second = await bus.emit(handle, { type: 'message_delta', messageId: 'm1', text: 'hi' });
    const third = await bus.emit(handle, {
      type: 'run_finished',
      state: 'completed',
      usage: { promptTokens: 1, completionTokens: 1, costMicros: 1 },
    });

    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(third.seq, 3);
  });

  it('persists every event type except message_delta', async () => {
    const { prisma, stored } = fakePrisma();
    const bus = new RunEventBus(prisma, new FixedClock(1_000));
    const handle = fakeHandle('run-2');

    await bus.emit(handle, { type: 'run_started', runId: 'run-2', conversationId: 'conv-2' });
    await bus.emit(handle, { type: 'message_delta', messageId: 'm1', text: 'partial one' });
    await bus.emit(handle, { type: 'message_delta', messageId: 'm1', text: 'partial two' });
    await bus.emit(handle, {
      type: 'run_finished',
      state: 'completed',
      usage: { promptTokens: 0, completionTokens: 0, costMicros: 0 },
    });

    assert.equal(stored.length, 2);
    assert.deepEqual(
      stored.map((row) => row.type),
      ['run_started', 'run_finished'],
    );
  });

  it('never lets a bigint reach the persisted payload', async () => {
    const { prisma, stored } = fakePrisma();
    const bus = new RunEventBus(prisma, new FixedClock(1_000));
    const handle = fakeHandle('run-3');

    await bus.emit(handle, { type: 'run_started', runId: 'run-3', conversationId: 'conv-3' });

    assert.equal(stored.length, 1);
    assert.doesNotThrow(() => assertNoBigInt(stored[0]?.payload));
  });

  it('multicasts every event, including deltas, to live subscribers', async () => {
    const { prisma } = fakePrisma();
    const bus = new RunEventBus(prisma, new FixedClock(1_000));
    const handle = fakeHandle('run-4');
    const seen: AiRunEvent[] = [];
    handle.events.subscribe((event) => seen.push(event));

    await bus.emit(handle, { type: 'message_delta', messageId: 'm', text: 'x' });
    await bus.emit(handle, { type: 'message_delta', messageId: 'm', text: 'y' });

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.type, 'message_delta');
  });
});
