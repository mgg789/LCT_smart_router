import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useId, useRef, useState } from 'react';
import type { PolicyId } from '../api/types';
import { isNavixOffline } from '../domain/mapAvailability';
import { t } from '../i18n';
import { useArtboardStretch } from './artboardStretch';
import { FIGMA_ASSETS } from './assets';
import { isNavLocked, sidebarWheelNav } from './dashboardSlide';
import { formatNotificationCount, type NotificationTone } from './fixtures';
import { policyLabel } from './fromSnapshot';
import { openManualPlanning } from './ManualPlanning';
import { NAV_ITEMS, type NavItemId } from './navigation';
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
/**
 * The right-hand header controls hold the right edge of the board, which on a
 * wide window is further right than the drawing put it.
 */
const NOTIF_PANEL_LEFT = 1407,
  NOTIF_PANEL_TOP = 'calc(10px + 4px / var(--dashboard-scale, 1))',
  HEADER_AVATAR_LEFT = 1800,
  HEADER_AVATAR_TOP = 'calc(12px + 4px / var(--dashboard-scale, 1))';
const METRICS_BUTTON_WIDTH = 232,
  METRICS_BUTTON_LEFT = 1081,
  ADD_BUTTON_LEFT = 1014,
  ADD_BUTTON_TOP = 'calc(10px + 4px / var(--dashboard-scale, 1))',
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
const POLICY_TOP = 'calc(10px + 4px / var(--dashboard-scale, 1))';
const POLICY_OPEN_HEIGHT = 695;
const springQuick = { type: 'spring' as const, stiffness: 420, damping: 36, mass: 0.8 };
/** Navigates dashboard sections while retaining the existing disabled-section policy. */
export function SidebarNav({
  activeNav,
  onSelect,
  onUpload,
  motionOn,
  chatsUnread = false,
}: {
  activeNav: NavItemId;
  onSelect: (id: NavItemId) => void;
  onUpload: () => void;
  motionOn: boolean;
  /** Yellow dot on «Чаты» while any dialogue has a message the dispatcher has not read. */
  chatsUnread?: boolean;
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
      className="absolute inset-y-[calc(8px/var(--dashboard-scale,1))] left-0 z-20 w-[158px] overflow-visible rounded-br-[20px] rounded-tr-[20px] border-r-[0.5px] border-solid border-[rgba(158,158,158,0.3)] bg-white"
    >
      <div className="absolute left-[79px] top-[56px] -translate-x-1/2 -translate-y-1/2">
        <FigmaIcon
          src={FIGMA_ASSETS.logo}
          alt={t('figma-dashboard.DashboardHeaderControls.d985a55a7b')}
          width={64}
          height={64}
        />
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
          const locked = isNavLocked(item.id) || (isNavixOffline() && item.id === 'ai');
          const icon = NAV_ICON_BOX[item.id];
          const unreadChats = item.id === 'chats' && chatsUnread;
          return (
            <button
              key={item.id}
              type="button"
              disabled={locked}
              aria-label={item.label}
              aria-disabled={locked}
              title={
                locked
                  ? isNavixOffline() && item.id === 'ai'
                    ? t('common.offlineContour')
                    : t('figma-dashboard.DashboardHeaderControls.72c299e0d6')
                  : undefined
              }
              onClick={() => onSelect(item.id)}
              className={`relative flex h-[74px] w-full items-end justify-center pb-[12px] transition-transform duration-200 ease-out ${
                locked ? 'cursor-not-allowed opacity-35' : 'hover:scale-[1.02]'
              }`}
              style={{ marginBottom: NAV_ITEM_GAP }}
            >
              {unreadChats ? (
                <span
                  aria-hidden
                  className={icon.className}
                  style={{
                    width: icon.width,
                    height: icon.height,
                    backgroundColor: 'var(--color-figma-bee)',
                    WebkitMaskImage: `url(${NAV_ICONS[item.icon]})`,
                    maskImage: `url(${NAV_ICONS[item.icon]})`,
                    WebkitMaskRepeat: 'no-repeat',
                    maskRepeat: 'no-repeat',
                    WebkitMaskPosition: 'center',
                    maskPosition: 'center',
                    WebkitMaskSize: 'contain',
                    maskSize: 'contain',
                  }}
                />
              ) : (
                <FigmaIcon
                  src={NAV_ICONS[item.icon]}
                  alt=""
                  width={icon.width}
                  height={icon.height}
                  className={`${icon.className} ${active ? 'nav-glyph-on' : 'nav-glyph-off'} transition-[filter] duration-150`}
                />
              )}
              <FigmaText
                className={`figma-nowrap relative z-10 font-semibold text-[16px] tracking-[-0.272px] transition-colors duration-150 ${
                  unreadChats ? 'text-figma-bee' : active ? 'text-white' : 'text-figma-muted'
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
        aria-label={t('figma-dashboard.DashboardHeaderControls.724b169fae')}
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
  const { dx } = useArtboardStretch();
  return (
    <div
      data-notif-panel
      className="pointer-events-none absolute z-[70]"
      style={{ left: NOTIF_PANEL_LEFT + dx, top: NOTIF_PANEL_TOP, width: 363, height: 51 }}
    >
      <motion.button
        type="button"
        aria-label={
          open
            ? t('figma-dashboard.DashboardHeaderControls.7ab47cf943')
            : t('figma-dashboard.DashboardHeaderControls.5422796d15')
        }
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
  manualMode = false,
  hasPreviousPlan,
  motionOn,
  demoStand,
  onToggle,
  onSettings,
  onOpenPreviousPlan,
  onDownloadPlan,
  onEndDay,
  onRestartDay,
  onReset,
  onSignOut,
}: {
  open: boolean;
  covered: boolean;
  manualMode?: boolean;
  hasPreviousPlan: boolean;
  motionOn: boolean;
  demoStand: boolean;
  onToggle: () => void;
  onSettings: () => void;
  onOpenPreviousPlan: () => void;
  onDownloadPlan: () => void;
  onEndDay: () => void;
  onRestartDay: () => void;
  onReset: () => void;
  onSignOut: () => void;
}) {
  const { dx } = useArtboardStretch();
  const [arrowHovered, setArrowHovered] = useState(false);
  return (
    <div
      data-user-menu
      className={`absolute ${covered ? 'z-[40]' : open ? 'z-[90]' : 'z-[60]'}`}
      style={{ left: HEADER_AVATAR_LEFT + dx, top: HEADER_AVATAR_TOP }}
    >
      <motion.button
        type="button"
        onClick={onToggle}
        className="relative z-50 flex items-center gap-[20px]"
        aria-label={t('figma-dashboard.DashboardHeaderControls.91b15c0032')}
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
          onPointerEnter={() => setArrowHovered(true)}
          onPointerLeave={() => setArrowHovered(false)}
          animate={{ rotate: open ? 180 : motionOn && arrowHovered ? 18 : 0 }}
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
                {t('figma-dashboard.DashboardHeaderControls.985b5e0f2c')}
              </MenuAction>
              {manualMode ? (
                <MenuAction
                  motionOn={motionOn}
                  tone="bee"
                  onClick={() => openManualPlanning('priorities')}
                >
                  {t('figma-dashboard.DashboardHeaderControls.bc58eaa8cf')}
                </MenuAction>
              ) : null}
              {hasPreviousPlan ? (
                <MenuAction motionOn={motionOn} tone="bee" onClick={onOpenPreviousPlan}>
                  {t('figma-dashboard.DashboardHeaderControls.fbde84ea39')}
                </MenuAction>
              ) : null}
              <MenuAction motionOn={motionOn} tone="bee" onClick={onDownloadPlan}>
                {t('figma-dashboard.DashboardHeaderControls.downloadPlan')}
              </MenuAction>
            </div>
            <div className="mx-auto my-[8px] h-px w-[40px] bg-figma-ink/20" />
            <div className="flex flex-col gap-[8px]">
              <MenuAction motionOn={motionOn} tone="bee" onClick={onEndDay}>
                {t('figma-dashboard.DashboardHeaderControls.070512aa40')}
              </MenuAction>
              {demoStand ? (
                <MenuAction motionOn={motionOn} tone="danger" onClick={onRestartDay}>
                  {t('figma-dashboard.DashboardHeaderControls.79953852a9')}
                </MenuAction>
              ) : null}
            </div>
            <div className="mx-auto my-[8px] h-px w-[40px] bg-figma-ink/20" />
            <div className="flex flex-col gap-[8px]">
              {demoStand ? (
                <MenuAction motionOn={motionOn} tone="danger" onClick={onReset}>
                  {t('figma-dashboard.DashboardHeaderControls.d613027d96')}
                </MenuAction>
              ) : null}
              <MenuAction motionOn={motionOn} tone="danger" onClick={onSignOut}>
                {t('figma-dashboard.DashboardHeaderControls.5690c2e63b')}
              </MenuAction>
              <p className="text-center text-[12px] text-figma-muted">
                {t('figma-dashboard.DashboardHeaderControls.18f4939c70')}
              </p>
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
  const { dx } = useArtboardStretch();
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      className="absolute z-50 flex h-[51px] items-center gap-[10px] rounded-[27px] bg-figma-ink py-[4px] pl-[4px] pr-[16px] text-white"
      style={{ left: METRICS_BUTTON_LEFT + dx, top: POLICY_TOP, width: METRICS_BUTTON_WIDTH }}
      whileHover={motionOn ? { y: -1 } : undefined}
      whileTap={motionOn ? { scale: 0.98 } : undefined}
      transition={{ duration: 0.16 }}
    >
      <span className="flex size-[43px] shrink-0 items-center justify-center rounded-full bg-white">
        <TintIcon src="/figma/chart-dots-2.svg" color="#272930" size={22} />
      </span>
      <span className="figma-nowrap font-semibold text-[18px] tracking-[-0.3px]">
        {t('figma-dashboard.DashboardHeaderControls.bb25ab0a14')}
      </span>
    </motion.button>
  );
}

/** Opens the existing add-entity dialog from the header. */
export function AddEntityButton({ motionOn, onOpen }: { motionOn: boolean; onOpen: () => void }) {
  const { dx } = useArtboardStretch();
  return (
    <motion.button
      type="button"
      aria-label={t('figma-dashboard.DashboardHeaderControls.71038c53bb')}
      onClick={onOpen}
      className="absolute z-50 flex items-center justify-center rounded-full bg-figma-ink"
      style={{
        left: ADD_BUTTON_LEFT + dx,
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
  ordinaryReplanningDisabled,
  replanningSaving,
  onOrdinaryReplanningToggle,
  motionOn,
  onToggle,
  onSelect,
  onLunchToggle,
  onTrafficToggle,
  onMetroToggle,
  onEquipmentTransfersToggle,
  onStrictTimeWindowsToggle,
  onManualMode,
  manualMode = false,
  personalConfigured = false,
  personalTitle,
  onEditPersonal,
  offline = false,
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
  ordinaryReplanningDisabled: boolean;
  replanningSaving: boolean;
  onOrdinaryReplanningToggle: () => void;
  motionOn: boolean;
  onToggle: () => void;
  onSelect: (policy: PolicyId) => void;
  onLunchToggle: () => void;
  onTrafficToggle: () => void;
  onMetroToggle: () => void;
  onEquipmentTransfersToggle: () => void;
  onStrictTimeWindowsToggle: () => void;
  onManualMode: () => void;
  manualMode?: boolean;
  personalConfigured?: boolean;
  personalTitle?: string;
  onEditPersonal?: () => void;
  offline?: boolean;
}) {
  const baseOptions =
    policies.length > 0
      ? policies
      : (['fast', 'compact', 'sla', 'balanced', 'eco', 'covering'] as const).map((id) => ({
          id,
          label: policyLabel(id),
        }));
  const options: { id: PolicyId; label: string }[] = [
    ...baseOptions.filter((option) => option.id !== 'personal'),
    {
      id: 'personal',
      label: personalConfigured
        ? (personalTitle ?? t('figma-dashboard.DashboardHeaderControls.0a8232003c'))
        : t('figma-dashboard.DashboardHeaderControls.e8f84c5d65'),
    },
  ];
  const personalIndex = options.length - 1;
  const extra = Math.max(0, options.length - 6) * 44;
  const { dx } = useArtboardStretch();
  return (
    <motion.div
      data-policy-panel
      className="absolute z-50 w-[363px] overflow-hidden rounded-[27px] bg-white"
      style={{ left: POLICY_LEFT + dx, top: POLICY_TOP }}
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
      <motion.div
        className="relative h-[51px] w-full"
        whileHover={motionOn ? { y: -1 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <motion.button
          type="button"
          onClick={onToggle}
          className="absolute inset-y-0 left-0 right-[52px] px-[16px] text-left"
          transition={{ duration: 0.16 }}
        >
          <FigmaText className="figma-nowrap font-semibold text-[18px] tracking-[-0.306px] text-figma-ink">
            {open
              ? t('figma-dashboard.DashboardHeaderControls.8c3690ab32')
              : t('figma-dashboard.DashboardHeaderControls.43e8b56b2e', { value0: selectedLabel })}
          </FigmaText>
        </motion.button>
        <motion.button
          type="button"
          onClick={onToggle}
          className="absolute right-[4px] top-[4px] size-[43px]"
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
              alt={
                open
                  ? t('figma-dashboard.DashboardHeaderControls.36c25d9ffc')
                  : t('figma-dashboard.DashboardHeaderControls.c8a77f9592')
              }
              width={43}
              height={43}
            />
          </motion.span>
        </motion.button>
      </motion.div>
      <div
        className={`relative w-[363px] ${open ? '' : 'pointer-events-none'}`}
        style={{ height: 592 + extra }}
      >
        {options.map((option, index) => (
          <motion.button
            key={option.id}
            type="button"
            disabled={offline && option.id === 'personal' && !personalConfigured}
            title={
              offline && option.id === 'personal' && !personalConfigured
                ? t('common.offlineContour')
                : undefined
            }
            onClick={() => onSelect(option.id)}
            className={`absolute left-0 h-[32px] disabled:cursor-not-allowed disabled:opacity-40 ${option.id === 'personal' && personalConfigured ? 'w-[310px]' : 'w-full'}`}
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
            <FigmaText
              className={`figma-nowrap figma-text-uncropped absolute left-[50px] right-[8px] -top-[4px] overflow-hidden text-ellipsis text-left font-medium text-[20px] ${option.id === 'personal' ? 'client-ai-fill client-ai-text' : 'text-figma-ink'}`}
            >
              {option.label}
            </FigmaText>
          </motion.button>
        ))}
        {personalConfigured && onEditPersonal ? (
          <button
            type="button"
            disabled={offline}
            title={offline ? t('common.offlineContour') : undefined}
            onClick={onEditPersonal}
            aria-label={t('figma-dashboard.DashboardHeaderControls.5cb8591e49')}
            className="absolute right-[18px] flex size-[32px] items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
            style={{ top: 12 + personalIndex * 44 }}
          >
            <span
              aria-hidden
              className="client-ai-fill block size-[24px]"
              style={{
                maskImage: `url(${FIGMA_ASSETS.engEdit})`,
                maskSize: 'contain',
                maskRepeat: 'no-repeat',
                maskPosition: 'center',
              }}
            />
          </button>
        ) : null}
        <PolicySwitch
          on={lunchOn}
          label={t('figma-dashboard.DashboardHeaderControls.e637b4349a')}
          description={t('figma-dashboard.DashboardHeaderControls.9f815f3e6c')}
          top={283 + extra}
          motionOn={motionOn}
          onToggle={onLunchToggle}
        />
        <PolicySwitch
          on={trafficOn}
          label={t('figma-dashboard.DashboardHeaderControls.da5093f3a2')}
          description={t('figma-dashboard.DashboardHeaderControls.c21d123a9b')}
          top={327 + extra}
          motionOn={motionOn}
          onToggle={onTrafficToggle}
        />
        <PolicySwitch
          on={metroOn}
          label={t('figma-dashboard.DashboardHeaderControls.33c7521988')}
          description={t('figma-dashboard.DashboardHeaderControls.c0cd85f550')}
          top={371 + extra}
          motionOn={motionOn}
          onToggle={onMetroToggle}
        />
        <PolicySwitch
          on={equipmentTransfersOn}
          label={t('figma-dashboard.DashboardHeaderControls.31f207a99a')}
          description={t('figma-dashboard.DashboardHeaderControls.d352c95199')}
          top={415 + extra}
          motionOn={motionOn}
          onToggle={onEquipmentTransfersToggle}
        />
        <PolicySwitch
          on={strictTimeWindowsOn}
          label={t('figma-dashboard.DashboardHeaderControls.564d7c0f91')}
          description={t('figma-dashboard.DashboardHeaderControls.0108439215')}
          top={459 + extra}
          motionOn={motionOn}
          onToggle={onStrictTimeWindowsToggle}
        />
        <PolicySwitch
          on={ordinaryReplanningDisabled}
          disabled={replanningSaving}
          label={t('figma-dashboard.DashboardHeaderControls.475e95d6c4')}
          description={
            ordinaryReplanningDisabled
              ? t('figma-dashboard.DashboardHeaderControls.512b38f4e9')
              : t('figma-dashboard.DashboardHeaderControls.21177e15c8')
          }
          top={503 + extra}
          motionOn={motionOn}
          onToggle={onOrdinaryReplanningToggle}
        />
        <button
          type="button"
          onClick={onManualMode}
          className="absolute left-[16px] flex h-[67px] w-[331px] items-center justify-center rounded-[20px] bg-figma-bee p-[20px] transition-transform duration-150 hover:scale-[1.01]"
          style={{ top: 561 + extra }}
        >
          <span className="figma-nowrap font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
            {manualMode
              ? t('figma-dashboard.DashboardHeaderControls.2bb4d0f192')
              : t('figma-dashboard.DashboardHeaderControls.31f5da9ced')}
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
  disabled = false,
}: {
  on: boolean;
  label: string;
  description?: string;
  top: number;
  motionOn: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const tooltipId = useId();
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!hovering && !focused) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), 700);
    return () => window.clearTimeout(timer);
  }, [hovering, focused]);
  return (
    <button
      type="button"
      onClick={() => {
        setShown(false);
        onToggle();
      }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        // The hint hides itself, but Escape keeps travelling: the dispatcher's mouse
        // usually rests on a toggle while the panel is open, and swallowing the key here
        // left Escape doing nothing visible to the panel they meant to close.
        if (event.key === 'Escape' && shown) {
          setShown(false);
          setHovering(false);
          setFocused(false);
        }
      }}
      aria-describedby={shown ? tooltipId : undefined}
      disabled={disabled}
      aria-pressed={on}
      className="absolute left-[16px] flex items-center"
      style={{ top, zIndex: shown ? 30 : undefined }}
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
      <AnimatePresence>
        {shown && description ? (
          <motion.span
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-0 mb-[10px] w-[315px] rounded-[16px] bg-figma-ink px-[14px] py-[12px] text-left text-[14px] font-normal leading-[1.4] text-white shadow-lg"
            initial={motionOn ? { opacity: 0, y: 4 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: motionOn ? 0.16 : 0 }}
          >
            {description}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </button>
  );
}
