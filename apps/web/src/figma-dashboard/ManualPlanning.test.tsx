import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

import { demoScenarios, recordedScenario } from '../demo/scenarios';
import {
  ManualFeaturePresentation,
  ManualPlanningProvider,
  ManualRequestControls,
} from './ManualPlanning';

it('shows online-only assignment and original window in manual mode, preserving started facts', () => {
  vi.stubGlobal('window', { innerWidth: 1920, innerHeight: 1080 });
  const id = demoScenarios[0]?.id;
  if (!id) throw new Error('Fixture missing');
  const snapshot = recordedScenario(id).snapshot;
  const request = snapshot.requests[0];
  if (!request) throw new Error('Request fixture missing');
  const manual = {
    ...snapshot,
    plan: { ...snapshot.plan, mode: 'manual' as const },
    requests: [{ ...request, lifecycle: 'submitted' as const, startedAt: null }],
  };
  const render = (startedAt: number | null) =>
    renderToStaticMarkup(
      <ManualPlanningProvider
        token={null}
        snapshot={{
          ...manual,
          requests: [{ ...request, lifecycle: 'submitted' as const, startedAt }],
        }}
        refresh={async () => {}}
      >
        <ManualRequestControls requestId={request.id} />
      </ManualPlanningProvider>,
    );
  expect(render(null)).toContain('Нет исполнителя');
  expect(render(null)).toContain('Исходное окно');
  expect(render(snapshot.nowAt)).not.toContain('Ручной исполнитель');
});

it('presents four manual capabilities and conflict handling after activation', () => {
  const html = renderToStaticMarkup(<ManualFeaturePresentation />);
  for (const label of ['Назначения.', 'Окна заявок.', 'Обеды.', 'Смены.', 'Конфликт приоритетов'])
    expect(html).toContain(label);
});
