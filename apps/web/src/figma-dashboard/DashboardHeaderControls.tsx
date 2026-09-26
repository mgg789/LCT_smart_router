import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import type { PolicyId } from '../api/types';
import { FIGMA_ASSETS } from './assets';
import { isNavLocked, sidebarWheelNav } from './dashboardSlide';
import {
  formatNotificationCount,
  NAV_ITEMS,
  type NavItemId,
  type NotificationTone,
} from './fixtures';
import { policyLabel } from './fromSnapshot';
import { FigmaIcon, FigmaText } from './primitives';
import { TintIcon } from './TintIcon';

const NAV_ICONS = {
  navHome: FIGMA_ASSETS.navHome,
  navRequests: FIGMA_ASSETS.navRequests,
  navEngineers: FIGMA_ASSETS.navEngineers,
  navAlerts: FIGMA_ASSETS.navAlerts,
  navPolicy: FIGMA_ASSETS.navPolicy,
  navChats: FIGMA_ASSETS.navChats,
  navAi: FIGMA_ASSETS.navAi,
} as const;
const NOTIF_PANEL_LEFT = 1407,
  NOTIF_PANEL_TOP = 10,
  HEADER_AVATAR_LEFT = 1800,
  HEADER_AVATAR_TOP = 12;
const METRICS_BUTTON_WIDTH = 232,
  METRICS_BUTTON_LEFT = 1081,
  ADD_BUTTON_LEFT = 1014,
  ADD_BUTTON_TOP = 10,
  ADD_BUTTON_SIZE = 51;

const NAV_ICON_BOX: Record<NavItemId, { width: number; height: number; className: string }> = {
  day: { width: 22, height: 22, className: 'absolute left-1/2 top-[12px] -translate-x-1/2' },
  requests: { width: 24, height: 18, className: 'absolute left-1/2 top-[14px] -translate-x-1/2' },
  engineers: { width: 24, height: 24, className: 'absolute left-1/2 top-[10px] -translate-x-1/2' },
  alerts: { width: 26, height: 26, className: 'absolute left-1/2 top-[8px] -translate-x-1/2' },
  policy: { width: 22, height: 22, className: 'absolute left-1/2 top-[12px] -translate-x-1/2' },
  chats: { width: 26, height: 24, className: 'absolute left-1/2 top-[10px] -translate-x-1/2' },
  ai: { width: 24, height: 24, className: 'absolute left-1/2 top-[10px] -translate-x-1/2' },
};
const NAV_ITEM_HEIGHT = 74;
const NAV_ITEM_GAP = 10;
const POLICY_LEFT = 1329;
const POLICY_TOP = 10;
const POLICY_OPEN_HEIGHT = 629;
const springQuick = { type: 'spring' as const, stiffness: 420, damping: 36, mass: 0.8 };
/** Navigates dashboard sections while retaining the existing disabled-section policy. */
export function SidebarNav({
  activeNav,
  onSelect,
  onUpload,
  motionOn,
}: {
  activeNav: NavItemId;
  onSelect: (id: NavItemId) => void;
  onUpload: () => void;
  motionOn: boolean;
}) {
  const activeIndex = NAV_ITEMS.findIndex((item) => item.id === activeNav);
  const railRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const next = sidebarWheelNav(activeNav, event.deltaY);
      if (next) onSelect(next);
    };
    rail.addEventListener('wheel', onWheel, { passive: false });
    return () => rail.removeEventListener('wheel', onWheel);
  }, [activeNav, onSelect]);

  return (
    <aside
      ref={railRef}
      className="absolute left-0 top-0 z-20 h-[1080px] w-[158px] overflow-visible rounded-br-[20px] rounded-tr-[20px] border-r-[0.5px] border-solid border-[rgba(158,158,158,0.3)] bg-white"
    >
      <div className="absolute left-[79px] top-[56px] -translate-x-1/2 -translate-y-1/2">
        <FigmaIcon src={FIGMA_ASSETS.logo} alt="LCT Smart Router" width={64} height={64} />
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
          const locked = isNavLocked(item.id);
          const icon = NAV_ICON_BOX[item.id];
          return (
            <button
              key={item.id}
              type="button"
              disabled={locked}
              aria-label={item.label}
              aria-disabled={locked}
              title={locked ? 'Скоро' : undefined}
              onClick={() => onSelect(item.id)}
              className={`relative flex h-[74px] w-full items-end justify-center pb-[12px] transition-transform duration-200 ease-out ${
                locked ? 'cursor-not-allowed opacity-35' : 'hover:scale-[1.02]'
              }`}
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
      <motion.button
        type="button"
        aria-label="Загрузить данные"
        onClick={onUpload}
        className="absolute bottom-[28px] left-[12px] flex h-[56px] w-[134px] items-center justify-center rounded-full"
        whileHover={motionOn ? { scale: 1.12 } : undefined}
        whileTap={motionOn ? { scale: 0.94 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <FigmaIcon src={FIGMA_ASSETS.iconUpload} alt="" width={28} height={28} />
      </motion.button>
    </aside>
  );
}

/**
 * Header bell toggles the right-hand toast column. While the column is open the
 * bell stays in the header under the veil (z below the column); the column's own
 * collapse bubble closes it.
 */
export function NotificationControl({
  open,
  count,
  tone,
  motionOn,
  onToggle,
}: {
  open: boolean;
  count: number;
  tone: NotificationTone;
  motionOn: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      data-notif-panel
      className="pointer-events-none absolute z-[70]"
      style={{ left: NOTIF_PANEL_LEFT, top: NOTIF_PANEL_TOP, width: 363, height: 51 }}
    >
      <motion.button
        type="button"
        aria-label={open ? 'Скрыть уведомления' : 'Показать уведомления'}
        aria-pressed={open}
        onClick={onToggle}
        className="pointer-events-auto absolute right-[6px] top-[6px] flex size-[43px] items-center justify-center"
        whileHover={motionOn ? { scale: 1.08 } : undefined}
        whileTap={motionOn ? { scale: 0.96 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <span className="relative">
          <FigmaIcon src={FIGMA_ASSETS.bellHeader} alt="" width={30} height={30} />
          {count > 0 ? <NotificationBadge count={count} tone={tone} /> : null}
        </span>
      </motion.button>
    </div>
  );
}

/**
 * Avatar + chevron open a compact account menu.
 */
export function UserMenu({
  open,
  covered,
  hasPreviousPlan,
  motionOn,
  demoStand,
  onToggle,
  onSettings,
  onOpenPreviousPlan,
  onEndDay,
  onRestartDay,
  onReset,
  onSignOut,
}: {
  open: boolean;
  covered: boolean;
  hasPreviousPlan: boolean;
  motionOn: boolean;
  demoStand: boolean;
  onToggle: () => void;
  onSettings: () => void;
  onOpenPreviousPlan: () => void;
  onEndDay: () => void;
  onRestartDay: () => void;
  onReset: () => void;
  onSignOut: () => void;
}) {
  return (
    <div
      data-user-menu
      className={`absolute ${covered ? 'z-[40]' : 'z-[85]'}`}
      style={{ left: HEADER_AVATAR_LEFT, top: HEADER_AVATAR_TOP }}
    >
      <motion.button
        type="button"
        onClick={onToggle}
        className="relative z-50 flex items-center gap-[20px]"
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
            className="absolute right-0 top-[62px] z-[90] flex w-[230px] flex-col rounded-[16px] bg-white p-[10px]"
            initial={motionOn ? { opacity: 0, y: -8, scale: 0.96 } : false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={motionOn ? { opacity: 0, y: -8, scale: 0.96 } : undefined}
            transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
            style={{ boxShadow: '0 16px 36px rgba(39, 41, 48, 0.16)' }}
          >
            <div className="flex flex-col gap-[8px]">
              <MenuAction motionOn={motionOn} tone="ink" onClick={onSettings}>
                Настройки
              </MenuAction>
              {hasPreviousPlan ? (
                <MenuAction motionOn={motionOn} tone="bee" onClick={onOpenPreviousPlan}>
                  Прошлый план
                </MenuAction>
              ) : null}
            </div>
            <div className="mx-auto my-[8px] h-px w-[40px] bg-figma-ink/20" />
            <div className="flex flex-col gap-[8px]">
              <MenuAction motionOn={motionOn} tone="bee" onClick={onEndDay}>
                Завершить день
              </MenuAction>
              {demoStand ? (
                <MenuAction motionOn={motionOn} tone="danger" onClick={onRestartDay}>
                  День заново
                </MenuAction>
              ) : null}
            </div>
            <div className="mx-auto my-[8px] h-px w-[40px] bg-figma-ink/20" />
            <div className="flex flex-col gap-[8px]">
              {demoStand ? (
                <MenuAction motionOn={motionOn} tone="danger" onClick={onReset}>
                  Сбросить данные
                </MenuAction>
              ) : null}
              <MenuAction motionOn={motionOn} tone="danger" onClick={onSignOut}>
                Выйти
              </MenuAction>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function MenuAction({
  tone,
  motionOn,
  onClick,
  children,
}: {
  tone: 'ink' | 'bee' | 'danger';
  motionOn: boolean;
  onClick: () => void;
  children: string;
}) {
  const palette =
    tone === 'bee'
      ? 'bg-figma-bee text-figma-ink'
      : tone === 'ink'
        ? 'bg-figma-ink text-white'
        : 'bg-figma-danger text-white';
  return (
    <motion.button
      type="button"
      aria-label={children}
      onClick={onClick}
      className={`flex h-[44px] w-full items-center justify-center rounded-[12px] font-semibold text-[16px] ${palette}`}
      whileHover={motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined}
      whileTap={motionOn ? { scale: 0.98 } : undefined}
      transition={{ duration: 0.16 }}
    >
      {children}
    </motion.button>
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

/**
 * Opens the metrics surface without changing the selected routing policy.
 */
export function PlanMetricsButton({ motionOn, onOpen }: { motionOn: boolean; onOpen: () => void }) {
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      className="absolute z-50 flex h-[51px] items-center gap-[10px] rounded-[27px] bg-figma-ink py-[4px] pl-[4px] pr-[16px] text-white"
      style={{ left: METRICS_BUTTON_LEFT, top: POLICY_TOP, width: METRICS_BUTTON_WIDTH }}
      whileHover={motionOn ? { y: -1 } : undefined}
      whileTap={motionOn ? { scale: 0.98 } : undefined}
      transition={{ duration: 0.16 }}
    >
      <span className="flex size-[43px] shrink-0 items-center justify-center rounded-full bg-white">
        <TintIcon src="/figma/chart-dots-2.svg" color="#272930" size={22} />
      </span>
      <span className="figma-nowrap font-semibold text-[18px] tracking-[-0.3px]">
        Метрики плана
      </span>
    </motion.button>
  );
}

/** Opens the existing add-entity dialog from the header. */
export function AddEntityButton({ motionOn, onOpen }: { motionOn: boolean; onOpen: () => void }) {
  return (
    <motion.button
      type="button"
      aria-label="Добавить"
      onClick={onOpen}
      className="absolute z-50 flex items-center justify-center rounded-full bg-figma-ink"
      style={{
        left: ADD_BUTTON_LEFT,
        top: ADD_BUTTON_TOP,
        width: ADD_BUTTON_SIZE,
        height: ADD_BUTTON_SIZE,
      }}
      whileHover={motionOn ? { scale: 1.08 } : undefined}
      whileTap={motionOn ? { scale: 0.96 } : undefined}
      transition={{ duration: 0.16 }}
    >
      <FigmaIcon src={FIGMA_ASSETS.iconPlusWhite} alt="" width={22} height={22} />
    </motion.button>
  );
}

/** Displays persisted routing controls; callbacks retain the dashboard's CAS mutation flow. */
export function PolicyControl({
  open,
  policyLabel: selectedLabel,
  policies,
  selectedId,
  lunchOn,
  trafficOn,
  metroOn,
  equipmentTransfersOn,
  strictTimeWindowsOn,
  motionOn,
  onToggle,
  onSelect,
  onLunchToggle,
  onTrafficToggle,
  onMetroToggle,
  onEquipmentTransfersToggle,
  onStrictTimeWindowsToggle,
  onManualMode,
}: {
  open: boolean;
  policyLabel: string;
  policies: { id: PolicyId; label: string }[];
  selectedId: PolicyId;
  lunchOn: boolean;
  trafficOn: boolean;
  metroOn: boolean;
  equipmentTransfersOn: boolean;
  strictTimeWindowsOn: boolean;
  motionOn: boolean;
  onToggle: () => void;
  onSelect: (policy: PolicyId) => void;
  onLunchToggle: () => void;
  onTrafficToggle: () => void;
  onMetroToggle: () => void;
  onEquipmentTransfersToggle: () => void;
  onStrictTimeWindowsToggle: () => void;
  onManualMode: () => void;
}) {
  const options =
    policies.length > 0
      ? policies
      : (['fast', 'compact', 'sla', 'balanced', 'eco', 'covering'] as const).map((id) => ({
          id,
          label: policyLabel(id),
        }));
  const extra = Math.max(0, options.length - 6) * 44;
  return (
    <motion.div
      data-policy-panel
      className="absolute z-50 w-[363px] overflow-hidden rounded-[27px] bg-white"
      style={{ left: POLICY_LEFT, top: POLICY_TOP }}
      initial={false}
      animate={{
        height: open ? POLICY_OPEN_HEIGHT + extra : 51,
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
            {open ? 'Выбери свою политику' : `Политика: ${selectedLabel}`}
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
            <FigmaIcon
              src={FIGMA_ASSETS.policyArrowClosed}
              alt={open ? 'Свернуть' : 'Открыть политики'}
              width={43}
              height={43}
            />
          </motion.span>
        </motion.button>
      </div>
      <div
        className={`relative w-[363px] ${open ? '' : 'pointer-events-none'}`}
        style={{ height: 592 + extra }}
      >
        {options.map((option, index) => (
          <motion.button
            key={option.id}
            type="button"
            onClick={() => onSelect(option.id)}
            className="absolute left-0 h-[32px] w-full"
            style={{ top: 14 + index * 44 }}
            whileHover={motionOn ? { x: 4 } : undefined}
            transition={{ duration: 0.16 }}
          >
            <FigmaIcon
              src={option.id === selectedId ? FIGMA_ASSETS.radioFilled : FIGMA_ASSETS.radioEmpty}
              alt=""
              width={24}
              height={24}
              className="absolute left-[16px] top-0"
            />
            <FigmaText className="figma-nowrap absolute left-[50px] top-[4px] font-medium text-[20px] text-figma-ink">
              {option.label}
            </FigmaText>
          </motion.button>
        ))}
        <PolicySwitch
          on={lunchOn}
          label="Рассчитать обеды"
          top={274 + extra}
          motionOn={motionOn}
          onToggle={onLunchToggle}
        />
        <PolicySwitch
          on={trafficOn}
          label="Прогнозировать пробки"
          top={318 + extra}
          motionOn={motionOn}
          onToggle={onTrafficToggle}
        />
        <PolicySwitch
          on={metroOn}
          label="Маршруты с метро"
          top={362 + extra}
          motionOn={motionOn}
          onToggle={onMetroToggle}
        />
        <PolicySwitch
          on={equipmentTransfersOn}
          label="Передача оборудования"
          top={406 + extra}
          motionOn={motionOn}
          onToggle={onEquipmentTransfersToggle}
        />
        <PolicySwitch
          on={strictTimeWindowsOn}
          label="Строгие окна ТЗ"
          description="Без допуска к окну, последней заявке и концу смены"
          top={450 + extra}
          motionOn={motionOn}
          onToggle={onStrictTimeWindowsToggle}
        />
        <button
          type="button"
          onClick={onManualMode}
          className="absolute left-[16px] flex h-[67px] w-[331px] items-center justify-center rounded-[20px] bg-figma-bee p-[20px] transition-transform duration-150 hover:scale-[1.01]"
          style={{ top: 495 + extra }}
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
  description,
  top,
  motionOn,
  onToggle,
}: {
  on: boolean;
  label: string;
  description?: string;
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
      title={description}
      aria-label={description ? `${label}. ${description}` : label}
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
