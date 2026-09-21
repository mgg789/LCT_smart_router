import { describe, expect, it } from 'vitest';
import type { EngineerView } from '../api/types';
import { emailChangePending, profileFromSettings, validateEngineerSettings } from './settingsDraft';

const profile: EngineerView = {
  id: 'eng-1',
  version: 3,
  displayName: 'Александра Смирнова',
  inputOrder: 1,
  skills: ['local'],
  transportType: 'car',
  region: 'moscow',
  homeLat: null,
  homeLon: null,
  hasAccount: true,
  email: 'alex@example.com',
};

describe('validateEngineerSettings', () => {
  it('accepts a complete dashboard-style draft', () => {
    expect(
      validateEngineerSettings({
        displayName: 'Александра Смирнова',
        email: 'alex@example.com',
        transportType: 'walk',
      }),
    ).toBeNull();
  });

  it('requires a name and a known transport', () => {
    expect(validateEngineerSettings({ displayName: '  ', email: '', transportType: 'walk' })).toBe(
      'Укажите имя',
    );
    expect(
      validateEngineerSettings({
        displayName: 'Алекс',
        email: '',
        transportType: 'horse',
      }),
    ).toBe('Выберите транспорт');
  });

  it('rejects a broken email and allows an empty one', () => {
    expect(
      validateEngineerSettings({
        displayName: 'Алекс',
        email: 'not-mail',
        transportType: 'car',
      }),
    ).toBe('Проверьте адрес почты');
    expect(
      validateEngineerSettings({
        displayName: 'Алекс',
        email: '',
        transportType: 'car',
      }),
    ).toBeNull();
  });
});

describe('profileFromSettings', () => {
  it('writes name, transport and a new email onto the preview profile', () => {
    const next = profileFromSettings(profile, {
      displayName: '  Саша  ',
      email: 'sasha@beeline.ru',
      transportType: 'bike',
    });
    expect(next.displayName).toBe('Саша');
    expect(next.email).toBe('sasha@beeline.ru');
    expect(next.transportType).toBe('bike');
    expect(next.version).toBe(4);
  });
});

describe('emailChangePending', () => {
  it('detects a different address and ignores matching trim', () => {
    expect(emailChangePending('alex@example.com', 'new@example.com')).toBe(true);
    expect(emailChangePending('alex@example.com', '  alex@example.com  ')).toBe(false);
    expect(emailChangePending(null, '')).toBe(false);
  });
});
