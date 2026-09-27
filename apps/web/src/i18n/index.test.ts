import { describe, expect, it } from 'vitest';
import { locale, t } from './index';

describe('Russian catalogue', () => {
  it('is ready synchronously for presentation helpers', () => {
    expect(locale).toBe('ru-RU');
    expect(t('common.unassigned', { count: 1 })).toBe('1 заявка без назначения');
  });
  it.each([
    [2, 'заявки'],
    [5, 'заявок'],
    [11, 'заявок'],
    [21, 'заявка'],
    [24, 'заявки'],
  ])('uses Russian plural rules for %s', (count, form) => {
    expect(t('common.unassigned', { count })).toBe(`${count} ${form} без назначения`);
  });
});
