// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolicyControl } from './DashboardHeaderControls';

afterEach(cleanup);

const noop = () => {};

function renderPanel() {
  return render(
    <PolicyControl
      open
      policyLabel="Ровнее загрузку"
      policies={[{ id: 'balanced', label: 'Ровнее загрузку' }]}
      selectedId="balanced"
      lunchOn={false}
      trafficOn={false}
      metroOn={false}
      equipmentTransfersOn={false}
      strictTimeWindowsOn={false}
      ordinaryReplanningDisabled={false}
      replanningSaving={false}
      onOrdinaryReplanningToggle={noop}
      motionOn={false}
      onToggle={noop}
      onSelect={noop}
      onLunchToggle={noop}
      onTrafficToggle={noop}
      onMetroToggle={noop}
      onEquipmentTransfersToggle={noop}
      onStrictTimeWindowsToggle={noop}
      onManualMode={noop}
    />,
  );
}

describe('policy panel switches and Escape', () => {
  it('lets Escape reach the panel while a switch hint is showing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const closed = vi.fn();
      window.addEventListener('keydown', closed);
      renderPanel();
      const toggle = screen.getByRole('button', { name: /Рассчитать обеды/ });

      // The hint appears after a dwell, which is exactly when a dispatcher reaches for
      // Escape: the pointer or focus is resting on a switch inside the panel they mean
      // to close.
      toggle.focus();
      fireEvent.mouseEnter(toggle);
      await vi.advanceTimersByTimeAsync(900);
      await waitFor(() => expect(toggle.getAttribute('aria-describedby')).not.toBeNull());

      await userEvent.keyboard('{Escape}');
      // The hint takes the key too, but no longer keeps it: both dismiss together.
      await waitFor(() => expect(toggle.getAttribute('aria-describedby')).toBeNull());
      expect(closed).toHaveBeenCalled();
      window.removeEventListener('keydown', closed);
    } finally {
      vi.useRealTimers();
    }
  });
});
