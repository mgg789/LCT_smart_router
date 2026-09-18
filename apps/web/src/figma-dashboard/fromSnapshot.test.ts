import { describe, expect, it } from 'vitest';
import { createDevSnapshot, FOCUS_ENGINEER_ID } from '../fixtures/dev-day';
import {
  dashboardViewFromSnapshot,
  figmaDateLabel,
  nextRouterSettings,
  notificationFromAlert,
  notificationsFromSnapshot,
  policyLabel,
} from './fromSnapshot';

describe('Figma MAIN snapshot mapper', () => {
  it('formats the header date and policy the same way as the live day page', () => {
    expect(figmaDateLabel('2026-09-15')).toBe('15 сентября, 2026');
    expect(policyLabel('fast')).toBe('Быстрее до клиента');
    expect(policyLabel('compact')).toContain('инженеров');
  });

  it('maps demo-day engineers, alerts and the selected request into Figma slots', () => {
    const snapshot = createDevSnapshot();
    const view = dashboardViewFromSnapshot(snapshot, {
      engineerId: FOCUS_ENGINEER_ID,
      requestId: null,
    });
    const alerts = notificationsFromSnapshot(snapshot);

    expect(view.dateLabel).toBe('15 сентября, 2026');
    expect(view.requestCount).toBe(snapshot.requests.length);
    expect(view.engineers.length).toBe(snapshot.engineers.length);
    expect(view.engineers.some((item) => item.id === FOCUS_ENGINEER_ID)).toBe(true);
    expect(view.engineers.some((item) => item.stops.length > 0)).toBe(true);
    expect(view.displayedRequest.number).toMatch(/^Заявка № /);
    expect(view.unassignedTitle).toMatch(/без назначения/);
    expect(alerts.count).toBe(1);
    expect(alerts.items[0]?.text).toContain('навыком');
    expect(notificationFromAlert(snapshot.alerts[0]!).icon).toBe('delay');
  });

  it('keeps other router settings when only lunch or traffic changes', () => {
    const snapshot = createDevSnapshot();
    const next = nextRouterSettings(snapshot, { lunchesEnabled: true, trafficEnabled: true });
    expect(next.lunchesEnabled).toBe(true);
    expect(next.trafficEnabled).toBe(true);
    expect(next.routerContextVersion).toBe(snapshot.routerContextVersion);
    expect(next.accessBufferSec).toBe(600);
  });
});
