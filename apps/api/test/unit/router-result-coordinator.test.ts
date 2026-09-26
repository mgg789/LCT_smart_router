import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type RouterResult,
  routerResultSchema,
} from '../../src/routing/router-gateway/result.types';
import type { AcceptanceOutcome } from '../../src/routing/router-gateway/result-acceptance.service';
import type { RouterResultStatus } from '../../src/routing/router-gateway/router-client.port';
import { RouterClient } from '../../src/routing/router-gateway/router-client.port';
import { RouterResultCoordinator } from '../../src/routing/router-gateway/router-result-coordinator';

function result(status: 'pending' | 'ready' | 'error', id: string | null): RouterResult {
  return {
    schema_version: '1.0',
    status,
    result_id: id,
    input_publication_id: status === 'pending' ? null : 'publication-1',
    input_hash: status === 'pending' ? null : 'a'.repeat(64),
    planning_as_of: status === 'pending' ? null : 1,
    computed_at: status === 'pending' ? null : 2,
    router_context_version: status === 'pending' ? null : 'ctx-1',
    main: null,
    baseline: null,
    errors:
      status === 'error'
        ? [{ code: 'ROUTER_FAILED', message: 'failed', field_path: null, entity_id: null }]
        : [],
  };
}

class SequenceClient extends RouterClient {
  resultReads = 0;
  contextReads = 0;
  private readonly status: (() => Promise<RouterResultStatus>) | null;

  constructor(
    private readonly next: () => Promise<RouterResult>,
    status?: () => Promise<RouterResultStatus>,
  ) {
    super();
    this.status = status ?? null;
  }

  /** The real transport polls a cheap status endpoint without taking the result
   *  package; when the test supplies no status channel, the port's own default
   *  (one full read) stands in. */
  override async getResultStatus(): Promise<RouterResultStatus> {
    if (this.status) {
      return this.status();
    }
    return super.getResultStatus();
  }

  async getResult(): Promise<RouterResult> {
    this.resultReads += 1;
    return this.next();
  }

  async getActiveContextVersion(): Promise<string | null> {
    this.contextReads += 1;
    return 'ctx-1';
  }

  isConfigured(): boolean {
    return true;
  }
}

describe('RouterResultCoordinator', () => {
  it('ignores pending and sends each completed result to acceptance once', async () => {
    const queue = [result('ready', 'result-1'), result('error', 'result-2')];
    const statusQueue = [result('pending', null), result('ready', 'result-1')];
    const client = new SequenceClient(
      async () => queue.shift() ?? result('error', 'result-2'),
      async () => statusQueue.shift() ?? result('error', 'result-2'),
    );
    const accepted: string[] = [];
    const coordinator = new RouterResultCoordinator(
      client,
      {
        accept: async (value): Promise<AcceptanceOutcome> => {
          const parsed = routerResultSchema.parse(value);
          accepted.push(parsed.result_id ?? 'none');
          return { accepted: parsed.status === 'ready', resultId: parsed.result_id };
        },
      },
      1_000,
    );

    await coordinator.pollOnce();
    await coordinator.pollOnce();
    await coordinator.pollOnce();
    await coordinator.pollOnce();

    assert.deepEqual(accepted, ['result-1', 'result-2']);
    assert.equal(client.contextReads, 2);
  });

  it('coalesces overlapping polls into one in-flight read', async () => {
    let release: ((value: RouterResult) => void) | undefined;
    const client = new SequenceClient(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const coordinator = new RouterResultCoordinator(
      client,
      { accept: async () => ({ accepted: true }) },
      1_000,
    );

    const first = coordinator.pollOnce();
    const second = coordinator.pollOnce();
    assert.equal(first, second);
    assert.equal(client.resultReads, 1);
    assert.ok(release);
    release(result('pending', null));
    await first;
  });

  it('retries the same result after a transient acceptance failure', async () => {
    const client = new SequenceClient(
      async () => result('ready', 'retry-result'),
      async () => result('ready', 'retry-result'),
    );
    let attempts = 0;
    const coordinator = new RouterResultCoordinator(
      client,
      {
        accept: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('database unavailable');
          }
          return { accepted: true };
        },
      },
      1_000,
    );

    await coordinator.pollOnce();
    await coordinator.pollOnce();

    assert.equal(attempts, 2);
  });

  it('retries a result that was held back by temporary manual mode', async () => {
    const client = new SequenceClient(async () => result('ready', 'manual-held-result'));
    let attempts = 0;
    const coordinator = new RouterResultCoordinator(
      client,
      {
        accept: async () => {
          attempts += 1;
          return attempts === 1 ? { accepted: false, reason: 'MODE_MANUAL' } : { accepted: true };
        },
      },
      1_000,
    );

    await coordinator.pollOnce();
    await coordinator.pollOnce();

    assert.equal(attempts, 2);
  });

  it('survives a transient Router read failure and retries', async () => {
    let statusAttempts = 0;
    const client = new SequenceClient(
      async () => result('ready', 'after-network-retry'),
      async () => {
        statusAttempts += 1;
        if (statusAttempts === 1) {
          throw new Error('connection refused');
        }
        return result('ready', 'after-network-retry');
      },
    );
    let accepted = 0;
    const coordinator = new RouterResultCoordinator(
      client,
      {
        accept: async () => {
          accepted += 1;
          return { accepted: true };
        },
      },
      1_000,
    );

    await coordinator.pollOnce();
    await coordinator.pollOnce();

    assert.equal(statusAttempts, 2);
    assert.equal(accepted, 1);
  });
});
