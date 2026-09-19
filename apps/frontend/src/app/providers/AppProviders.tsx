import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { createQueryClient } from './queryClient';

export interface AppProvidersProps {
  children: ReactNode;
  /** Supplied by tests so they can turn off retries; the app builds its own. */
  queryClient?: QueryClient;
}

/** Router and server-state providers shared by every page. */
export function AppProviders({ children, queryClient }: AppProvidersProps) {
  // Created once per mount so tests get an isolated cache instead of a module-level one.
  const [fallbackClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient ?? fallbackClient}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}
