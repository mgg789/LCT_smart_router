import type { RenderOptions, RenderResult } from '@testing-library/react';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AppProviders } from '@/app/providers/AppProviders';

/**
 * Renders a screen inside the real router and query providers, so tests exercise
 * the same wiring as the app. Each call gets its own query cache.
 */
export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  return render(ui, { wrapper: AppProviders, ...options });
}
