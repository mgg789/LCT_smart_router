import type { ReactNode } from 'react';
import { FigmaIcon } from '../figma-dashboard/primitives';

export interface DeskNavItem {
  id: string;
  label: string;
  icon: string;
  onSelect: () => void;
}

/**
 * Desktop shell for the client and engineer apps.
 *
 * Both are drawn as a 670-wide phone screen whose every size is a fraction of
 * that width, so a desktop cannot be served by stretching the column — it only
 * makes the same screen taller. The desk is a layout of its own: the hamburger
 * becomes a permanent rail, the screen becomes the left pane, and whatever the
 * phone slides over that screen — an open request — becomes the pane next to
 * it. The screens themselves are untouched; each pane is its own `--eu`
 * context, so they render at the pane's width without knowing where they are.
 */
export function DeskShell({
  brand,
  nav,
  activeNavId,
  header,
  children,
  detail,
  overlays,
}: {
  /** Logo at the top of the rail. */
  brand: string;
  nav: DeskNavItem[];
  activeNavId: string;
  /** Right-hand side of the header strip: clock, account, actions. */
  header?: ReactNode;
  /** The app's own screen — the left pane. */
  children: ReactNode;
  /** The second pane; nothing is drawn when there is nothing open. */
  detail?: ReactNode;
  /** Sheets that belong over the whole desk rather than over one pane. */
  overlays?: ReactNode;
}) {
  return (
    <main className="phone-desk relative">
      <aside className="phone-desk-rail">
        <div className="flex h-[92px] shrink-0 items-center justify-center">
          <FigmaIcon src={brand} alt="NAVIX" width={40} height={40} />
        </div>
        <nav className="flex flex-col gap-[6px] px-[12px]">
          {nav.map((item) => {
            const active = item.id === activeNavId;
            return (
              <button
                aria-current={active}
                className={`flex h-[74px] w-full flex-col items-center justify-center gap-[8px] rounded-[10px] transition-colors duration-200 ${
                  active ? 'bg-figma-ink text-white' : 'text-figma-muted hover:bg-figma-canvas'
                }`}
                key={item.id}
                onClick={item.onSelect}
                type="button"
              >
                <FigmaIcon
                  alt=""
                  className={active ? 'brightness-0 invert' : ''}
                  height={24}
                  src={item.icon}
                  width={24}
                />
                <span className="font-semibold text-[12px] leading-none">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="phone-desk-body">
        <header className="phone-desk-header">{header}</header>
        <div className="phone-desk-panes">
          <section className="phone-desk-col phone-desk-col-list">{children}</section>
          {detail ? (
            <section className="phone-desk-col phone-desk-col-detail">{detail}</section>
          ) : null}
        </div>
      </div>

      {overlays}
    </main>
  );
}
