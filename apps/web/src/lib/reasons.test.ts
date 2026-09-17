import { describe, expect, it } from 'vitest';
import { factorLabel, modeLabel, reasonDetail } from './reasons';

describe('dispatcher copy', () => {
  it('translates solver reason codes instead of English evidence text', () => {
    expect(reasonDetail('NO_SKILL_MATCH', 'No engineer has the required skill.')).toBe(
      'Нет инженера с нужным навыком.',
    );
    expect(
      reasonDetail('CONSTRAINTS_SATISFIED', 'Skill, transport and schedule constraints verified.'),
    ).toBe('Навык, транспорт и расписание соблюдены.');
    expect(factorLabel('NO_SKILL_MATCH')).toBe('Нет нужного навыка');
  });

  it('keeps a Cyrillic fallback and names control modes in Russian', () => {
    expect(reasonDetail('CUSTOM', 'Нет окна на сегодня')).toBe('Нет окна на сегодня');
    expect(reasonDetail('UNKNOWN_LATIN', 'Constraints verified.')).toBe(
      'Подробности есть в данных расчёта.',
    );
    expect(modeLabel('auto')).toBe('Авто');
    expect(modeLabel('manual')).toBe('Вручную');
  });
});
