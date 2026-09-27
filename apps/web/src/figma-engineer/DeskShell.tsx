import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { FitHeight } from './FitHeight';

const ease = [0.22, 1, 0.36, 1] as const;
const settle = { duration: 0.32, ease };

/**
 * Desktop shell for the client and engineer apps.
 *
 * Both are drawn as a 670-wide phone screen whose every size is a fraction of
 * that width, so a desktop cannot be served by stretching the column — it only
 * makes the same screen taller. The desk is a layout of its own, and it keeps
 * the app's own navigation: the menu button in the header opens the same drawer
 * the phone has, down the left of the screen.
 *
 * The screen fills the width until something is opened. Then it gives half the
 * room to what the phone would have slid over it, which arrives by width so the
 * screen beside it is pushed rather than covered.
 */
export function DeskShell({
  lead,
  header,
  children,
  fitScreen,
  screenKey,
  detail,
  detailKey,
  overlays,
}: {
  /** The app's own menu button. It lives in the rail, clear of the content. */
  lead?: ReactNode;
  /** The header strip: clock, account, actions. */
  header?: ReactNode;
  /** The app's own screen. */
  children: ReactNode;
  /**
   * True for a screen that is one form and should be read at a glance — it is
   * zoomed down to the pane rather than scrolled. A list is never fitted: it is
   * as long as the day is.
   */
  fitScreen?: boolean;
  /** Changes when the pane shows a different section, so the swap can be seen. */
  screenKey?: string;
  /** The second pane; nothing is drawn when nothing is open. */
  detail?: ReactNode;
  /** Changes when the pane shows a different request, for the same reason. */
  detailKey?: string;
  /** Sheets that belong over the whole desk rather than over one pane. */
  overlays?: ReactNode;
}) {
  const motionOn = !useReducedMotion();

  return (
    <main className="phone-desk relative">
      {/*
       * The menu button sits in a rail of its own rather than in the header
       * row: it belongs to the whole desk, not to the screen's title line, and
       * on a desk it is a small control rather than the phone's thumb-sized
       * tap target.
       */}
      <aside className="phone-desk-rail">{lead}</aside>

      <div className="phone-desk-body">
        <header className="phone-desk-header">{header}</header>

        <div className="phone-desk-panes">
          <motion.section
            className="phone-desk-col phone-desk-col-list"
            layout={motionOn}
            transition={motionOn ? settle : { duration: 0 }}
          >
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="h-full"
                exit={motionOn ? { opacity: 0, y: -8 } : undefined}
                initial={motionOn ? { opacity: 0, y: 8 } : false}
                key={screenKey ?? 'screen'}
                transition={motionOn ? settle : { duration: 0 }}
              >
                {fitScreen ? <FitHeight>{children}</FitHeight> : children}
              </motion.div>
            </AnimatePresence>
          </motion.section>

          <AnimatePresence initial={false}>
            {detail ? (
              <motion.section
                animate={{ opacity: 1, flexGrow: 1 }}
                className="phone-desk-col phone-desk-col-detail"
                exit={motionOn ? { opacity: 0, flexGrow: 0.0001 } : undefined}
                initial={motionOn ? { opacity: 0, flexGrow: 0.0001 } : false}
                key="desk-detail"
                transition={motionOn ? settle : { duration: 0 }}
              >
                <AnimatePresence initial={false} mode="wait">
                  <motion.div
                    animate={{ opacity: 1, x: 0 }}
                    className="h-full"
                    exit={motionOn ? { opacity: 0, x: -12 } : undefined}
                    initial={motionOn ? { opacity: 0, x: 12 } : false}
                    key={detailKey ?? 'detail'}
                    transition={motionOn ? settle : { duration: 0 }}
                  >
                    <FitHeight>{detail}</FitHeight>
                  </motion.div>
                </AnimatePresence>
              </motion.section>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      {overlays}
    </main>
  );
}
