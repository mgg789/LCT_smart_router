import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FIGMA_ASSETS } from './assets';
import {
  FIGMA_ARTBOARD,
  MAIN_DASHBOARD,
  MAIN_REQUEST_COUNT,
  NAV_ITEMS,
  POLICY_OPTIONS,
  filterEngineers,
  formatNotificationCount,
  isCompletedStop,
  requestCountLabel,
  routeStopStatusLabel,
  visibleNotifications,
  type DashboardNotification,
  type EngineerCard,
  type NavItemId,
  type NotificationIconKey,
  type NotificationTone,
  type PolicyOption,
} from './fixtures';
import { FigmaIcon, FigmaText } from './primitives';

const NAV_ICONS = {
  navHome: FIGMA_ASSETS.navHome,
  navRequests: FIGMA_ASSETS.navRequests,
  navEngineers: FIGMA_ASSETS.navEngineers,
  navAlerts: FIGMA_ASSETS.navAlerts,
  navPolicy: FIGMA_ASSETS.navPolicy,
  navChats: FIGMA_ASSETS.navChats,
  navAi: FIGMA_ASSETS.navAi,
} as const;

const NAV_ICON_BOX: Record<NavItemId, { width: number; height: number; className: string }> = {
  day: { width: 22, height: 22, className: 'absolute left-1/2 top-[12px] -translate-x-1/2' },
  requests: { width: 24, height: 18, className: 'absolute left-1/2 top-[14px] -translate-x-1/2' },
  engineers: { width: 24, height: 24, className: 'absolute left-1/2 top-[10px] -translate-x-1/2' },
  alerts: { width: 26, height: 26, className: 'absolute left-1/2 top-[8px] -translate-x-1/2' },
  policy: { width: 22, height: 22, className: 'absolute left-1/2 top-[12px] -translate-x-1/2' },
  chats: { width: 26, height: 24, className: 'absolute left-1/2 top-[10px] -translate-x-1/2' },
  ai: { width: 24, height: 24, className: 'absolute left-1/2 top-[10px] -translate-x-1/2' },
};

const REASON_ICONS = {
  reasonCheck: { src: FIGMA_ASSETS.reasonCheck, width: 20, height: 13, top: 71, left: 16 },
  reasonCar: { src: FIGMA_ASSETS.reasonCar, width: 20, height: 20, top: 102, left: 16 },
  reasonClock: { src: FIGMA_ASSETS.reasonClock, width: 18, height: 20, top: 138, left: 17 },
  reasonPin: { src: FIGMA_ASSETS.reasonPin, width: 17, height: 18, top: 173, left: 18 },
} as const;

const NAV_ITEM_HEIGHT = 74;
const NAV_ITEM_GAP = 10;
const SEARCH_CONTROL_SIZE = 40;
const SEARCH_OPEN_WIDTH = 351;
const HEADER_LIFT = 16;
const POLICY_LEFT = 1329;
const POLICY_TOP = 26 - HEADER_LIFT;
const POLICY_OPEN_HEIGHT = 497;
const NOTIF_PANEL_LEFT = 1407;
const NOTIF_PANEL_TOP = 29 - HEADER_LIFT;
const NOTIF_OPEN_HEIGHT = 450;
const HEADER_AVATAR_LEFT = 1800;
const HEADER_AVATAR_TOP = 28 - HEADER_LIFT;
const DATE_TOP = 100 - HEADER_LIFT;
const PANEL_TOP = 154 - HEADER_LIFT;
const PANEL_HEIGHT = 893 + HEADER_LIFT;
const UNASSIGNED_TOP = 778 + HEADER_LIFT;
const CLOSE_PANEL_SIZE = 43;
const MAP_COMPACT = { left: 623, top: PANEL_TOP, width: 751, height: 582 + HEADER_LIFT };
const MAP_EXPANDED = { left: 623, top: PANEL_TOP, width: 1267, height: PANEL_HEIGHT };
const ROUTE_STOP_WIDTH = 260;
const ROUTE_TOPIC_WIDTH = 240;
const ROUTE_DOT_SIZE = 20;
const ROUTE_DOT_LEFT = (ROUTE_TOPIC_WIDTH - ROUTE_DOT_SIZE) / 2;
const ROUTE_LINE_LEFT = 30 + ROUTE_DOT_LEFT + ROUTE_DOT_SIZE / 2;
const PROGRESS_TRACK = 321;

const springQuick = { type: 'spring' as const, stiffness: 420, damping: 36, mass: 0.8 };
const fadeSoft = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };
const FALLBACK_ENGINEER: EngineerCard = MAIN_DASHBOARD.engineers[0] as EngineerCard;

/**
 * Dispatcher MAIN screen from Figma 28:614 / 29:2552.
 * Static first pass: mock copy only, no dispatch API.
 */
export function MainDashboardPage() {
  const reduceMotion = useReducedMotion();
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policy, setPolicy] = useState<PolicyOption>(MAIN_DASHBOARD.defaultPolicy);
  const [lunchOn, setLunchOn] = useState(true);
  const [trafficOn, setTrafficOn] = useState(false);
  const [activeNav, setActiveNav] = useState<NavItemId>('day');
  const [selectedEngineerId, setSelectedEngineerId] = useState(FALLBACK_ENGINEER.id);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [mapExpanded, setMapExpanded] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const visibleEngineers = useMemo(
    () => filterEngineers(MAIN_DASHBOARD.engineers, searchQuery),
    [searchQuery],
  );
  const selectedEngineer =
    visibleEngineers.find((item) => item.id === selectedEngineerId) ??
    visibleEngineers[0] ??
    FALLBACK_ENGINEER;

  useEffect(() => {
    if (!visibleEngineers.some((item) => item.id === selectedEngineerId) && visibleEngineers[0]) {
      setSelectedEngineerId(visibleEngineers[0].id);
    }
  }, [selectedEngineerId, visibleEngineers]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
        return;
      }
      if (notifOpen) {
        setNotifOpen(false);
        return;
      }
      if (userMenuOpen) {
        setUserMenuOpen(false);
        return;
      }
      if (policyOpen) {
        setPolicyOpen(false);
        return;
      }
      if (mapExpanded) setMapExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mapExpanded, notifOpen, policyOpen, searchOpen, userMenuOpen]);

  const scale = useArtboardScale();
  const motionOn = !reduceMotion;

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-figma-canvas">
      <div
        className="relative shrink-0 bg-figma-canvas"
        data-name="MAIN"
        style={{
          width: FIGMA_ARTBOARD.width,
          height: FIGMA_ARTBOARD.height,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
        onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (searchOpen && !target.closest('[data-engineer-search]')) {
            setSearchOpen(false);
            setSearchQuery('');
          }
          if (notifOpen && !target.closest('[data-notif-panel]')) setNotifOpen(false);
          if (userMenuOpen && !target.closest('[data-user-menu]')) setUserMenuOpen(false);
          if (policyOpen && !target.closest('[data-policy-panel]')) setPolicyOpen(false);
        }}
      >
        <SidebarNav activeNav={activeNav} onSelect={setActiveNav} motionOn={motionOn} />
        <PolicyControl
          open={policyOpen}
          policy={policy}
          lunchOn={lunchOn}
          trafficOn={trafficOn}
          motionOn={motionOn}
          onToggle={() => {
            setNotifOpen(false);
            setUserMenuOpen(false);
            setPolicyOpen((value) => !value);
          }}
          onSelect={setPolicy}
          onLunchToggle={() => setLunchOn((value) => !value)}
          onTrafficToggle={() => setTrafficOn((value) => !value)}
        />
        <NotificationControl
          open={notifOpen}
          motionOn={motionOn}
          onToggle={() => {
            setPolicyOpen(false);
            setUserMenuOpen(false);
            setNotifOpen((value) => !value);
          }}
        />
        <UserMenu
          open={userMenuOpen}
          motionOn={motionOn}
          onToggle={() => {
            setPolicyOpen(false);
            setNotifOpen(false);
            setUserMenuOpen((value) => !value);
          }}
        />
        <FigmaText
          className="figma-nowrap absolute left-[180px] font-murs text-[32px] tracking-[-0.544px] text-figma-ink"
          style={{ top: DATE_TOP }}
        >
          {MAIN_DASHBOARD.dateLabel}
        </FigmaText>
        <EngineersColumn
          engineers={visibleEngineers}
          totalCount={MAIN_DASHBOARD.engineers.length}
          selectedEngineerId={selectedEngineer.id}
          searchOpen={searchOpen}
          searchQuery={searchQuery}
          motionOn={motionOn}
          onSearchToggle={() => {
            if (searchOpen) {
              setSearchOpen(false);
              setSearchQuery('');
              return;
            }
            setSearchOpen(true);
          }}
          onSearchChange={setSearchQuery}
          onSelect={(id) => {
            setSelectedEngineerId(id);
            setSearchOpen(false);
            setSearchQuery('');
            setMapExpanded(false);
          }}
        />
        <MapCard engineerId={selectedEngineer.id} expanded={mapExpanded} motionOn={motionOn} />
        <AnimatePresence>
          {mapExpanded ? null : (
            <RouteCard key="route-card" engineer={selectedEngineer} motionOn={motionOn} />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {mapExpanded ? null : (
            <RequestCard
              key="request-card"
              request={selectedEngineer.request}
              motionOn={motionOn}
              onExpandMap={() => setMapExpanded(true)}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * Fits the 1920×1080 mockup into the viewport without changing its internal layout.
 * At exactly 1920×1080 the scale is 1, so browser screenshots stay pixel-identical.
 */
function useArtboardScale(): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const update = () => {
      setScale(Math.min(window.innerWidth / FIGMA_ARTBOARD.width, window.innerHeight / FIGMA_ARTBOARD.height));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return scale;
}

function SidebarNav({
  activeNav,
  onSelect,
  motionOn,
}: {
  activeNav: NavItemId;
  onSelect: (id: NavItemId) => void;
  motionOn: boolean;
}) {
  const activeIndex = NAV_ITEMS.findIndex((item) => item.id === activeNav);

  return (
    <aside className="absolute left-0 top-0 z-20 h-[1080px] w-[158px] overflow-visible rounded-br-[20px] rounded-tr-[20px] border-r-[0.5px] border-solid border-[rgba(158,158,158,0.3)] bg-white">
      <div className="absolute left-[79px] top-[52px] -translate-x-1/2 -translate-y-1/2">
        <FigmaIcon src={FIGMA_ASSETS.logo} alt="Beeline" width={44} height={44} />
      </div>
      <nav className="absolute left-[12px] top-[110px] w-[134px]">
        <motion.div
          aria-hidden
          className="absolute left-0 top-0 h-[74px] w-full rounded-[10px] bg-figma-ink"
          initial={false}
          animate={{ y: activeIndex * (NAV_ITEM_HEIGHT + NAV_ITEM_GAP) }}
          transition={motionOn ? springQuick : { duration: 0 }}
        />
        {NAV_ITEMS.map((item) => {
          const active = item.id === activeNav;
          const icon = NAV_ICON_BOX[item.id];
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              className="relative flex h-[74px] w-full items-end justify-center pb-[12px] transition-transform duration-200 ease-out hover:scale-[1.02]"
              style={{ marginBottom: NAV_ITEM_GAP }}
            >
              <FigmaIcon
                src={NAV_ICONS[item.icon]}
                alt=""
                width={icon.width}
                height={icon.height}
                className={`${icon.className} ${active ? 'nav-glyph-on' : 'nav-glyph-off'} transition-[filter] duration-150`}
              />
              <FigmaText
                className={`figma-nowrap relative z-10 font-semibold text-[16px] tracking-[-0.272px] transition-colors duration-150 ${
                  active ? 'text-white' : 'text-figma-muted'
                }`}
              >
                {item.label}
              </FigmaText>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

const NOTIF_ICONS: Record<NotificationIconKey, string> = {
  delay: FIGMA_ASSETS.notifDelay,
  route: FIGMA_ASSETS.notifRoute,
  message: FIGMA_ASSETS.notifMessage,
};

/**
 * Header bell + alerts dropdown. The 30×30 glyph stays at the same screen
 * point; opening only paints a 43px ink circle behind it.
 */
function NotificationControl({
  open,
  motionOn,
  onToggle,
}: {
  open: boolean;
  motionOn: boolean;
  onToggle: () => void;
}) {
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  const ignoreOutsideClick = useRef(false);
  const items = visibleNotifications(MAIN_DASHBOARD.notifications).filter(
    (item) => !dismissedIds.includes(item.id),
  );
  const badgeCount = Math.max(0, MAIN_DASHBOARD.notification.count - dismissedIds.length);

  useEffect(() => {
    const blockClick = (event: MouseEvent) => {
      if (!ignoreOutsideClick.current) return;
      event.stopPropagation();
      ignoreOutsideClick.current = false;
    };
    document.addEventListener('click', blockClick, true);
    return () => document.removeEventListener('click', blockClick, true);
  }, []);

  return (
    <div
      data-notif-panel
      className="pointer-events-none absolute z-50"
      style={{ left: NOTIF_PANEL_LEFT, top: NOTIF_PANEL_TOP, width: 363 }}
    >
      <motion.div
        className={`relative w-full rounded-[27px] ${
          open ? 'pointer-events-auto overflow-hidden bg-white' : 'overflow-visible bg-transparent'
        }`}
        initial={false}
        animate={{
          height: open ? NOTIF_OPEN_HEIGHT : 51,
          boxShadow: open ? '0 22px 48px rgba(39, 41, 48, 0.18)' : '0 0 0 rgba(39, 41, 48, 0)',
        }}
        transition={
          motionOn
            ? {
                height: { duration: 0.44, ease: [0.22, 1, 0.36, 1] },
                boxShadow: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
              }
            : { duration: 0 }
        }
      >
        <AnimatePresence>
          {open ? (
            <motion.div
              key="notif-body"
              className="absolute inset-0"
              initial={motionOn ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              exit={motionOn ? { opacity: 0 } : undefined}
              transition={fadeSoft}
            >
              <FigmaText className="figma-nowrap absolute left-[16px] top-[19px] font-murs text-[20px] text-figma-ink">
                Алерты и уведомления
              </FigmaText>
              <div className="absolute left-[16px] top-[63px] flex h-[331px] w-[331px] flex-col gap-[19px] overflow-hidden">
                <AnimatePresence initial={false}>
                  {items.map((item) => (
                    <NotificationRow
                      key={item.id}
                      item={item}
                      motionOn={motionOn}
                      onSwipeStart={() => {
                        ignoreOutsideClick.current = true;
                      }}
                      onDismiss={() => {
                        ignoreOutsideClick.current = true;
                        setDismissedIds((current) =>
                          current.includes(item.id) ? current : [...current, item.id],
                        );
                      }}
                    />
                  ))}
                </AnimatePresence>
              </div>
              <button
                type="button"
                className="group absolute left-[16px] top-[410px] flex h-[25px] w-[331px] items-center justify-center gap-[2px]"
              >
                <span className="transition-transform duration-150 group-hover:-translate-x-1.5">
                  <FigmaText className="figma-nowrap font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
                    К Алёртам
                  </FigmaText>
                </span>
                <span className="transition-transform duration-150 group-hover:translate-x-1.5">
                  <FigmaIcon src={FIGMA_ASSETS.arrowRight} alt="" width={24} height={24} />
                </span>
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.button
          type="button"
          aria-label={open ? 'Закрыть уведомления' : 'Уведомления'}
          onClick={onToggle}
          className="pointer-events-auto absolute right-[4px] top-[4px] flex size-[43px] items-center justify-center"
          whileHover={motionOn ? { scale: 1.08 } : undefined}
          whileTap={motionOn ? { scale: 0.96 } : undefined}
          transition={{ duration: 0.16 }}
        >
          <motion.span
            className="absolute inset-0 rounded-full bg-figma-ink"
            initial={false}
            animate={{ opacity: open ? 1 : 0 }}
            transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
          />
          <span className="relative">
            <FigmaIcon
              src={FIGMA_ASSETS.bellHeader}
              alt=""
              width={30}
              height={30}
              className={open ? 'nav-glyph-on' : ''}
            />
            <AnimatePresence>
              {open || badgeCount <= 0 ? null : (
                <motion.span
                  key="badge"
                  className="absolute inset-0"
                  initial={false}
                  exit={motionOn ? { opacity: 0, scale: 0.85 } : undefined}
                  transition={fadeSoft}
                >
                  <NotificationBadge
                    count={badgeCount}
                    tone={MAIN_DASHBOARD.notification.tone}
                  />
                </motion.span>
              )}
            </AnimatePresence>
          </span>
        </motion.button>
      </motion.div>
    </div>
  );
}

function NotificationRow({
  item,
  motionOn,
  onSwipeStart,
  onDismiss,
}: {
  item: DashboardNotification;
  motionOn: boolean;
  onSwipeStart: () => void;
  onDismiss: () => void;
}) {
  const [offsetX, setOffsetX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const originX = useRef<number | null>(null);
  const exitX = useRef(360);

  const beginSwipe = (clientX: number) => {
    originX.current = clientX;
    setDragging(true);
    onSwipeStart();
  };

  const moveSwipe = (clientX: number) => {
    if (originX.current === null) return;
    setOffsetX(clientX - originX.current);
  };

  const endSwipe = (clientX: number) => {
    if (originX.current === null) return;
    const dx = clientX - originX.current;
    originX.current = null;
    setDragging(false);
    if (Math.abs(dx) < 64) {
      setOffsetX(0);
      return;
    }
    exitX.current = dx >= 0 ? 380 : -380;
    setOffsetX(exitX.current);
    onDismiss();
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => moveSwipe(event.clientX);
    const onUp = (event: PointerEvent) => endSwipe(event.clientX);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging]);

  return (
    <motion.div
      layout
      initial={motionOn ? { opacity: 0, y: 10 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={
        motionOn
          ? { opacity: 0, x: exitX.current, height: 0, marginBottom: 0, transition: { duration: 0.22 } }
          : { opacity: 0 }
      }
      className="shrink-0"
    >
      <motion.div
        onPointerDown={(event) => {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* pointer capture is unavailable for some synthetic events */
          }
          beginSwipe(event.clientX);
        }}
        onPointerMove={(event) => {
          if (originX.current === null) return;
          moveSwipe(event.clientX);
        }}
        onPointerUp={(event) => endSwipe(event.clientX)}
        onPointerCancel={(event) => endSwipe(event.clientX)}
        whileHover={
          motionOn && !dragging
            ? { y: -3, boxShadow: '0 12px 24px rgba(39, 41, 48, 0.14)' }
            : undefined
        }
        animate={{ x: offsetX }}
        transition={dragging ? { duration: 0 } : fadeSoft}
        role="button"
        aria-label={item.text}
        className={`flex h-[99px] w-[331px] cursor-grab items-center gap-[11px] overflow-clip rounded-[20px] px-[36px] py-[20px] select-none ${
          dragging ? 'cursor-grabbing' : ''
        } ${item.tone === 'yellow' ? 'bg-figma-bee' : 'border-2 border-solid border-figma-ink bg-white'}`}
        style={{ touchAction: 'pan-x' }}
      >
        <FigmaIcon src={NOTIF_ICONS[item.icon]} alt="" width={30} height={30} />
        <FigmaText className="font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
          {item.text}
        </FigmaText>
      </motion.div>
    </motion.div>
  );
}

/**
 * Avatar + chevron open a compact account menu.
 */
function UserMenu({
  open,
  motionOn,
  onToggle,
}: {
  open: boolean;
  motionOn: boolean;
  onToggle: () => void;
}) {
  return (
    <div data-user-menu className="absolute z-50" style={{ left: HEADER_AVATAR_LEFT, top: HEADER_AVATAR_TOP }}>
      <motion.button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-[20px]"
        aria-label="Меню пользователя"
        whileHover={motionOn ? { scale: 1.04 } : undefined}
        whileTap={motionOn ? { scale: 0.98 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <div className="relative size-[50px] overflow-clip rounded-[81px] bg-figma-ink">
          <img
            alt=""
            src={FIGMA_ASSETS.avatarUser}
            className="absolute left-0 top-[-2px] size-[52px] max-w-none object-cover"
          />
        </div>
        <motion.span
          className="flex size-[20px] items-center justify-center"
          animate={{ rotate: open ? 180 : 0 }}
          whileHover={motionOn && !open ? { rotate: 18 } : undefined}
          transition={{ duration: 0.2 }}
        >
          <FigmaIcon src={FIGMA_ASSETS.chevronDown} alt="" width={20} height={20} />
        </motion.span>
      </motion.button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className="absolute right-0 top-[62px] flex w-[214px] flex-col gap-[8px] rounded-[16px] bg-white p-[10px]"
            initial={motionOn ? { opacity: 0, y: -8, scale: 0.96 } : false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={motionOn ? { opacity: 0, y: -8, scale: 0.96 } : undefined}
            transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
            style={{ boxShadow: '0 16px 36px rgba(39, 41, 48, 0.16)' }}
          >
            <motion.button
              type="button"
              className="flex h-[44px] w-full items-center justify-center rounded-[12px] bg-figma-danger font-semibold text-[16px] text-white"
              whileHover={motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined}
              whileTap={motionOn ? { scale: 0.98 } : undefined}
              transition={{ duration: 0.16 }}
            >
              Сбросить данные
            </motion.button>
            <motion.button
              type="button"
              className="flex h-[44px] w-full items-center justify-center rounded-[12px] bg-figma-danger font-semibold text-[16px] text-white"
              whileHover={motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined}
              whileTap={motionOn ? { scale: 0.98 } : undefined}
              transition={{ duration: 0.16 }}
            >
              Выйти
            </motion.button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * Notification bubble: circle for 1 digit, pill for 2 digits and 99+.
 */
function NotificationBadge({ count, tone }: { count: number; tone: NotificationTone }) {
  const label = formatNotificationCount(count);
  const wide = label.length > 1;
  return (
    <span
      className={`absolute -right-[6px] -top-[4px] flex h-[20px] items-center justify-center rounded-full font-medium text-[12px] leading-none whitespace-nowrap tabular-nums ${
        wide ? 'min-w-[28px] px-[7px]' : 'w-[20px]'
      } ${tone === 'yellow' ? 'bg-figma-bee text-figma-ink' : 'bg-figma-muted text-white'}`}
    >
      {label}
    </span>
  );
}

function PolicyControl({
  open,
  policy,
  lunchOn,
  trafficOn,
  motionOn,
  onToggle,
  onSelect,
  onLunchToggle,
  onTrafficToggle,
}: {
  open: boolean;
  policy: PolicyOption;
  lunchOn: boolean;
  trafficOn: boolean;
  motionOn: boolean;
  onToggle: () => void;
  onSelect: (policy: PolicyOption) => void;
  onLunchToggle: () => void;
  onTrafficToggle: () => void;
}) {
  return (
    <motion.div
      data-policy-panel
      className="absolute z-50 w-[363px] overflow-hidden rounded-[27px] bg-white"
      style={{ left: POLICY_LEFT, top: POLICY_TOP }}
      initial={false}
      animate={{
        height: open ? POLICY_OPEN_HEIGHT : 51,
        boxShadow: open ? '0 22px 48px rgba(39, 41, 48, 0.18)' : '0 0 0 rgba(39, 41, 48, 0)',
      }}
      transition={
        motionOn
          ? {
              height: { duration: 0.44, ease: [0.22, 1, 0.36, 1] },
              boxShadow: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
            }
          : { duration: 0 }
      }
    >
      <div className="relative h-[51px] w-full">
        <motion.button
          type="button"
          onClick={onToggle}
          className="absolute inset-y-0 left-0 right-[52px] px-[16px] text-left"
          whileHover={motionOn ? { x: 2 } : undefined}
          transition={{ duration: 0.16 }}
        >
          <FigmaText className="figma-nowrap font-semibold text-[18px] tracking-[-0.306px] text-figma-ink">
            {open ? 'Выбери свою политику' : `Политика: ${policy}`}
          </FigmaText>
        </motion.button>
        <motion.button
          type="button"
          onClick={onToggle}
          className="absolute right-[4px] top-[4px] size-[43px]"
          whileHover={motionOn ? { scale: 1.08 } : undefined}
          whileTap={motionOn ? { scale: 0.96 } : undefined}
          transition={{ duration: 0.16 }}
        >
          <motion.span
            className="flex size-[43px] origin-center items-center justify-center will-change-transform"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={motionOn ? { duration: 0.44, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
          >
            <FigmaIcon src={FIGMA_ASSETS.policyArrowClosed} alt={open ? 'Свернуть' : 'Открыть политики'} width={43} height={43} />
          </motion.span>
        </motion.button>
      </div>
      <div className={`relative h-[460px] w-[363px] ${open ? '' : 'pointer-events-none'}`}>
        {POLICY_OPTIONS.map((option, index) => (
          <motion.button
            key={option}
            type="button"
            onClick={() => onSelect(option)}
            className="absolute left-0 h-[32px] w-full"
            style={{ top: 14 + index * 44 }}
            whileHover={motionOn ? { x: 4 } : undefined}
            transition={{ duration: 0.16 }}
          >
            <FigmaIcon
              src={option === policy ? FIGMA_ASSETS.radioFilled : FIGMA_ASSETS.radioEmpty}
              alt=""
              width={24}
              height={24}
              className="absolute left-[16px] top-0"
            />
            <FigmaText className="figma-nowrap absolute left-[50px] top-[4px] font-medium text-[20px] text-figma-ink">
              {option}
            </FigmaText>
          </motion.button>
        ))}
        <PolicySwitch
          on={lunchOn}
          label="Рассчитать обеды"
          top={274}
          motionOn={motionOn}
          onToggle={onLunchToggle}
        />
        <PolicySwitch
          on={trafficOn}
          label="Прогнозировать пробки"
          top={318}
          motionOn={motionOn}
          onToggle={onTrafficToggle}
        />
        <button
          type="button"
          className="absolute left-[16px] top-[363px] flex h-[67px] w-[331px] items-center justify-center rounded-[20px] bg-figma-bee p-[20px] transition-transform duration-150 hover:scale-[1.01]"
        >
          <span className="figma-nowrap font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
            Ручное управление
          </span>
        </button>
      </div>
    </motion.div>
  );
}

/**
 * Animated policy toggle: 59×29 track with a sliding thumb.
 */
function PolicySwitch({
  on,
  label,
  top,
  motionOn,
  onToggle,
}: {
  on: boolean;
  label: string;
  top: number;
  motionOn: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="absolute left-[16px] flex items-center"
      style={{ top }}
    >
      <span className="relative block h-[29px] w-[59px] overflow-hidden rounded-[14.5px]">
        <span
          className={`absolute inset-0 rounded-[14.5px] transition-colors duration-300 ${
            on ? 'bg-figma-ink' : 'bg-figma-muted'
          }`}
        />
        <motion.span
          className="absolute top-[3px] size-[23px] rounded-full bg-white"
          initial={false}
          animate={{ left: on ? 33 : 3 }}
          transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
        />
      </span>
      <FigmaText className="figma-nowrap ml-[10px] font-medium leading-none text-[20px] text-black">
        {label}
      </FigmaText>
    </button>
  );
}

function EngineersColumn({
  engineers,
  totalCount,
  selectedEngineerId,
  searchOpen,
  searchQuery,
  motionOn,
  onSearchToggle,
  onSearchChange,
  onSelect,
}: {
  engineers: EngineerCard[];
  totalCount: number;
  selectedEngineerId: string;
  searchOpen: boolean;
  searchQuery: string;
  motionOn: boolean;
  onSearchToggle: () => void;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  return (
    <section
      className="absolute left-[180px] w-[411px] overflow-hidden rounded-[20px] bg-white"
      style={{ top: PANEL_TOP, height: PANEL_HEIGHT }}
    >
      <FigmaText className="figma-nowrap absolute left-[30px] top-[30px] z-0 font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
        {requestCountLabel(MAIN_REQUEST_COUNT)}
      </FigmaText>
      <FigmaText className="figma-nowrap absolute left-[30px] top-[68px] z-0 font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        {MAIN_DASHBOARD.unassigned.title.replace('заявки без назначения', 'без назначения')} - план от 11:42
      </FigmaText>
      <div className="absolute left-[30px] right-[30px] top-[114px] z-0 h-[48px]" data-engineer-search>
        <AnimatePresence initial={false}>
          {!searchOpen ? (
            <motion.div
              key="title"
              className="absolute inset-y-0 left-0 flex items-center"
              initial={motionOn ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fadeSoft}
            >
              <FigmaText className="figma-nowrap font-semibold text-[24px] tracking-[-0.408px] text-figma-dim">
                Инженеры
              </FigmaText>
              <FigmaIcon
                src={FIGMA_ASSETS.dotEngineers}
                alt=""
                width={5}
                height={5}
                className="mx-[10px]"
              />
              <FigmaText className="figma-nowrap font-semibold text-[24px] tracking-[-0.408px] text-figma-dim">
                {totalCount}
              </FigmaText>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.div
          className="absolute right-0 top-[calc(50%-2px)] box-border flex -translate-y-1/2 items-center overflow-hidden rounded-[20px] border border-solid border-figma-ink bg-white"
          style={{
            height: SEARCH_CONTROL_SIZE,
            minHeight: SEARCH_CONTROL_SIZE,
            maxHeight: SEARCH_CONTROL_SIZE,
          }}
          initial={false}
          animate={{ width: searchOpen ? SEARCH_OPEN_WIDTH : SEARCH_CONTROL_SIZE }}
          transition={motionOn ? { duration: 0.4, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
        >
          <input
            ref={inputRef}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Найти инженера"
            tabIndex={searchOpen ? 0 : -1}
            aria-hidden={!searchOpen}
            className="box-border h-full min-h-0 min-w-0 flex-1 border-0 bg-transparent py-0 pl-[18px] pr-[40px] font-medium leading-none text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint"
          />
          <button
            type="button"
            aria-label={searchOpen ? 'Закрыть поиск' : 'Найти инженера'}
            onClick={onSearchToggle}
            className="absolute right-0 top-0 flex items-center justify-center"
            style={{ width: SEARCH_CONTROL_SIZE, height: SEARCH_CONTROL_SIZE }}
          >
            <FigmaIcon
              src={FIGMA_ASSETS.searchPanel}
              alt=""
              width={22}
              height={22}
              className="translate-x-[1px] -translate-y-[1px]"
            />
          </button>
        </motion.div>
      </div>
      <div className="absolute inset-x-0 top-[158px] bottom-[132px] z-20 overflow-y-auto px-[30px] pt-[12px] [scrollbar-width:thin]">
        <div className="flex flex-col gap-[20px] pb-[8px]">
          <AnimatePresence initial={false}>
            {engineers.map((engineer, index) => (
              <motion.div
                key={engineer.id}
                layout
                initial={motionOn ? { opacity: 0, y: 10 } : false}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={motionOn ? springQuick : { duration: 0 }}
                className="relative"
                style={{ zIndex: index === 0 ? 30 : 10 }}
                whileHover={{ zIndex: 40 }}
              >
                <EngineerRow
                  engineer={engineer}
                  selected={engineer.id === selectedEngineerId}
                  elevate={index === 0}
                  motionOn={motionOn}
                  onSelect={() => onSelect(engineer.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {engineers.length === 0 ? (
            <p className="pt-[24px] text-center font-medium text-[16px] text-figma-muted">
              Инженер не найден
            </p>
          ) : null}
        </div>
      </div>
      <motion.div
        className="absolute left-[30px] z-30 w-[351px] overflow-clip rounded-[20px] bg-figma-bee px-[29px] py-[25px]"
        style={{ top: UNASSIGNED_TOP }}
        whileHover={motionOn ? { scale: 1.01 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <div className="relative h-[46px]">
          <FigmaText className="figma-nowrap font-murs text-[20px] tracking-[0.2px] text-figma-ink">
            {MAIN_DASHBOARD.unassigned.title}
          </FigmaText>
          <FigmaText className="figma-nowrap absolute left-[6px] top-[30px] font-semibold text-[16px] tracking-[0.16px] text-figma-sub">
            {MAIN_DASHBOARD.unassigned.reason}
          </FigmaText>
        </div>
      </motion.div>
    </section>
  );
}

function EngineerRow({
  engineer,
  selected,
  elevate,
  motionOn,
  onSelect,
}: {
  engineer: EngineerCard;
  selected: boolean;
  elevate: boolean;
  motionOn: boolean;
  onSelect: () => void;
}) {
  const progress = Math.max(8, Math.round((engineer.doneCount / engineer.requestCount) * PROGRESS_TRACK));

  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileHover={motionOn ? { y: -2, zIndex: 40 } : undefined}
      className={`relative box-border h-[132px] w-[351px] overflow-clip rounded-[15px] text-left transition-[box-shadow,background-color] duration-200 ease-out ${
        selected ? 'bg-figma-soft' : 'bg-transparent'
      } ${elevate ? 'z-30' : 'z-10'}`}
      style={{ boxShadow: selected ? 'inset 0 0 0 1px #727478' : 'inset 0 0 0 1px transparent' }}
    >
      <img
        alt=""
        src={FIGMA_ASSETS.avatarEngineer}
        className="absolute left-[15px] top-[20px] size-[44px] max-w-none rounded-full object-cover"
      />
      <div className="absolute left-[69px] right-[15px] top-[20px] flex items-baseline justify-between gap-[10px]">
        <FigmaText className="figma-nowrap min-w-0 overflow-hidden font-murs text-[20px] tracking-[0.1px] text-ellipsis text-black">
          {engineer.name}
        </FigmaText>
        <FigmaText className="figma-nowrap shrink-0 font-bold text-[16px] tracking-[0.16px] text-black">
          {engineer.km} км
        </FigmaText>
      </div>
      <div className="absolute left-[69px] top-[49px] flex items-center gap-[8px] font-medium text-[16px] tracking-[-0.272px] text-figma-muted">
        <span className="figma-nowrap">{engineer.status}</span>
        <span className="size-[3px] rounded-full bg-figma-muted" />
        <span className="figma-nowrap">{engineer.requestCount} заявок</span>
      </div>
      <div className="absolute left-[15px] top-[81px] h-[8px] w-[321px] rounded-[13px] bg-figma-track" />
      <motion.div
        className="absolute left-[15px] top-[81px] h-[8px] rounded-[13px] bg-figma-ink"
        initial={false}
        animate={{ width: progress }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      />
      <FigmaText className="figma-nowrap absolute left-[15px] top-[104px] font-semibold text-[16px] tracking-[-0.272px] text-figma-muted">
        {engineer.shift}
      </FigmaText>
      <FigmaText className="figma-nowrap absolute right-[15px] top-[104px] font-semibold text-[16px] tracking-[-0.272px] text-figma-muted">
        выполнено {engineer.doneCount}/{engineer.requestCount}
      </FigmaText>
    </motion.button>
  );
}

function MapCard({
  engineerId,
  expanded,
  motionOn,
}: {
  engineerId: string;
  expanded: boolean;
  motionOn: boolean;
}) {
  const frame = expanded ? MAP_EXPANDED : MAP_COMPACT;
  return (
    <motion.section
      className="absolute overflow-clip rounded-[20px] bg-white"
      initial={false}
      animate={frame}
      transition={motionOn ? { duration: 0.45, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
    >
      <motion.img
        key={engineerId}
        alt="Карта Москвы"
        src={FIGMA_ASSETS.map}
        className="absolute inset-0 size-full max-w-none object-cover"
        initial={motionOn ? { opacity: 0.72, scale: 1.012 } : false}
        animate={{ opacity: 1, scale: 1 }}
        transition={fadeSoft}
      />
    </motion.section>
  );
}

function RouteCard({ engineer, motionOn }: { engineer: EngineerCard; motionOn: boolean }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ left: 174, width: 321 });

  const updateThumb = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    const track = 691;
    const width = overflow <= 0 ? 321 : Math.max(96, Math.round((el.clientWidth / el.scrollWidth) * track));
    const left = overflow <= 0 ? 30 + (track - width) / 2 : 30 + (el.scrollLeft / overflow) * (track - width);
    setThumb({ left, width });
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateThumb();
    el.addEventListener('scroll', updateThumb, { passive: true });
    return () => el.removeEventListener('scroll', updateThumb);
  }, [engineer.id, engineer.stops.length]);

  return (
    <motion.section
      className="absolute left-[623px] top-[768px] h-[279px] w-[751px] overflow-hidden rounded-[20px] bg-white"
      initial={motionOn ? { opacity: 0, y: 20 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={motionOn ? { opacity: 0, y: 28 } : undefined}
      transition={motionOn ? { duration: 0.38, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={engineer.id}
          initial={motionOn ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          exit={motionOn ? { opacity: 0, y: -8 } : undefined}
          transition={fadeSoft}
          className="absolute inset-0"
        >
          <FigmaText className="figma-nowrap absolute left-[30px] top-[30px] font-bold text-[28px] tracking-[-0.476px] text-figma-ink">
            Маршрут {engineer.name.split(' ')[0]} {engineer.name.split(' ')[1]}
          </FigmaText>
          <FigmaText className="figma-nowrap absolute left-[30px] top-[68px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
            {engineer.routeUpdated}
          </FigmaText>
          <div ref={scrollerRef} className="route-scroll absolute inset-x-0 top-[110px] bottom-[22px] overflow-x-auto">
            <div className="relative px-[30px]" style={{ width: 60 + engineer.stops.length * ROUTE_STOP_WIDTH }}>
              <div
                className="absolute top-[19px] h-[3px] bg-figma-ink"
                style={{
                  left: ROUTE_LINE_LEFT,
                  width: Math.max(0, (engineer.stops.length - 1) * ROUTE_STOP_WIDTH),
                }}
              />
              <div className="flex">
                {engineer.stops.map((stop, index) => (
                  <motion.div
                    key={`${engineer.id}-${stop.time}-${stop.place}`}
                    className="relative shrink-0"
                    style={{ width: ROUTE_STOP_WIDTH }}
                    initial={motionOn ? { opacity: 0, y: 8 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...fadeSoft, delay: index * 0.04 }}
                  >
                    <span
                      className="absolute top-[10px] rounded-full bg-figma-ink"
                      style={{ left: ROUTE_DOT_LEFT, width: ROUTE_DOT_SIZE, height: ROUTE_DOT_SIZE }}
                    />
                    <FigmaText className="figma-nowrap absolute left-0 top-[46px] w-[240px] text-center font-semibold text-[24px] tracking-[-0.408px] text-black">
                      {stop.time}
                    </FigmaText>
                    <p className="absolute left-0 top-[78px] w-[240px] text-center font-semibold text-[18px] leading-[22px] tracking-[-0.306px] text-figma-muted">
                      {stop.place}
                    </p>
                    <FigmaText
                      className={`absolute left-0 top-[126px] w-[240px] text-center font-semibold text-[16px] tracking-[-0.272px] ${
                        isCompletedStop(stop.status) ? 'text-figma-done' : 'text-figma-hint'
                      }`}
                    >
                      {routeStopStatusLabel(stop.status)}
                    </FigmaText>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
      <div
        className="pointer-events-none absolute top-[267px] h-[6px] rounded-[13px] bg-figma-hint"
        style={{ left: thumb.left, width: thumb.width }}
      />
    </motion.section>
  );
}

function RequestCard({
  request,
  motionOn,
  onExpandMap,
}: {
  request: EngineerCard['request'];
  motionOn: boolean;
  onExpandMap: () => void;
}) {
  return (
    <motion.aside
      className="absolute left-[1406px] w-[484px] overflow-clip rounded-[20px] bg-figma-ink"
      style={{ top: PANEL_TOP, height: PANEL_HEIGHT }}
      initial={motionOn ? { opacity: 0, x: 28 } : false}
      animate={{ opacity: 1, x: 0 }}
      exit={motionOn ? { opacity: 0, x: 36 } : undefined}
      transition={motionOn ? { duration: 0.38, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
    >
      <button
        type="button"
        aria-label="Развернуть карту"
        onClick={onExpandMap}
        className="absolute right-[16px] top-[16px] z-10 flex items-center justify-center rounded-full bg-white"
        style={{ width: CLOSE_PANEL_SIZE, height: CLOSE_PANEL_SIZE }}
      >
        <X size={22} strokeWidth={2.25} className="text-figma-ink" />
      </button>
      <AnimatePresence mode="wait">
        <motion.div
          key={request.number}
          className="absolute inset-0"
          initial={motionOn ? { opacity: 0, x: 16 } : false}
          animate={{ opacity: 1, x: 0 }}
          exit={motionOn ? { opacity: 0, x: -12 } : undefined}
          transition={fadeSoft}
        >
          <FigmaText className="figma-nowrap absolute left-[30px] top-[30px] font-murs text-[32px] tracking-[-0.544px] text-white">
            {request.number}
          </FigmaText>
          <FigmaIcon
            src={FIGMA_ASSETS.statusDot}
            alt=""
            width={10}
            height={10}
            className="absolute left-[320px] top-[36px]"
          />
          <FigmaText className="figma-nowrap absolute left-[30px] top-[74px] font-semibold text-[24px] tracking-[-0.408px] text-white/60">
            {request.title}
          </FigmaText>
          <div className="absolute left-[30px] top-[111px] flex gap-[12px]">
            {request.tags.map((tag) => (
              <div
                key={tag}
                className="flex items-center justify-center rounded-[20px] bg-figma-track px-[20px] py-[12px]"
              >
                <FigmaText className="figma-nowrap font-medium text-[20px] tracking-[-0.34px] text-figma-ink">
                  {tag}
                </FigmaText>
              </div>
            ))}
          </div>
          <div className="absolute left-[27px] top-[198px] flex w-[430px] flex-col items-start gap-[16px]">
            <div className="flex h-[67px] w-[430px] items-center overflow-clip rounded-[20px] bg-figma-dim px-[20px]">
              <FigmaText className="figma-nowrap font-medium text-[20px] tracking-[-0.6px] text-white">
                {request.company}
              </FigmaText>
            </div>
            <div className="flex w-[430px] gap-[12.48px]">
              <div className="relative h-[67px] w-[208.76px] overflow-clip rounded-[20px] bg-figma-dim">
                <FigmaText className="figma-nowrap absolute left-[20px] top-[24px] font-medium text-[20px] tracking-[-0.6px] text-white">
                  {request.address}
                </FigmaText>
              </div>
              <div className="flex h-[67px] w-[208.76px] items-center overflow-clip rounded-[20px] bg-figma-dim p-[20px]">
                <FigmaText className="figma-nowrap font-medium text-[20px] tracking-[-0.6px] text-white">
                  {request.window}
                </FigmaText>
              </div>
            </div>
            <div className="flex h-[67px] w-[430px] items-center overflow-clip rounded-[20px] bg-figma-dim p-[20px]">
              <FigmaText className="figma-nowrap font-medium text-[20px] tracking-[-0.6px] text-white">
                {request.work}
              </FigmaText>
            </div>
            <div className="relative h-[216px] w-[430px] overflow-clip rounded-[20px] bg-figma-dim">
              <FigmaText className="figma-nowrap absolute left-[20px] top-[26px] font-medium text-[28px] tracking-[-0.84px] text-white">
                {request.whyTitle}
              </FigmaText>
              {request.reasons.map((reason, index) => {
                const icon = REASON_ICONS[reason.icon];
                return (
                  <div key={reason.label}>
                    <FigmaIcon
                      src={icon.src}
                      alt=""
                      width={icon.width}
                      height={icon.height}
                      className="absolute"
                      style={{ left: icon.left, top: icon.top }}
                    />
                    <FigmaText
                      className="figma-nowrap absolute left-[46px] font-medium text-[20px] tracking-[-0.6px] text-white/60"
                      style={{ top: 70 + index * 35 }}
                    >
                      {reason.label}
                    </FigmaText>
                  </div>
                );
              })}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
      <button
        type="button"
        className="absolute left-[27px] top-[711px] flex h-[67px] w-[430px] items-center justify-center rounded-[20px] bg-figma-bee p-[20px] transition-transform duration-150 hover:scale-[1.01]"
      >
        <span className="figma-nowrap font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
          Переназначить
        </span>
      </button>
      <button
        type="button"
        className="absolute left-[27px] top-[794px] flex h-[67px] w-[430px] items-center justify-center rounded-[20px] border border-solid border-white bg-figma-ink px-[8px] transition-transform duration-150 hover:scale-[1.01]"
      >
        <span className="figma-nowrap font-semibold text-[20px] tracking-[-0.6px] text-white">
          Разобрать с AI ассистентом
        </span>
      </button>
    </motion.aside>
  );
}
