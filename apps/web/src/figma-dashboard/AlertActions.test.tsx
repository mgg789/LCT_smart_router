import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { AlertView } from '../api/types';
import { createDevSnapshot } from '../fixtures/dev-day';
import { AlertActions } from './AlertActions';

function render(
  actions: string[],
  options: Partial<AlertView> = {},
  disabled = false,
  leadingAction?: ReactNode,
) {
  const alert: AlertView = {
    id: 'alert-test',
    code: 'time_risk',
    kind: 'alert',
    severity: 'warning',
    engineerIds: [],
    requestIds: [],
    reasons: [],
    restoreOption: null,
    createdAt: 100,
    seenAt: 110,
    resolvedAt: null,
    actions,
    ...options,
  };
  return renderToStaticMarkup(
    <AlertActions
      alert={alert}
      snapshot={createDevSnapshot()}
      disabled={disabled}
      leadingAction={leadingAction}
      onResolve={async () => {
        throw new Error('Rendering must not resolve alerts');
      }}
    />,
  );
}

describe('alert resolution choices', () => {
  it('renders every server-provided choice, including the fourth option, with explanations', () => {
    const html = render(['reschedule', 'move_window', 'add_engineer', 'keep_as_is']);
    expect(html.match(/<button /g)).toHaveLength(5);
    for (const label of [
      'На завтра',
      'Сменить окно',
      'Добавить инженера',
      'Оставить как есть',
      'Включить AI',
    ])
      expect(html).toContain(label);
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain('Плюсы:');
    expect(html).toContain('Минусы:');
    expect(html).not.toContain('Снять со смены');
  });
  it('renders request navigation before the decision choices in the compact action row', () => {
    const html = render(
      ['reschedule', 'move_window'],
      {},
      false,
      <button type="button">К заявке</button>,
    );
    expect(html.indexOf('К заявке')).toBeLessThan(html.indexOf('На завтра'));
  });
  it('keeps absent and unknown server actions from becoming fake working buttons', () => {
    expect(render([]).match(/<button /g)).toHaveLength(1);
    const html = render(['future_action', 'extend', 'extend']);
    expect(html.match(/<button /g)).toHaveLength(2);
    expect(html).toContain('требует обновления интерфейса');
  });
  it('disables mutations in cached/demo mode and while AUTO application is pending', () => {
    expect(render(['reschedule', 'move_window'], {}, true).match(/disabled=""/g)).toHaveLength(3);
    const html = render(['keep_manual', 'restore_auto'], { resolutionAction: 'restore_auto' });
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain('Ожидаем применения автоматического плана');
  });
});
