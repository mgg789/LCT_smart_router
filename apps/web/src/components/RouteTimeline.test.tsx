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
    if (!route) throw new Error('Fixture requires a route');
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
});
