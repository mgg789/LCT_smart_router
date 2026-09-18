import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
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
  requestCountLabel,
  type EngineerCard,
  type NavItemId,
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
const ROUTE_STOP_WIDTH = 260;
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
  const [activeNav, setActiveNav] = useState<NavItemId>('day');
  const [selectedEngineerId, setSelectedEngineerId] = useState(FALLBACK_ENGINEER.id);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

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
      if (policyOpen) setPolicyOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [policyOpen, searchOpen]);

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
        }}
      >
        <SidebarNav activeNav={activeNav} onSelect={setActiveNav} motionOn={motionOn} />
        <HeaderTools />
        <PolicyControl
          open={policyOpen}
          policy={policy}
          lunchOn={lunchOn}
          motionOn={motionOn}
          onToggle={() => setPolicyOpen((value) => !value)}
          onSelect={setPolicy}
          onLunchToggle={() => setLunchOn((value) => !value)}
        />
        <FigmaText className="figma-nowrap absolute left-[180px] top-[100px] font-murs text-[32px] tracking-[-0.544px] text-figma-ink">
          {MAIN_DASHBOARD.dateLabel}
        </FigmaText>
        <EngineersColumn
          engineers={visibleEngineers}
          totalCount={MAIN_DASHBOARD.engineers.length}
          selectedEngineerId={selectedEngineer.id}
          searchOpen={searchOpen}
          searchQuery={searchQuery}
          motionOn={motionOn}
          onSearchOpen={() => setSearchOpen(true)}
          onSearchChange={setSearchQuery}
          onSelect={(id) => {
            setSelectedEngineerId(id);
            setSearchOpen(false);
            setSearchQuery('');
          }}
        />
        <MapCard engineerId={selectedEngineer.id} motionOn={motionOn} />
        <RouteCard engineer={selectedEngineer} motionOn={motionOn} />
        <RequestCard request={selectedEngineer.request} motionOn={motionOn} />
        {policyOpen ? (
          <button
            type="button"
            aria-label="Закрыть список политик"
            className="absolute inset-0 z-10 cursor-default bg-transparent"
            onClick={() => setPolicyOpen(false)}
          />
        ) : null}
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

function HeaderTools() {
  return (
    <div className="absolute left-[1728px] top-[32px] z-30 h-[50px] w-[162px]">
      <div className="absolute left-0 top-[7px]">
        <FigmaIcon src={FIGMA_ASSETS.bellHeader} alt="Уведомления" width={30} height={30} />
        <NotificationBadge
          count={MAIN_DASHBOARD.notification.count}
          tone={MAIN_DASHBOARD.notification.tone}
        />
      </div>
      <div className="absolute left-[72px] top-1/2 flex -translate-y-1/2 items-center gap-[20px]">
        <div className="relative size-[50px] overflow-clip rounded-[81px] bg-figma-ink">
          <img
            alt=""
            src={FIGMA_ASSETS.avatarUser}
            className="absolute left-0 top-[-2px] size-[52px] max-w-none object-cover"
          />
        </div>
        <FigmaIcon src={FIGMA_ASSETS.chevronDown} alt="" width={20} height={20} />
      </div>
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
  motionOn,
  onToggle,
  onSelect,
  onLunchToggle,
}: {
  open: boolean;
  policy: PolicyOption;
  lunchOn: boolean;
  motionOn: boolean;
  onToggle: () => void;
  onSelect: (policy: PolicyOption) => void;
  onLunchToggle: () => void;
}) {
  return (
    <motion.div
      data-policy-panel
      className="absolute left-[1289px] top-[26px] z-50 w-[363px] overflow-hidden rounded-[27px] bg-white"
      initial={false}
      animate={{
        height: open ? 451 : 51,
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
        <button
          type="button"
          onClick={onToggle}
          className="absolute inset-y-0 left-0 right-[52px] px-[16px] text-left"
        >
          <FigmaText className="figma-nowrap font-semibold text-[18px] tracking-[-0.306px] text-figma-ink">
            {open ? 'Выбери свою политику' : `Политика: ${policy}`}
          </FigmaText>
        </button>
        <button type="button" onClick={onToggle} className="absolute right-[4px] top-[4px] size-[43px]">
          <motion.span
            className="flex size-[43px] origin-center items-center justify-center will-change-transform"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={motionOn ? { duration: 0.44, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
          >
            <FigmaIcon src={FIGMA_ASSETS.policyArrowClosed} alt={open ? 'Свернуть' : 'Открыть политики'} width={43} height={43} />
          </motion.span>
        </button>
      </div>
      <div className={`relative h-[400px] w-[363px] ${open ? '' : 'pointer-events-none'}`}>
        {POLICY_OPTIONS.map((option, index) => (
          <button
            key={option}
            type="button"
            onClick={() => onSelect(option)}
            className="absolute left-0 h-[32px] w-full"
            style={{ top: 14 + index * 44 }}
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
          </button>
        ))}
        <button type="button" onClick={onLunchToggle} className="absolute left-[16px] top-[274px]">
          {lunchOn ? (
            <FigmaIcon src={FIGMA_ASSETS.toggleOn} alt="Обед включён" width={59} height={29} />
          ) : (
            <span className="relative block h-[29px] w-[59px] overflow-clip">
              <span className="absolute inset-0 rounded-[14.5px] bg-figma-muted" />
              <span className="absolute left-[3px] top-[3px] size-[23px] rounded-full bg-white" />
            </span>
          )}
        </button>
        <FigmaText className="figma-nowrap absolute left-[85px] top-[281px] font-medium leading-none text-[20px] text-black">
          Обед включён
        </FigmaText>
        <button
          type="button"
          className="absolute left-[16px] top-[319px] flex h-[67px] w-[331px] items-center justify-center rounded-[20px] bg-figma-bee p-[20px] transition-transform duration-150 hover:scale-[1.01]"
        >
          <span className="figma-nowrap font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
            Ручное управление
          </span>
        </button>
      </div>
    </motion.div>
  );
}

function EngineersColumn({
  engineers,
  totalCount,
  selectedEngineerId,
  searchOpen,
  searchQuery,
  motionOn,
  onSearchOpen,
  onSearchChange,
  onSelect,
}: {
  engineers: EngineerCard[];
  totalCount: number;
  selectedEngineerId: string;
  searchOpen: boolean;
  searchQuery: string;
  motionOn: boolean;
  onSearchOpen: () => void;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  return (
    <section className="absolute left-[180px] top-[154px] h-[893px] w-[411px] overflow-hidden rounded-[20px] bg-white">
      <FigmaText className="figma-nowrap absolute left-[30px] top-[30px] font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
        {requestCountLabel(MAIN_REQUEST_COUNT)}
      </FigmaText>
      <FigmaText className="figma-nowrap absolute left-[30px] top-[68px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        {MAIN_DASHBOARD.unassigned.title.replace('заявки без назначения', 'без назначения')} - план от 11:42
      </FigmaText>
      <div className="absolute left-[30px] right-[30px] top-[114px] h-[48px]" data-engineer-search>
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
          className="absolute right-0 top-[calc(50%-3px)] flex h-[44px] -translate-y-1/2 items-center overflow-hidden rounded-[20px] border border-solid border-figma-ink bg-white"
          initial={false}
          animate={{ width: searchOpen ? 351 : 44 }}
          transition={motionOn ? { duration: 0.4, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
        >
          <input
            ref={inputRef}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Найти инженера"
            tabIndex={searchOpen ? 0 : -1}
            aria-hidden={!searchOpen}
            className="h-full min-w-0 flex-1 bg-transparent pl-[18px] pr-[44px] font-medium text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint"
          />
          <button
            type="button"
            aria-label="Найти инженера"
            onClick={onSearchOpen}
            className="absolute right-0 top-0 flex size-[44px] items-center justify-center"
          >
            <FigmaIcon src={FIGMA_ASSETS.searchPanel} alt="" width={22} height={22} className="-translate-y-[2px]" />
          </button>
        </motion.div>
      </div>
      <div className="absolute inset-x-0 top-[170px] bottom-[132px] overflow-y-auto px-[30px] [scrollbar-width:thin]">
        <div className="flex flex-col gap-[20px] pb-[8px]">
          <AnimatePresence initial={false}>
            {engineers.map((engineer) => (
              <motion.div
                key={engineer.id}
                layout
                initial={motionOn ? { opacity: 0, y: 10 } : false}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={motionOn ? springQuick : { duration: 0 }}
              >
                <EngineerRow
                  engineer={engineer}
                  selected={engineer.id === selectedEngineerId}
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
        className="absolute left-[30px] top-[778px] w-[351px] overflow-clip rounded-[20px] bg-figma-bee px-[29px] py-[25px]"
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
  motionOn,
  onSelect,
}: {
  engineer: EngineerCard;
  selected: boolean;
  motionOn: boolean;
  onSelect: () => void;
}) {
  const progress = Math.max(8, Math.round((engineer.doneCount / engineer.requestCount) * PROGRESS_TRACK));

  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileHover={motionOn ? { y: -1 } : undefined}
      className={`relative box-border h-[132px] w-[351px] overflow-clip rounded-[15px] text-left transition-[box-shadow,background-color] duration-200 ease-out ${
        selected ? 'bg-figma-soft' : 'bg-transparent'
      }`}
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

function MapCard({ engineerId, motionOn }: { engineerId: string; motionOn: boolean }) {
  return (
    <section className="absolute left-[623px] top-[154px] h-[582px] w-[751px] overflow-clip rounded-[20px] bg-white">
      <motion.div
        key={engineerId}
        className="absolute left-1/2 top-[268px] h-[628px] w-[1227px] -translate-x-1/2 -translate-y-1/2"
        initial={motionOn ? { opacity: 0.72, scale: 1.012 } : false}
        animate={{ opacity: 1, scale: 1 }}
        transition={fadeSoft}
      >
        <img
          alt="Карта Москвы"
          src={FIGMA_ASSETS.map}
          className="absolute inset-0 size-full max-w-none object-cover"
        />
      </motion.div>
    </section>
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
    <section className="absolute left-[623px] top-[768px] h-[279px] w-[751px] overflow-hidden rounded-[20px] bg-white">
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
              <div className="absolute left-[56px] top-[19px] h-[3px] bg-figma-ink" style={{ width: Math.max(0, (engineer.stops.length - 1) * ROUTE_STOP_WIDTH) }} />
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
                    <span className="absolute left-[16px] top-[10px] size-[20px] rounded-full bg-figma-ink" />
                    <FigmaText className="figma-nowrap absolute left-0 top-[46px] w-[240px] text-center font-semibold text-[24px] tracking-[-0.408px] text-black">
                      {stop.time}
                    </FigmaText>
                    <p className="absolute left-0 top-[78px] w-[240px] text-center font-semibold text-[18px] leading-[22px] tracking-[-0.306px] text-figma-muted">
                      {stop.place}
                    </p>
                    <FigmaText className="absolute left-0 top-[126px] w-[240px] text-center font-semibold text-[16px] tracking-[-0.272px] text-figma-hint">
                      {stop.status}
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
    </section>
  );
}

function RequestCard({
  request,
  motionOn,
}: {
  request: EngineerCard['request'];
  motionOn: boolean;
}) {
  return (
    <aside className="absolute left-[1406px] top-[154px] h-[893px] w-[484px] overflow-clip rounded-[20px] bg-figma-ink">
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
          Сменить пользователя
        </span>
      </button>
      <button
        type="button"
        className="absolute left-[20px] top-[794px] flex h-[67px] w-[444px] items-center justify-center rounded-[20px] border border-solid border-white bg-figma-ink px-[20px] transition-transform duration-150 hover:scale-[1.01]"
      >
        <span className="figma-nowrap font-semibold text-[20px] tracking-[-0.6px] text-white">
          Разобрать с AI ассистентом
        </span>
      </button>
    </aside>
  );
}
