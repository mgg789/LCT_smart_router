import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Toast as ToastData } from '../../lib/toasts';
import { Toast } from './Toast';

function toast(over: Partial<ToastData>): ToastData {
  return { id: 't', kind: 'system', title: 'Системное сообщение', durationMs: 4000, ...over };
}

describe('Toast', () => {
  it('shows a notice as a status and an alert as an alert', () => {
    const { rerender } = render(<Toast onClose={() => {}} toast={toast({})} />);
    expect(screen.getByRole('status')).toHaveTextContent('Системное сообщение');

    rerender(
      <Toast onClose={() => {}} toast={toast({ kind: 'alert', title: 'Алёрт: непокрытие' })} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Алёрт: непокрытие');
  });

  it('draws a recalculation with a bar, measured when a share is known', () => {
    render(
      <Toast
        onClose={() => {}}
        toast={toast({ kind: 'progress', title: 'Пересчёт маршрутов', progress: 0.33 })}
      />,
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
  });

  it('does not claim a share nobody knows', () => {
    render(
      <Toast
        onClose={() => {}}
        toast={toast({ kind: 'progress', title: 'Пересчёт маршрутов', progress: null })}
      />,
    );
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  it('closes on the cross and opens on the title when it leads somewhere', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onOpen = vi.fn();
    render(<Toast onClose={onClose} onOpen={onOpen} toast={toast({ title: 'К заявке' })} />);

    await user.click(screen.getByRole('button', { name: 'Закрыть уведомление' }));
    await user.click(screen.getByRole('button', { name: 'К заявке' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
