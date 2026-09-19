import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import { RouteTimeline } from './RouteTimeline';

describe('LIVE timeline history', () => {
  it('keeps technical stops visible when the remaining route disappears', () => {
    const html = renderToStaticMarkup(
      <RouteTimeline
        snapshot={createDevSnapshot()}
        engineerName="Engineer"
        engineerId="engineer"
        route={null}
        history={[]}
        selectedRequestId={null}
        onSelectRequest={() => undefined}
        breaks={[
          {
            id: 'break',
            engineerId: 'engineer',
            startedAt: 100,
            plannedEndAt: 1000,
            endedAt: 1100,
          },
        ]}
      />,
    );
    expect(html).toContain('Тех. перерыв');
    expect(html).toContain('Завершён');
    expect(html).not.toContain('Общий план дня');
  });

  it('orders technical stops chronologically instead of before the route start', () => {
    const snapshot = createDevSnapshot();
    const route = snapshot.plan.plan?.routes[0];
    expect(route).toBeDefined();
    if (!route || route.startAt === null) throw new Error('Fixture requires a route start');
    const html = renderToStaticMarkup(
      <RouteTimeline
        snapshot={snapshot}
        engineerName="Engineer"
        engineerId={route.engineerId}
        route={route}
        history={[]}
        selectedRequestId={null}
        onSelectRequest={() => undefined}
        breaks={[
          {
            id: 'break',
            engineerId: route.engineerId,
            startedAt: route.startAt + 300,
            plannedEndAt: route.startAt + 1200,
            endedAt: null,
          },
        ]}
      />,
    );
    expect(html.indexOf('Старт смены')).toBeLessThan(html.indexOf('Тех. перерыв'));
  });

  it('orders finished visits by factual terminal time and keeps the live position visible', () => {
    const snapshot = createDevSnapshot();
    const [first, second] = snapshot.requests;
    if (!first || !second) throw new Error('Fixture requires two requests');
    const html = renderToStaticMarkup(
      <RouteTimeline
        snapshot={snapshot}
        engineerName="Engineer"
        engineerId="engineer"
        route={null}
        history={[
          {
            request: { ...first, addressText: 'Завершена позже' },
            engineerId: 'engineer',
            stop: null,
            outcome: 'cancelled',
            terminalAt: 2_000,
          },
          {
            request: { ...second, addressText: 'Завершена раньше' },
            engineerId: 'engineer',
            stop: null,
            outcome: 'completed',
            terminalAt: 1_000,
          },
        ]}
        breaks={[]}
        progress={{
          phase: 'traveling',
          anchor: { kind: 'job', requestId: second.id, lat: 55.75, lon: 37.6, at: 1_000 },
          lunch: null,
          next: { kind: 'job', requestId: first.id, lat: 55.76, lon: 37.61, at: 2_000 },
          occurredAt: 1_100,
        }}
        selectedRequestId={null}
        onSelectRequest={() => undefined}
      />,
    );
    expect(html.indexOf('Завершена раньше')).toBeLessThan(html.indexOf('Завершена позже'));
    expect(html).toContain('Текущая позиция');
    expect(html).toContain('В пути к следующей заявке');
    expect(html).toContain(first.addressText);
  });

  it('keeps the shift start until the factual anchor reaches a job', () => {
    const snapshot = createDevSnapshot();
    const route = snapshot.plan.plan?.routes[0];
    if (!route || route.startAt === null) throw new Error('Fixture requires a route start');
    const html = renderToStaticMarkup(
      <RouteTimeline
        snapshot={snapshot}
        engineerName="Engineer"
        engineerId={route.engineerId}
        route={route}
        history={[]}
        breaks={[]}
        progress={{
          phase: 'traveling',
          anchor: {
            kind: 'start',
            requestId: null,
            lat: route.startLat,
            lon: route.startLon,
            at: route.startAt,
          },
          lunch: null,
          next: null,
          occurredAt: route.startAt,
        }}
        selectedRequestId={null}
        onSelectRequest={() => undefined}
      />,
    );
    expect(html).toContain('Старт смены');
  });
});
