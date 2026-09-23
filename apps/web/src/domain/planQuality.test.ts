import { describe, expect, it } from 'vitest';
import {
  planQualityAdvice,
  qualityBand,
  reliableDaysOutOfTen,
  unroutedPlanAdvice,
} from './planQuality';

describe('plan quality advice', () => {
  it('uses the documented reliability bands', () => {
    expect(qualityBand(0.9)).toBe('green');
    expect(qualityBand(0.89)).toBe('yellow');
    expect(qualityBand(0.7)).toBe('yellow');
    expect(qualityBand(0.69)).toBe('red');
    expect(reliableDaysOutOfTen(0.74)).toBe(7);
  });

  it('names uncovered work and the riskiest visit before a calm day', () => {
    const tense = planQualityAdvice({
      robustness: 0.74,
      unassignedCount: 3,
      requests: [
        { requestId: 'a', label: 'Заявка на ул. Михайлова', breachProb: 0.52 },
        { requestId: 'b', label: 'Заявка на ул. Окской', breachProb: 0.1 },
      ],
      engineers: [{ name: 'Михаил Орлов', overrunProb: 0.4 }],
    });
    expect(tense.band).toBe('yellow');
    expect(tense.lines[0]).toContain('3 заявок без назначения');
    expect(tense.lines[1]).toContain('52%');
    expect(tense.lines[2]).toContain('Михаил Орлов');

    const calm = planQualityAdvice({
      robustness: 0.96,
      unassignedCount: 0,
      requests: [],
      engineers: [],
    });
    expect(calm.band).toBe('green');
    expect(calm.lines).toEqual([
      'Менять политику не нужно: в большинстве проверок день проходит без опозданий.',
    ]);
  });

  it('does not invent a rehearsal when the plan has no visits', () => {
    const empty = unroutedPlanAdvice({ unassignedCount: 14, rosterOffline: true });
    expect(empty.band).toBe('red');
    expect(empty.summary).toContain('не из чего проверять');
    expect(empty.lines[0]).toContain('14 заявок');
    expect(empty.lines[1]).toContain('не вышли на линию');
  });
});
