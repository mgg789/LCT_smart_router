import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';
import { FigmaIcon } from '../figma-dashboard/primitives';

export interface DeskNavItem {
  id: string;
  label: string;
  icon: string;
  onSelect: () => void;
}

const ease = [0.22, 1, 0.36, 1] as const;
const settle = { duration: 0.28, ease };

/**
 * Desktop shell for the client and engineer apps.
 *
 * Both are drawn as a 670-wide phone screen whose every size is a fraction of
 * that width, so a desktop cannot be served by stretching the column — it only
 * makes the same screen taller. The desk is a layout of its own: the hamburger
 * gains a permanent rail beside it, the screen becomes the left pane, and what
 * the phone slides over that screen — an open request — becomes the pane next
 * to it. The screens themselves are untouched; each pane is its own `--eu`
 * context, so they render at the pane's width without knowing where they are.
 *
 * Nothing the phone offers is dropped here. The rail is a shortcut to the
 * sections, not a replacement for the menu: `lead` keeps the app's own menu
 * button in the header, and `overlays` puts its drawer over the whole desk
 * instead of over one pane.
 */
export function DeskShell({
  brand,
  nav,
  activeNavId,
  lead,
  header,
  children,
  screenKey,
  detail,
  detailKey,
  overlays,
}: {
  /** Logo at the top of the rail. */
  brand: string;
  nav: DeskNavItem[];
  activeNavId: string;
  /** The app's own menu button, kept where the phone puts it: first in the row. */
  lead?: ReactNode;
  /** Rest of the header strip: clock, account, actions. */
  header?: ReactNode;
  /** The app's own screen — the left pane. */
  children: ReactNode;
  /** Changes when the left pane shows a different section, so the swap can be seen. */
  screenKey?: string;
  /** The second pane; nothing is drawn when there is nothing open. */
  detail?: ReactNode;
  /** Changes when the pane shows a different request, for the same reason. */
  detailKey?: string;
  /** Sheets that belong over the whole desk rather than over one pane. */
  overlays?: ReactNode;
}) {
  const motionOn = !useReducedMotion();

  return (
    <main className="phone-desk relative">
      <aside className="phone-desk-rail">
        <div className="flex h-[92px] shrink-0 items-center justify-center">
          <FigmaIcon alt="NAVIX" height={40} src={brand} width={40} />
        </div>
        <nav className="flex flex-col gap-[6px] px-[12px]">
          {nav.map((item) => {
            const active = item.id === activeNavId;
            return (
              <button
                aria-current={active}
                className="relative flex h-[74px] w-full flex-col items-center justify-center gap-[8px] rounded-[10px]"
                key={item.id}
                onClick={item.onSelect}
                type="button"
              >
                {active ? (
                  <motion.span
                    aria-hidden
                    className="absolute inset-0 rounded-[10px] bg-figma-ink"
                    layoutId="desk-rail-active"
                    transition={motionOn ? settle : { duration: 0 }}
                  />
                ) : null}
                <FigmaIcon
                  alt=""
                  className={`relative z-[1] transition-[filter] duration-200 ${
                    active ? 'brightness-0 invert' : ''
                  }`}
                  height={24}
                  src={item.icon}
                  width={24}
                />
                <span
                  className={`relative z-[1] font-semibold text-[12px] leading-none transition-colors duration-200 ${
                    active ? 'text-white' : 'text-figma-muted'
                  }`}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="phone-desk-body">
        <header className="phone-desk-header">
          {lead}
          {header}
        </header>
        <div className="phone-desk-panes">
          <section className="phone-desk-col phone-desk-col-list">
            <AnimatePresence initial={false} mode="wait">
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                exit={motionOn ? { opacity: 0, y: -8 } : undefined}
                initial={motionOn ? { opacity: 0, y: 8 } : false}
                key={screenKey ?? 'screen'}
                transition={motionOn ? settle : { duration: 0 }}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </section>

          {/*
           * The pane arrives by width so the screen beside it is pushed rather
           * than covered — the same move the phone makes with its slide-over,
           * read sideways.
           */}
          <AnimatePresence initial={false}>
            {detail ? (
              <motion.section
                animate={{ opacity: 1, flexGrow: 1 }}
                className="phone-desk-col phone-desk-col-detail"
                exit={motionOn ? { opacity: 0, flexGrow: 0.001 } : undefined}
                initial={motionOn ? { opacity: 0, flexGrow: 0.001 } : false}
                key="desk-detail"
                transition={motionOn ? settle : { duration: 0 }}
              >
                <AnimatePresence initial={false} mode="wait">
                  <motion.div
                    animate={{ opacity: 1, x: 0 }}
                    exit={motionOn ? { opacity: 0, x: -12 } : undefined}
                    initial={motionOn ? { opacity: 0, x: 12 } : false}
                    key={detailKey ?? 'detail'}
                    transition={motionOn ? settle : { duration: 0 }}
                  >
                    {detail}
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
