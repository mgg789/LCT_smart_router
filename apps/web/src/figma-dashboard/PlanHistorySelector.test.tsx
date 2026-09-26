import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PlanView } from '../api/types';
import { PlanHistorySelector } from './PlanHistorySelector';

const previous: PlanView = {
  revision: 142,
  origin: 'auto',
  planAsOf: 1,
  appliedAt: 1,
  routes: [],
  assignments: [],
};

describe('plan history selector', () => {
  it('shows the two revisions and requires an explicit plan choice', () => {
    const html = renderToStaticMarkup(
      <PlanHistorySelector
        previous={previous}
        currentRevision={143}
        selection="current"
        canRestore
        busy={false}
        motionOn={false}
        anchor={{ left: 900, bottom: 42 }}
        onSelect={vi.fn()}
        onChoose={vi.fn()}
      />,
    );

    expect(html).toContain('До · 142');
    expect(html).toContain('После · 143');
    expect(html).toContain('Выбрать этот');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('data-plan-history-dialog="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html.indexOf('До · 142')).toBeLessThan(html.indexOf('Выбрать этот'));
    expect(html.indexOf('Выбрать этот')).toBeLessThan(html.indexOf('После · 143'));
    expect(html).toContain('left:900px');
    expect(html).toContain('bottom:42px');
  });

  it('does not offer an unavailable predecessor as a selectable plan', () => {
    const html = renderToStaticMarkup(
      <PlanHistorySelector
        previous={previous}
        currentRevision={143}
        selection="previous"
        canRestore={false}
        busy={false}
        motionOn={false}
        restoreUnavailableReason="План уже устарел"
        onSelect={vi.fn()}
        onChoose={vi.fn()}
      />,
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('План уже устарел');
    expect(html).toContain('role="tooltip"');
  });
});
