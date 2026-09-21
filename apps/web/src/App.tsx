import { useEffect, useState } from 'react';
import { appSurface } from './appSurface';
import { ClientPage } from './figma-client/ClientPage';
import { EngineerAuthPage } from './figma-dashboard/EngineerAuthPage';
import { MainDashboardPage } from './figma-dashboard/MainDashboardPage';

/** Splits Client App, Engineer App and the dispatcher Dashboard. */
export function App() {
  const [surface, setSurface] = useState(() => appSurface(window.location.pathname));

  useEffect(() => {
    const onPop = () => setSurface(appSurface(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (surface === 'client') return <ClientPage />;
  if (surface === 'engineer') return <EngineerAuthPage />;
  return <MainDashboardPage />;
}
