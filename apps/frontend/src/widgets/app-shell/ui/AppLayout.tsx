import { Outlet } from 'react-router-dom';
import { AppHeader } from './AppHeader';
import { SidebarRail } from './SidebarRail';

/**
 * Frame every dispatcher screen sits in: rail on the left, header on top, the
 * section itself in the remaining area. Gutters are the mockup's: 31px from the
 * rail to the content, 34px to the right edge.
 */
export function AppLayout() {
  return (
    <div className="flex h-full bg-canvas">
      <SidebarRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader />
        <main className="min-h-0 flex-1 overflow-auto pr-[34px] pb-8 pl-[31px]">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
