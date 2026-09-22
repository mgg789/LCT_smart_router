import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalBuildingAddress,
  canonicalTextAddress,
  isCoordinateAddress,
  isStale,
  moscowMonth,
  moscowMonthBounds,
} from '../../src/orchestrator/passports/passport-policy';

describe('object passport freshness and Moscow points period', () => {
  it('is stale strictly after 45 days, never on the boundary', () => {
    const updatedAt = 1_700_000_000;
    assert.equal(isStale(updatedAt, updatedAt + 45 * 86_400), false);
    assert.equal(isStale(updatedAt, updatedAt + 45 * 86_400 + 1), true);
  });

  it('uses Moscow month boundaries across a UTC month edge', () => {
    const lateUtcJanuary = Date.parse('2026-01-31T22:00:00Z') / 1000;
    assert.equal(moscowMonth(lateUtcJanuary), '2026-02');
    const [start, end] = moscowMonthBounds(lateUtcJanuary);
    assert.equal(new Date(start * 1000).toISOString(), '2026-01-31T21:00:00.000Z');
    assert.equal(new Date(end * 1000).toISOString(), '2026-02-28T21:00:00.000Z');
  });

  it('uses house and street instead of a provider POI or flat display name', () => {
    assert.equal(
      canonicalBuildingAddress({
        house_number: '12',
        road: 'Пресненская наб.',
        city: 'Москва',
        attraction: 'Башня',
      }),
      'москва, пресненская набережная, 12',
    );
    assert.equal(canonicalBuildingAddress({ road: 'Пресненская наб.', city: 'Москва' }), null);
  });

  it('matches apartments and entrances to one building without merging different buildings', () => {
    const first = canonicalTextAddress('Город Москва, ул. Грайвороновская, д. 10 к 2, кв. 15');
    const second = canonicalTextAddress('Москва, Грайвороновская улица, 10 корпус 2, офис 9');
    assert.equal(first, 'москва, грайвороновская улица, 10к2');
    assert.equal(first, second);
    assert.equal(
      first,
      canonicalBuildingAddress({
        city: 'Москва',
        road: 'Грайвороновская улица',
        house_number: '10к2',
      }),
    );
    assert.notEqual(first, canonicalTextAddress('Москва, ул. Грайвороновская, д. 10 к 3'));
    assert.notEqual(first, canonicalTextAddress('Москва, ул. Грайвороновская, д. 10 стр. 2'));
    assert.notEqual(first, canonicalTextAddress('Казань, ул. Грайвороновская, д. 10 к 2'));
  });

  it('does not mistake a numbered street or map coordinates for a house', () => {
    assert.equal(
      canonicalTextAddress('Город Москва, ул.3-я Институтская, д. 5 к 2'),
      'москва, 3-я институтская улица, 5к2',
    );
    assert.equal(canonicalTextAddress('55.750000, 37.620000'), null);
    assert.equal(canonicalTextAddress('Москва, Таганская улица'), null);
    assert.equal(isCoordinateAddress('Точка на карте: 55.750000, 37.620000'), true);
    assert.equal(isCoordinateAddress('Москва, ул. Таганская, д. 24'), false);
    assert.equal(canonicalBuildingAddress({ road: 'Ленина', house_number: '1' }), null);
  });
});
