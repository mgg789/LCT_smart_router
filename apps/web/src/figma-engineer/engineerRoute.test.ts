import { describe, expect, it } from 'vitest';
import { engineerMapsUrl, equipmentLabel } from './engineerRoute';

describe('engineerMapsUrl', () => {
  it('prefers coordinates for a Yandex driving deep-link', () => {
    expect(engineerMapsUrl({ lat: 55.74, lon: 37.65, addressText: 'ул. Таганская, 24' })).toBe(
      'https://yandex.ru/maps/?rtext=~55.74,37.65&rtt=auto',
    );
  });

  it('falls back to the address when the point is missing', () => {
    expect(engineerMapsUrl({ lat: null, lon: null, addressText: 'ул. Лесная, 7' })).toBe(
      'https://yandex.ru/maps/?rtext=~%D1%83%D0%BB.%20%D0%9B%D0%B5%D1%81%D0%BD%D0%B0%D1%8F%2C%207&rtt=auto',
    );
  });
});

describe('equipmentLabel', () => {
  it('translates the stock kind for the detail chip', () => {
    expect(equipmentLabel('router')).toBe('Роутер');
    expect(equipmentLabel('smart_speaker')).toBe('Умная колонка');
    expect(equipmentLabel(null)).toBeNull();
  });
});
