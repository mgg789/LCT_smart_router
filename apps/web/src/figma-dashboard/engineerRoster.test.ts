import { describe, expect, it } from 'vitest';
import { createDevSnapshot, FOCUS_ENGINEER_ID } from '../fixtures/dev-day';
import { moscowAt } from '../lib/time';
import {
  engineerActivity,
  engineerOfficeLabel,
  engineerPhotoIndex,
  engineerProfilesFromSnapshot,
  engineerTransportLabel,
  isPlausibleEmail,
  skillChipLabel,
} from './engineerRoster';
import { resetAddedEntities } from './addEntity';

describe('engineerRoster', () => {
  it('maps skills as title-case chips and keeps email shape checks', () => {
    expect(skillChipLabel('connection')).toBe('Подключение');
    expect(skillChipLabel('local')).toBe('Локальные работы');
    expect(engineerTransportLabel('car')).toBe('Легковой, до 3.5 т');
    expect(engineerPhotoIndex('east-team-01', 3, 'Бригада 1')).toBe(0);
    expect(engineerPhotoIndex('east-team-05', 3, 'Бригада 5')).toBe(1);
    expect(engineerPhotoIndex('same-id', 3, 'Алексей Соколов')).toBe(
      engineerPhotoIndex('same-id', 3, 'Алексей Соколов'),
    );
    expect(isPlausibleEmail('alex@test.com')).toBe(true);
    expect(isPlausibleEmail('not-mail')).toBe(false);
    resetAddedEntities();
    expect(engineerOfficeLabel('moscow')).toBe('Москва');
  });

  it('builds a cyclic roster and leaves the right pane empty without a live job', () => {
    const snapshot = createDevSnapshot();
    const roster = engineerProfilesFromSnapshot(snapshot);
    expect(roster.length).toBe(snapshot.engineers.length);
    expect(roster.map((item) => item.id)).toEqual(
      [...snapshot.engineers]
        .sort((left, right) => left.inputOrder - right.inputOrder)
        .map((item) => item.id),
    );
    const idle = roster.find((item) => item.id !== FOCUS_ENGINEER_ID);
    expect(idle).toBeTruthy();
  });

  it('writes lunch or a technical break into the right pane, never a blank placeholder', () => {
    const snapshot = createDevSnapshot();
    const lunchAt = moscowAt(snapshot.workDate, 13, 10);
    const lunch = engineerActivity(
      {
        ...snapshot,
        nowAt: lunchAt,
        engineers: snapshot.engineers.map((item) =>
          item.id === FOCUS_ENGINEER_ID
            ? {
                ...item,
                day: item.day
                  ? {
                      ...item.day,
                      lunch: {
                        ...item.day.lunch,
                        enabled: true,
                        taken: false,
                        startedAt: lunchAt - 60,
                        windowEndAt: lunchAt + 1800,
                      },
                    }
                  : item.day,
              }
            : item,
        ),
      },
      FOCUS_ENGINEER_ID,
      lunchAt,
    );
    expect(lunch.kind).toBe('lunch');

    const paused = engineerActivity(
      {
        ...snapshot,
        engineers: snapshot.engineers.map((item) =>
          item.id === FOCUS_ENGINEER_ID && item.day
            ? { ...item, day: { ...item.day, availability: 'technical_break', expectedOnlineAt: lunchAt } }
            : item,
        ),
      },
      FOCUS_ENGINEER_ID,
      snapshot.nowAt,
    );
    expect(paused).toEqual({
      kind: 'break',
      title: 'Технический перерыв',
      untilClock: '13:10',
    });
  });
});
