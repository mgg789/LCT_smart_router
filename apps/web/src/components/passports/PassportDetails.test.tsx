import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ObjectPassport } from '../../api/passports';
import { MonthlyPoints } from './MonthlyPoints';
import { PassportDetails } from './PassportDetails';
import { PassportOffer } from './PassportOffer';

const passport: ObjectPassport = {
  id: 'building-1',
  address: 'Москва, Таганская улица, 24',
  connectionType: 'fiber',
  difficulty: 3,
  equipment: 'Оптический терминал',
  accessNotes: 'Вход со двора',
  comment: '<script>bad()</script>',
  updatedAt: 1789948800,
  stale: false,
};

describe('passport views', () => {
  it('shows building facts and date without offering editing of an existing passport', () => {
    const html = renderToStaticMarkup(<PassportDetails passport={passport} />);
    expect(html).toContain('Паспорт объекта');
    expect(html).toContain('Оптика');
    expect(html).toContain('3 из 3');
    expect(html).toContain('Вход со двора');
    expect(html).toContain('Заполнен');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<button');
  });
  it('marks an outdated date in red with a textual status', () => {
    const html = renderToStaticMarkup(<PassportDetails passport={{ ...passport, stale: true }} />);
    expect(html).toContain('text-figma-cancel');
    expect(html).toContain('устарел');
  });
  it('never offers points or invents a zero total before the server responds', () => {
    expect(renderToStaticMarkup(<PassportOffer token="test" requestId="r1" />)).toBe('');
    const html = renderToStaticMarkup(<MonthlyPoints token="test" />);
    expect(html).toContain('—');
    expect(html).not.toContain('>0');
  });
});
