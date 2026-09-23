import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  readRouterPhase,
  resetRouterPhase,
  visibleRouterPhase,
  writeRouterPhase,
} from '../../src/routing/router-gateway/router-phase';

afterEach(() => {
  resetRouterPhase();
});

describe('router phase owned by the system backend', () => {
  it('stays ready until a writer says otherwise', () => {
    assert.equal(readRouterPhase().phase, 'ready');
    assert.equal(visibleRouterPhase(false).phase, 'ready');
  });

  it('shows building while a published task is ahead of the applied plan', () => {
    writeRouterPhase({ phase: 'ready' });
    assert.equal(visibleRouterPhase(true).phase, 'building');
  });

  it('shows a stored error instead of an endless progress bar', () => {
    writeRouterPhase({ phase: 'error', message: 'Нет маршрута' });
    const shown = visibleRouterPhase(true);
    assert.equal(shown.phase, 'error');
    assert.equal(shown.message, 'Нет маршрута');
  });
});
