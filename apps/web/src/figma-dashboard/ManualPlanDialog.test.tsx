import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import { ManualPlanDialog } from './ManualPlanDialog';

vi.mock('./artboardScale', () => ({
  useArtboardScale: () => 1,
  useLetterboxInsets: () => ({ x: 0, y: 0 }),
}));

describe('manual control dialog', () => {
  const render = (mode: 'auto' | 'manual', action: 'auto' | 'manual' = 'manual') => {
    const snapshot = createDevSnapshot();
    return renderToStaticMarkup(
      <ManualPlanDialog
        snapshot={{ ...snapshot, plan: { ...snapshot.plan, mode } }}
        token="local-test-session"
        action={action}
        motionOn={false}
        onMode={vi.fn()}
        onApply={vi.fn()}
        onRefresh={async () => snapshot}
        onClose={vi.fn()}
      />,
    );
  };

  it('requires a reason and offers cancellation before entering MANUAL', () => {
    const html = render('auto');
    expect(html).toContain('Причина перехода');
    expect(html).toMatch(/disabled=""[^>]*>Включить MANUAL/);
    expect(html).toContain('Отмена');
    expect(html).not.toContain('Проверить переназначение');
  });

  it('shows queue controls and honest timing once MANUAL is active', () => {
    const html = render('manual');
    expect(html).toContain('Очередь неначатых заявок');
    expect(html).toContain('Проверить переназначение');
    expect(html).toContain('не пересчитаны');
    expect(html).toContain('Журнал ручного управления');
  });

  it('requires an explicit AUTO confirmation without asking for a fake manual reason', () => {
    const html = render('manual', 'auto');
    expect(html).toContain('Подтвердить AUTO');
    expect(html).toContain('текущий план останется видимым');
    expect(html).not.toContain('Причина перехода');
  });
});
