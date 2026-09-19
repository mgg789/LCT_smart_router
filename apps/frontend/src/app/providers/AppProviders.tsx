import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { createQueryClient } from './queryClient';

export interface AppProvidersProps {
  children: ReactNode;
}

/** Router and server-state providers shared by every page. */
export function AppProviders({ children }: AppProvidersProps) {
  // Created once per mount so tests get an isolated cache instead of a module-level one.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}
