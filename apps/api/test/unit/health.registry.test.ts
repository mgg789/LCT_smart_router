import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HealthRegistry } from '../../src/common/health/health.registry';

describe('health registry', () => {
  it('reports a declared but unwired integration honestly', async () => {
    const registry = new HealthRegistry();
    registry.registerNotConfigured('smtp', 'out of scope');
    assert.deepEqual(await registry.checkAll(), {
      smtp: { status: 'not_configured', detail: 'out of scope' },
    });
  });

  it('lets a real probe take over the placeholder name', async () => {
    const registry = new HealthRegistry();
    registry.registerNotConfigured('router', 'not wired');
    registry.register('router', { required: false, check: () => ({ status: 'ok' }) });
    const all = await registry.checkAll();
    assert.deepEqual(all.router, { status: 'ok' });
  });

  it('turns a throwing probe into a down status instead of failing the endpoint', async () => {
    const registry = new HealthRegistry();
    registry.register('db', {
      required: true,
      check: () => {
        throw new Error('connection refused');
      },
    });
    const required = await registry.checkRequired();
    assert.deepEqual(required.db, { status: 'down', detail: 'connection refused' });
  });

  it('readiness looks only at required probes', async () => {
    const registry = new HealthRegistry();
    registry.register('db', { required: true, check: () => ({ status: 'ok' }) });
    registry.registerNotConfigured('ai', 'out of scope');
    assert.deepEqual(Object.keys(await registry.checkRequired()), ['db']);
  });
});
