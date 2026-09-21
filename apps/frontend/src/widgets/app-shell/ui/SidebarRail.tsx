import { NavLink } from 'react-router-dom';
import { cn } from '@/shared/lib';
import { Logo } from '@/shared/ui';
import { NAV_ITEMS } from '../model/navItems';

/**
 * Left rail of the dashboard: the mark, then seven sections.
 *
 * Geometry is measured off the mockup frame, which is drawn at 1:1 here (unlike
 * the sign-in frame): rail 149px wide, item box 109×74 on an 84px pitch, icon at
 * 14px from the item top, label 16px below it.
 */
export function SidebarRail() {
  return (
    <nav
      aria-label="Разделы"
      className="flex w-[149px] shrink-0 flex-col items-center rounded-r-2xl bg-surface pt-[30px]"
    >
      <Logo className="text-ink" markOnly size={47} />

      <ul className="mt-[31px] flex flex-col gap-[10px]">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              className={({ isActive }) =>
                cn(
                  'flex h-[74px] w-[109px] flex-col items-center rounded-2xl pt-[14px]',
                  'transition-colors duration-150',
                  isActive ? 'bg-ink text-white' : 'text-ink hover:bg-muted',
                )
              }
              to={item.to}
            >
              <item.icon aria-hidden size={24} />
              <span className="mt-[4px] text-[16px] leading-tight">{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
