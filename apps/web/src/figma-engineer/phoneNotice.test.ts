import { describe, expect, it } from 'vitest';
import { isPhoneFailureNotice } from './phoneNotice';

describe('phone failure notice', () => {
  it('keeps a form hint off the banner', () => {
    expect(isPhoneFailureNotice('Заполните ФИО, адрес, точку на карте, окно и почту.')).toBe(false);
    expect(isPhoneFailureNotice(null)).toBe(false);
  });

  it('recognises a timed-out server', () => {
    expect(isPhoneFailureNotice('Сервер не ответил за 12 секунд')).toBe(true);
    expect(isPhoneFailureNotice('Нет связи с сервером')).toBe(true);
  });
});
