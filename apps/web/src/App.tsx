import { useEffect, useState } from 'react';
import { EngineerAuthPage } from './figma-dashboard/EngineerAuthPage';
import { MainDashboardPage } from './figma-dashboard/MainDashboardPage';

function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export function App() {
  const path = usePathname();
  if (path === '/engineer' || path.startsWith('/engineer/')) {
    return <EngineerAuthPage />;
  }
  return <MainDashboardPage />;
}
