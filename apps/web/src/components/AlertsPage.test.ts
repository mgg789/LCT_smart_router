import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import { AlertsPage } from './AlertsPage';

function render(open: boolean, readOnly = false) {
  const snapshot = createDevSnapshot();
  return renderToStaticMarkup(
    createElement(AlertsPage, {
      snapshot: {
        ...snapshot,
        shift: { workDate: snapshot.workDate, closedAt: null, unresolvedCount: open ? 1 : 0 },
        alerts: open
          ? [
              {
                id: 'a',
                code: 'unassigned',
                kind: 'alert',
                severity: 'warning',
                engineerIds: [],
                requestIds: [],
                reasons: ['No eligible crew'],
                restoreOption: null,
                createdAt: 1000,
                seenAt: 1001,
                resolvedAt: null,
                actions: ['reschedule', 'move_window', 'add_engineer'],
              },
            ]
          : [],
      },
      writesDisabled: readOnly,
      onResolve: async () => {},
      onSeen: async () => {},
      onCloseShift: async () => {},
    }),
  );
}

describe('alert decisions screen', () => {
  it('retains read alerts and blocks shift closure, with AI unavailable', () => {
    const html = render(true);
    expect(html).toContain('Заявка не назначена');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Закрыть смену/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Решить с AI/);
    expect(html).not.toContain('>Удалить<');
  });
  it('allows closure with no open alerts only in a writable live contour', () => {
    expect(render(false)).toMatch(/<button(?![^>]*disabled="")[^>]*>Закрыть смену/);
    expect(render(false, true)).toMatch(/<button[^>]*disabled=""[^>]*>Закрыть смену/);
  });
});
