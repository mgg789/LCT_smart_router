import { describe, expect, it } from 'vitest';
import {
  ENGINEER_PORTRAITS,
  engineerPortrait,
  engineerPortraitIndex,
  usesFemininePortrait,
} from './engineerPortrait';

describe('shared engineer portraits', () => {
  it('recognizes conventional given names in either full-name order without treating surnames as names', () => {
    for (const name of ['Ирина Соколова', 'Соколова Ирина Петровна', 'АННА', 'Мария']) {
      expect(usesFemininePortrait(name)).toBe(true);
      expect(engineerPortraitIndex('stable-id', name)).toBeGreaterThanOrEqual(5);
    }
    for (const name of [
      'Алексей Волков',
      'Илья',
      'Никита',
      'Саша',
      'Бригада 7',
      'Неизвестно',
      'Соколова',
      '',
    ]) {
      expect(usesFemininePortrait(name)).toBe(false);
      expect(engineerPortraitIndex('stable-id', name)).toBeLessThan(5);
    }
  });

  it('keeps the portrait stable across roster reordering and maps the same slot to every surface', () => {
    const engineers = [
      { id: 'a', name: 'Ирина Соколова' },
      { id: 'b', name: 'Алексей Волков' },
    ];
    const before = new Map(
      engineers.map((engineer) => [engineer.id, engineerPortrait(engineer.id, engineer.name)]),
    );
    for (const engineer of [...engineers].reverse()) {
      expect(engineerPortrait(engineer.id, engineer.name)).toBe(before.get(engineer.id));
      expect(engineerPortrait(engineer.id, engineer.name)).toBe(
        ENGINEER_PORTRAITS[engineerPortraitIndex(engineer.id, engineer.name)],
      );
    }
    expect(engineerPortraitIndex('brigade', 'Бригада 5')).toBe(4);
  });
});
