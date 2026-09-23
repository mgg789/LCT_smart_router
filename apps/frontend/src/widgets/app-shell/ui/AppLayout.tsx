import type { Variants } from 'framer-motion';
import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { useLocation, useOutlet } from 'react-router-dom';
import { useAlertAnnouncements } from '@/features/alert/announce';
import { useRecalculationNotice } from '@/features/policy/select-policy';
import { slide, useMotionOn } from '@/shared/lib';
import { ScreenFit } from '@/shared/ui';
import { navIndexOf } from '../model/navItems';
import { AppHeader } from './AppHeader';
import { SidebarRail } from './SidebarRail';
import { ToastViewport } from './ToastViewport';

/**
 * A section slides along the rail's axis. `custom` is the direction of travel;
 * it reaches the outgoing section too, which is why these are variant functions
 * and not fixed targets captured when that section was last rendered.
 */
const STACK: Variants = {
  enter: (direction: number) => ({ y: direction > 0 ? '100%' : direction < 0 ? '-100%' : 0 }),
  center: { y: 0 },
  exit: (direction: number) => ({ y: direction > 0 ? '-100%' : direction < 0 ? '100%' : 0 }),
};

/**
 * Frame every dispatcher screen sits in: rail on the left, header on top, the
 * section itself in the remaining area. Gutters are the mockup's: 31px from the
 * rail to the content, 34px to the right edge.
 *
 * Sections are a vertical stack in the rail's order, as in `apps/web`: going
 * down the rail slides the next section up from below, going back slides it down
 * from above. The outgoing section is frozen as it was (`useOutlet`), so the two
 * are on screen together for the length of the slide.
 */
export function AppLayout() {
  const { pathname } = useLocation();
  const outlet = useOutlet();
  const motionOn = useMotionOn();
  // Notices are the frame's, not a section's: they keep coming whatever is open.
  useAlertAnnouncements();
  useRecalculationNotice();

  // Direction is state adjusted during render rather than a ref written in it:
  // StrictMode renders twice, and a ref would read "no movement" the second time.
  const index = navIndexOf(pathname);
  const [shown, setShown] = useState(index);
  const [direction, setDirection] = useState(0);
  if (shown !== index) {
    setDirection(index > shown ? 1 : -1);
    setShown(index);
  }

  return (
    <ScreenFit>
      <div className="flex h-full bg-canvas">
        <SidebarRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <AppHeader />
          <main className="relative min-h-0 flex-1 overflow-hidden">
            <AnimatePresence custom={direction} initial={false}>
              <motion.div
                animate="center"
                className="absolute inset-0 overflow-auto pr-[34px] pb-8 pl-[31px]"
                custom={direction}
                exit="exit"
                initial="enter"
                key={pathname}
                transition={motionOn ? slide : { duration: 0 }}
                variants={STACK}
              >
                {outlet}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
        <ToastViewport />
      </div>
    </ScreenFit>
  );
}
