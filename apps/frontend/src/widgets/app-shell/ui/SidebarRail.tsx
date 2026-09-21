import { motion } from 'framer-motion';
import { NavLink, useLocation } from 'react-router-dom';
import { cn, springQuick, useMotionOn } from '@/shared/lib';
import { Logo } from '@/shared/ui';
import { NAV_ITEMS, navIndexOf } from '../model/navItems';

/** Item box height and the gap between two items, from the mockup frame. */
const ITEM_HEIGHT = 74;
const ITEM_GAP = 10;

/**
 * Left rail of the dashboard: the mark, then seven sections.
 *
 * Geometry is measured off the mockup frame, which is drawn at 1:1 here (unlike
 * the sign-in frame): rail 149px wide, item box 109×74 on an 84px pitch, icon at
 * 14px from the item top, label 16px below it.
 *
 * The dark capsule behind the active item is one element that travels between
 * items on a spring, as in `apps/web`, rather than a background each item paints
 * for itself — the eye follows it from the old section to the new one.
 */
export function SidebarRail() {
  const { pathname } = useLocation();
  const motionOn = useMotionOn();
  const activeIndex = navIndexOf(pathname);

  return (
    <nav
      aria-label="Разделы"
      className="flex w-[149px] shrink-0 flex-col items-center rounded-r-2xl bg-surface pt-[30px]"
    >
      <Logo className="text-ink" markOnly size={47} />

      <ul className="relative mt-[31px] flex flex-col" style={{ gap: ITEM_GAP }}>
        {activeIndex >= 0 ? (
          <motion.li
            animate={{ y: activeIndex * (ITEM_HEIGHT + ITEM_GAP) }}
            aria-hidden
            className="absolute top-0 left-0 w-[109px] rounded-2xl bg-ink"
            initial={false}
            style={{ height: ITEM_HEIGHT }}
            transition={motionOn ? springQuick : { duration: 0 }}
          />
        ) : null}

        {NAV_ITEMS.map((item) => (
          <li className="relative" key={item.to}>
            <NavLink
              className={({ isActive }) =>
                cn(
                  'flex w-[109px] flex-col items-center rounded-2xl pt-[14px]',
                  'transition-[color,background-color,transform] duration-150',
                  isActive
                    ? 'text-white'
                    : 'text-ink hover:scale-[1.02] hover:bg-muted active:scale-[0.98]',
                )
              }
              style={{ height: ITEM_HEIGHT }}
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
