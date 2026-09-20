import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_DISPATCHER_SETTINGS,
  mergeDispatcherSettings,
  moscowMinutesToUnix,
  parseDispatcherSettings,
  toDispatcherSettingsView,
} from '../../src/orchestrator/settings/dispatcher-settings';
import {
  autocompleteQuery,
  hitsFromAutocomplete,
} from '../../src/orchestrator/settings/geocoding.service';

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

describe('LocationIQ autocomplete query', () => {
  it('keeps a messy free-form address as a single q', () => {
    assert.equal(
      autocompleteQuery({ q: 'Проспект маршала жукова 78 4' }),
      'Проспект маршала жукова 78 4',
    );
  });

  it('joins explicit street and city when q is empty', () => {
    assert.equal(autocompleteQuery({ city: 'Москва', street: 'Тверская 1' }), 'Тверская 1, Москва');
  });

  it('reads display_name from an autocomplete payload', () => {
    const hits = hitsFromAutocomplete([
      {
        lat: '55.777',
        lon: '37.456',
        display_name: 'проспект Маршала Жукова, 78 к4, Москва',
      },
    ]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.displayName, 'проспект Маршала Жукова, 78 к4, Москва');
    assert.equal(hits[0]?.lat, 55.777);
  });
});
