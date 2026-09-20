import { afterEach, describe, expect, it } from 'vitest';
import {
  addSessionOffice,
  addSessionRegion,
  officesForRegion,
  regionIdFromLabel,
  resetAddedEntities,
  selectableRegions,
  validateAlertDraft,
  validateEngineerDraft,
  validateOfficeDraft,
  validateRegionDraft,
  validateRequestDraft,
  windowFromClocks,
} from './addEntity';

afterEach(() => {
  resetAddedEntities();
});

describe('addEntity catalog helpers', () => {
  it('slugs a region title without inventing latin', () => {
    expect(regionIdFromLabel('Северный округ')).toBe('северный_округ');
  });

  it('rejects an inverted time window', () => {
    expect(windowFromClocks('2026-09-19', '14:00', '11:00')).toBe(
      'Окно должно заканчиваться позже начала',
    );
  });

  it('builds a moscow window from clocks', () => {
    const window = windowFromClocks('2026-09-19', '09:00', '12:00');
    expect(window).toEqual({ windowStartAt: 1789797600, windowEndAt: 1789808400 });
  });

  it('requires the request fields the form collects', () => {
    expect(
      validateRequestDraft({
        workType: 'connection_request',
        addressText: 'Таганская, 24',
        startClock: '09:00',
        endClock: '11:00',
      }),
    ).toBeNull();
    expect(
      validateRequestDraft({
        workType: 'unknown',
        addressText: 'Таганская, 24',
        startClock: '09:00',
        endClock: '11:00',
      }),
    ).toBe('Выберите тип заявки');
  });

  it('keeps engineer email optional but checks the shape', () => {
    const base = {
      displayName: 'Иван Петров',
      skills: ['connection'],
      transportType: 'car',
      region: 'east',
      officeId: 'office-1',
      email: '',
    };
    expect(validateEngineerDraft(base)).toBeNull();
    expect(validateEngineerDraft({ ...base, officeId: '' })).toBeNull();
    expect(validateEngineerDraft({ ...base, email: 'not-mail' })).toBe('Проверьте адрес почты');
    expect(validateEngineerDraft({ ...base, skills: [] })).toBe('Выберите хотя бы один навык');
  });

  it('stores a region and office for the engineer picker', () => {
    const region = addSessionRegion('Северный округ');
    addSessionOffice(region.id, 'Дмитровское шоссе, 1');
    expect(officesForRegion(region.id)).toHaveLength(1);
    expect(selectableRegions(null).map((item) => item.id)).toContain(region.id);
    expect(validateRegionDraft('')).toBe('Укажите название региона');
    expect(validateOfficeDraft('', 'улица')).toBe('Выберите регион привязки');
  });

  it('requires an alert title, type and reason', () => {
    expect(validateAlertDraft({ title: 'Риск SLA', type: 'sla', reason: 'три срочные' })).toBeNull();
    expect(validateAlertDraft({ title: '', type: 'sla', reason: 'три срочные' })).toBe(
      'Укажите название',
    );
  });
});
