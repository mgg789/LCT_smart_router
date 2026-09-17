import { describe, expect, it } from 'vitest';
import { createDevSnapshot, FOCUS_REQUEST_ID } from '../fixtures/dev-day';
import { assignmentFor, routeForEngineer } from '../domain/dashboard';
import { explainSelection } from './explanations';

describe('dispatcher explanations', () => {
  it('names the full brigade and explains why this engineer received the job', () => {
    const snapshot = createDevSnapshot();
    const request = snapshot.requests.find((item) => item.id === FOCUS_REQUEST_ID) ?? null;
    const assignment = assignmentFor(snapshot, FOCUS_REQUEST_ID);
    const engineer = snapshot.engineers.find((item) => item.id === assignment?.engineerId) ?? null;
    const route = engineer ? routeForEngineer(snapshot, engineer.id) : null;
    const explanation = explainSelection(snapshot, request, assignment, engineer, route);
    expect(explanation?.title).toBe('Почему Алексей Соколов?');
    expect(explanation?.title).not.toContain('Почему Алексей?');
    expect(explanation?.facts.some((line) => line.includes('подключение'))).toBe(true);
    expect(explanation?.influence.length).toBeGreaterThan(40);
    expect(explanation?.result).toContain('Алексей Соколов');
  });

  it('explains an unassigned video job from missing skill, not a stock phrase', () => {
    const snapshot = createDevSnapshot();
    const request = snapshot.requests.find((item) => item.id === '10490') ?? null;
    const assignment = assignmentFor(snapshot, '10490');
    const explanation = explainSelection(snapshot, request, assignment, null, null);
    expect(explanation?.title).toBe('Почему без назначения');
    expect(explanation?.facts.some((line) => line.includes('10490'))).toBe(true);
    expect(explanation?.influence).toMatch(/навык|умеет|видеонаблюден|video/i);
    expect(explanation?.result).toContain('без назначения');
  });

  it('explains an idle same-zone engineer against leftover work', () => {
    const base = createDevSnapshot();
    const idle = {
      ...base.engineers[0],
      id: 'eng-idle',
      displayName: 'Бригада Восточная 7',
      skills: ['local'],
    };
    const snapshot = {
      ...base,
      engineers: [...base.engineers, idle],
      plan: {
        ...base.plan,
        plan: base.plan.plan
          ? {
              ...base.plan.plan,
              routes: [
                ...base.plan.plan.routes,
                {
                  ...base.plan.plan.routes[0],
                  engineerId: 'eng-idle',
                  assignedCount: 0,
                  distanceKm: 0,
                  travelTimeSec: 0,
                  stops: [],
                  legs: [],
                },
              ],
            }
          : base.plan.plan,
      },
    };
    const explanation = explainSelection(snapshot, null, null, idle, snapshot.plan.plan?.routes.at(-1) ?? null);
    expect(explanation?.title).toBe('Почему Бригада Восточная 7 без заявок');
    expect(explanation?.facts.some((line) => line.includes('0 заявок'))).toBe(true);
    expect(explanation?.result).toContain('простаивает');
  });

  it('explains why the selected route has this order', () => {
    const snapshot = createDevSnapshot();
    const engineer = snapshot.engineers[0];
    const route = routeForEngineer(snapshot, engineer.id);
    const explanation = explainSelection(snapshot, null, null, engineer, route);
    expect(explanation?.title).toContain(engineer.displayName);
    expect(explanation?.facts.some((line) => line.includes('Порядок'))).toBe(true);
    expect(explanation?.result).toMatch(/заявок/);
  });
});
