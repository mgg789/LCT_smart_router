import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_DISPATCHER_SETTINGS,
  mergeDispatcherSettings,
  moscowMinutesToUnix,
  parseDispatcherSettings,
  toDispatcherSettingsView,
} from '../../src/orchestrator/settings/dispatcher-settings';
import { parseAddressParts } from '../../src/orchestrator/settings/geocoding.service';

describe('dispatcher settings', () => {
  it('fills missing persisted fields with previous hardcoded defaults', () => {
    const parsed = parseDispatcherSettings({ dayStartMin: 8 * 60 });
    assert.equal(parsed.dayStartMin, 8 * 60);
    assert.equal(parsed.dayEndMin, DEFAULT_DISPATCHER_SETTINGS.dayEndMin);
    assert.equal(parsed.noShowSec, 30 * 60);
    assert.equal(parsed.twogisApiKey, null);
  });

  it('never returns a full map key in the public view', () => {
    const view = toDispatcherSettingsView({
      ...DEFAULT_DISPATCHER_SETTINGS,
      twogisApiKey: 'super-secret-key-1234',
      yandexApiKey: 'yandex-key-abcd',
    });
    assert.equal(view.twogisApiKeySet, true);
    assert.equal(view.twogisApiKeyLast4, '1234');
    assert.equal(view.yandexApiKeyLast4, 'abcd');
    assert.equal(JSON.stringify(view).includes('super-secret'), false);
  });

  it('clears a map key when the patch sends null', () => {
    const next = mergeDispatcherSettings(
      { ...DEFAULT_DISPATCHER_SETTINGS, twogisApiKey: 'keep-me-1234' },
      { twogisApiKey: null },
    );
    assert.equal(next.twogisApiKey, null);
  });

  it('converts Moscow minutes to unix seconds without a host offset', () => {
    assert.equal(moscowMinutesToUnix('2026-08-17', 9 * 60), Date.UTC(2026, 7, 17, 6, 0, 0) / 1000);
  });
});

describe('LocationIQ address parts', () => {
  it('keeps city then street when the city is named first', () => {
    assert.deepEqual(parseAddressParts({ q: 'Москва, Тверская 1' }), {
      city: 'Москва',
      street: 'Тверская 1',
    });
  });

  it('reorders street-first Russian input into structured fields', () => {
    assert.deepEqual(parseAddressParts({ q: 'Тверская 1, Москва' }), {
      city: 'Москва',
      street: 'Тверская 1',
    });
  });

  it('uses explicit city and street without a free-form query', () => {
    assert.deepEqual(parseAddressParts({ city: 'Казань', street: 'Баумана 5' }), {
      city: 'Казань',
      street: 'Баумана 5',
    });
  });
});
