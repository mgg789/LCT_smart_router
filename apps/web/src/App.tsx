import { useEffect, useState } from 'react';
import { EngineerAuthPage } from './figma-dashboard/EngineerAuthPage';
import { MainDashboardPage } from './figma-dashboard/MainDashboardPage';
import { AiLabPage } from './pages/AiLabPage';
import { ClientApp } from './pages/ClientApp';

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
    // The Figma shells are the dispatcher's and the engineer's interface now: the
    // pages these two routes used to open went away with the legacy screens
    // (`refactor(web): remove legacy interface screens`). The client app and the
    // AI lab are untouched by that change and stay where they were.
    case 'engineer':
      return <EngineerAuthPage />;
    case 'client':
      return <ClientApp />;
    // AiLabPage renders nothing outside a dev build (or VITE_AI_LAB=1) -- it is never
    // linked from any navigation and reachable only by typing this URL.
    case 'ai-lab':
      return <AiLabPage />;
    case 'dashboard':
      return <MainDashboardPage />;
  }
}
