import { useEffect, useState } from 'react';
import { EngineerAuthPage } from './figma-dashboard/EngineerAuthPage';
import { MainDashboardPage } from './figma-dashboard/MainDashboardPage';

/** Splits the dispatcher Dashboard from the Engineer App on `/engineer`. */
export function App() {
  const [engineer, setEngineer] = useState(() => isEngineerPath(window.location.pathname));

  useEffect(() => {
    const onPop = () => setEngineer(isEngineerPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return engineer ? <EngineerAuthPage /> : <MainDashboardPage />;
}

function isEngineerPath(pathname: string): boolean {
  return pathname === '/engineer' || pathname.startsWith('/engineer/');
}
