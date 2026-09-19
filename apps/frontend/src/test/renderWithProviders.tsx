import { QueryClient } from '@tanstack/react-query';
import type { RenderOptions, RenderResult } from '@testing-library/react';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { AppProviders } from '@/app/providers/AppProviders';

/**
 * Renders a screen inside the real router and query providers, so tests exercise
 * the same wiring as the app. Retries are off: a test that expects an error
 * should see it immediately instead of waiting out the app's retry delay.
 */
export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppProviders queryClient={queryClient}>{children}</AppProviders>
  );

  return render(ui, { wrapper, ...options });
}
