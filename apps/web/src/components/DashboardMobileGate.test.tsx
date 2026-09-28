// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DashboardMobileGate } from './DashboardMobileGate';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function viewport(narrow: boolean) {
  const media = new EventTarget();
  const query = Object.assign(media, { matches: narrow });
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return (next: boolean) =>
    act(() => {
      query.matches = next;
      query.dispatchEvent(new Event('change'));
    });
}

it('requires explicit acceptance on phones and retains it across resize', () => {
  const resize = viewport(true);
  render(
    <DashboardMobileGate>
      <div>Dashboard content</div>
    </DashboardMobileGate>,
  );
  expect(screen.queryByText('Dashboard content')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Всё равно открыть' }));
  expect(screen.getByText('Dashboard content')).toBeTruthy();
  resize(false);
  resize(true);
  expect(screen.queryByRole('button')).toBeNull();
});

it('opens on wider screens without a warning', () => {
  viewport(false);
  render(
    <DashboardMobileGate>
      <div>Dashboard content</div>
    </DashboardMobileGate>,
  );
  expect(screen.getByText('Dashboard content')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
