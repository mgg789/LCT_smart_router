import { useEffect, useState } from 'react';
import { AiLabPage } from './pages/AiLabPage';
import { ClientApp } from './pages/ClientApp';
import { DashboardPage } from './pages/DashboardPage';
import { EngineerApp } from './pages/EngineerApp';

export type AppRoute = 'engineer' | 'client' | 'ai-lab' | 'dashboard';

/** Splits the app between the dispatcher Dashboard, the Engineer App, the Client App and
 * the `/ai-lab` developer stand, by `window.location.pathname`. A pure function so the
 * route switch itself is unit-testable without touching `window` (see `App.test.ts`). */
export function resolveRoute(pathname: string): AppRoute {
  if (pathname === '/engineer' || pathname.startsWith('/engineer/')) return 'engineer';
  if (pathname === '/client' || pathname.startsWith('/client/')) return 'client';
  if (pathname === '/ai-lab' || pathname.startsWith('/ai-lab/')) return 'ai-lab';
  return 'dashboard';
}

export function App() {
  const [route, setRoute] = useState(() => resolveRoute(window.location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(resolveRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  switch (route) {
    case 'engineer':
      return <EngineerApp />;
    case 'client':
      return <ClientApp />;
    // AiLabPage renders nothing outside a dev build (or VITE_AI_LAB=1) -- it is never
    // linked from any navigation and reachable only by typing this URL.
    case 'ai-lab':
      return <AiLabPage />;
    case 'dashboard':
      return <DashboardPage />;
  }
}
