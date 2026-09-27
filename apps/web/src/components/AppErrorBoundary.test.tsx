// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from './AppErrorBoundary';

beforeEach(() => {
  // React itself reports intentional test exceptions to its development console.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('renders healthy children and does not show recovery controls', () => {
  render(
    <AppErrorBoundary>
      <p>Приложение работает</p>
    </AppErrorBoundary>,
  );
  expect(screen.getByText('Приложение работает')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('contains a child render error without exposing private exception details', () => {
  function Broken(): never {
    throw new Error('customer@example.test secret-stack');
  }
  render(
    <AppErrorBoundary>
      <Broken />
    </AppErrorBoundary>,
  );
  expect(screen.getByRole('alert').getAttribute('aria-labelledby')).toBe('app-error-title');
  expect(screen.getByRole('button', { name: 'Попробовать снова' })).toBeTruthy();
  expect(screen.queryByText(/customer@example/)).toBeNull();
  expect(console.error).toHaveBeenCalledWith('UI_RENDER_FAILURE');
});

it('remounts successfully on a user retry and does not automatically loop on another error', () => {
  let broken = true;
  let renders = 0;
  function Child() {
    renders += 1;
    if (broken) throw new Error('render failed');
    return <p>Восстановлено</p>;
  }
  render(
    <AppErrorBoundary>
      <Child />
    </AppErrorBoundary>,
  );
  const failedRenders = renders;
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(renders).toBe(failedRenders);
  fireEvent.click(screen.getByRole('button', { name: 'Попробовать снова' }));
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(renders).toBeGreaterThan(failedRenders);
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: 'Попробовать снова' }));
  expect(screen.getByText('Восстановлено')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('offers an explicit reload without making network reports', () => {
  function Broken(): never {
    throw new Error('render failed');
  }
  const reloadPage = vi.fn();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  render(
    <AppErrorBoundary reloadPage={reloadPage}>
      <Broken />
    </AppErrorBoundary>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Перезагрузить страницу' }));
  expect(reloadPage).toHaveBeenCalledTimes(1);
  expect(fetchSpy).not.toHaveBeenCalled();
});
