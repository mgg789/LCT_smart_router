import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AlertResolutionProposal } from '../api/ai';
import { createDevSnapshot } from '../fixtures/dev-day';
import { AlertsPage } from './AlertsPage';

type AiResolve = (
  alertId: string,
) => Promise<AlertResolutionProposal | { refused: true; why: string }>;

function render(
  open: boolean,
  options: { readonly readOnly?: boolean; readonly onAiResolve?: AiResolve } = {},
) {
  const { readOnly = false, onAiResolve } = options;
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
      ...(onAiResolve ? { onAiResolve } : {}),
    }),
  );
}

describe('alert decisions screen', () => {
  it('retains read alerts and blocks shift closure', () => {
    const html = render(true);
    expect(html).toContain('Заявка не назначена');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Закрыть смену/);
    expect(html).not.toContain('>Удалить<');
  });

  it('allows closure with no open alerts only in a writable live contour', () => {
    expect(render(false)).toMatch(/<button(?![^>]*disabled="")[^>]*>Закрыть смену/);
    expect(render(false, { readOnly: true })).toMatch(/<button[^>]*disabled=""[^>]*>Закрыть смену/);
  });

  it('disables AI resolution without a proposal source (demo or cached contour)', () => {
    const html = render(true);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Решить с AI/);
  });

  it('enables AI resolution when the assistant can propose and writes are allowed', () => {
    const html = render(true, {
      onAiResolve: async () => ({ refused: true, why: 'нет данных' }),
    });
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>Решить с AI/);
  });

  it('disables AI resolution on a read-only contour, since it must not trigger a paid call', () => {
    const html = render(true, {
      readOnly: true,
      onAiResolve: async () => ({ refused: true, why: 'нет данных' }),
    });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Решить с AI/);
  });
});
