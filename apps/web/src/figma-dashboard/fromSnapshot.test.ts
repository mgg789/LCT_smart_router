import { describe, expect, it } from 'vitest';
import { createDevSnapshot, FOCUS_ENGINEER_ID } from '../fixtures/dev-day';
import { transportLabel } from '../lib/reasons';
import {
  dashboardViewFromSnapshot,
  figmaDateLabel,
  nextRouterSettings,
  notificationFromAlert,
  notificationsFromSnapshot,
  policyLabel,
  requestUrgency,
  rightPanelMode,
  routeStopAddress,
  withLiveRouteStops,
} from './fromSnapshot';

describe('Figma MAIN snapshot mapper', () => {
  it('formats the header date and policy the same way as the live day page', () => {
    expect(figmaDateLabel('2026-09-15')).toBe('15 сентября, 2026');
    expect(policyLabel('fast')).toBe('Быстрее до клиента');
    expect(policyLabel('compact')).toBe('Дешевле');
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
    const liveCards = withLiveRouteStops(view.engineers, snapshot, null);
    expect(liveCards.find((item) => item.id === FOCUS_ENGINEER_ID)?.stops[0]?.kind).toBe('start');
    expect(
      liveCards.flatMap((item) => item.stops).some((stop) => stop.place === 'Ожидание окна'),
    ).toBe(false);
    expect(
      view.engineers.flatMap((item) => item.stops).some((stop) => stop.place === 'Ожидание окна'),
    ).toBe(false);
    const focused = view.engineers.find((item) => item.id === FOCUS_ENGINEER_ID);
    const focusedLive = snapshot.engineers.find((item) => item.id === FOCUS_ENGINEER_ID);
    expect(focused?.status).toBe(transportLabel(focusedLive?.transportType ?? ''));
    expect(rightPanelMode(FOCUS_ENGINEER_ID, null)).toBe('plan');
    expect(rightPanelMode(FOCUS_ENGINEER_ID, 'req-1')).toBe('request');
    expect(rightPanelMode(null, null)).toBeNull();
    expect(view.totalKm).toBeGreaterThan(0);
    const jobStop = view.engineers
      .find((item) => item.id === FOCUS_ENGINEER_ID)
      ?.stops.find((stop) => stop.requestId);
    expect(jobStop?.place).not.toMatch(/Подключение|Авария|локальн/i);
    expect(routeStopAddress('Город Москва, ул. Международная, д. 28')).toBe(
      'ул. Международная, д. 28',
    );
    expect(requestUrgency({ priority: 'normal', requiredSkill: 'connection' }).label).toBe(
      'Базовая',
    );
    expect(requestUrgency({ priority: 'urgent', requiredSkill: 'connection' }).label).toBe(
      'Срочная',
    );
    expect(requestUrgency({ priority: 'normal', requiredSkill: 'emergency' })).toEqual({
      label: 'Экстренная',
      tone: 'emergency',
    });
    expect(view.displayedRequest.number).toMatch(/^Заявка № \S{1,8}$/);
    expect(view.unassignedTitle).toMatch(/без назначения/);
    expect(alerts.count).toBe(1);
    expect(alerts.items[0]?.text).toContain('навыком');
    const firstAlert = snapshot.alerts[0];
    if (!firstAlert) throw new Error('fixture must include an alert');
    expect(notificationFromAlert(firstAlert).icon).toBe('delay');
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
