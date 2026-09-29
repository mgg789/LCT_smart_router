import { AnimatePresence, motion } from 'framer-motion';
import { useRef } from 'react';
import { MonthlyPoints } from '../components/passports/MonthlyPoints';
import { useModalFocus } from '../components/useModalFocus';
import { isNavixOffline } from '../domain/mapAvailability';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { t } from '../i18n';
import { ENGINEER_ASSETS } from './assets';
import { formatPlanWindow } from './engineerClock';
import type { EngineerLunchItem } from './engineerDay';
import { eu } from './engineerScale';

const ease = [0.22, 1, 0.36, 1] as const;

export type EngineerMenuId = 'day' | 'assistant' | 'settings';

/**
 * Left drawer from Figma MAIN MENU 72:9315 — profile, day sections,
 * lunch row, technical break and support.
 */
export function EngineerMenu({
  token,
  open,
  motionOn,
  name,
  email,
  chatUnread = false,
  chatNotice = null,
  active,
  lunch,
  breakActive,
  breakPending,
  onClose,
  docked,
  onNavigate,
  onBreak,
  onSupport,
  onSignOut,
}: {
  token?: string;
  open: boolean;
  motionOn: boolean;
  name: string;
  email: string;
  /** Yellow dot on «Помощник» while a line is waiting. Cleared once that screen is open. */
  chatUnread?: boolean;
  /** Short preview of the waiting line, shown under the menu item. */
  chatNotice?: string | null;
  active: EngineerMenuId;
  lunch: EngineerLunchItem | null;
  breakActive: boolean;
  breakPending: boolean;
  onClose: () => void;
  /** Docked in the desk's rail: always open, no backdrop, no way to close. */
  docked?: boolean;
  onNavigate: (id: EngineerMenuId) => void;
  onBreak: () => void;
  onSupport: () => void;
  onSignOut: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  useModalFocus(dialog, open && !docked, onClose);
  if (docked) {
    return (
      <aside
        aria-label={t('figma-engineer.EngineerMenu.e88b3ec189')}
        className="phone-desk-menu flex h-full w-full flex-col overflow-y-auto bg-white"
      >
        <img
          alt=""
          src={ENGINEER_ASSETS.menuBlobs}
          className="pointer-events-none absolute bottom-0 left-0 z-0 w-full max-w-none"
        />
        <div className="relative z-10 shrink-0 bg-figma-ink" style={{ height: eu(445) }} />
        <div
          className="relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto"
          style={{ padding: `${eu(24)} ${eu(20)} ${eu(28)}` }}
        >
          <p
            className="relative break-words font-murs tracking-[0.02em] text-figma-ink"
            style={{ fontSize: eu(32) }}
          >
            {name}
          </p>
          <p
            className="relative break-all font-semibold tracking-[-0.02em] text-figma-muted"
            style={{ marginTop: eu(8), fontSize: eu(24) }}
          >
            {email}
          </p>
          {token ? (
            <div className="mt-4">
              <MonthlyPoints token={token} />
            </div>
          ) : null}
          <nav className="relative flex flex-col" style={{ marginTop: eu(28), gap: eu(20) }}>
            <MenuItem
              label={t('figma-engineer.EngineerMenu.be15b21d03')}
              icon={ENGINEER_ASSETS.house}
              iconWidth={32}
              iconHeight={32}
              active={active === 'day'}
              onClick={() => onNavigate('day')}
            />
            <MenuItem
              label={t('figma-engineer.EngineerMenu.b798a37544')}
              icon={ENGINEER_ASSETS.assistant}
              iconWidth={30}
              iconHeight={33}
              active={active === 'assistant'}
              onClick={() => onNavigate('assistant')}
              disabled={isNavixOffline()}
              dot={chatUnread && active !== 'assistant'}
            />
            {chatUnread && active !== 'assistant' && chatNotice ? (
              <p
                className="font-semibold text-figma-ink"
                style={{
                  marginTop: eu(-8),
                  marginLeft: eu(76),
                  fontSize: eu(16),
                  color: '#8a6a00',
                }}
              >
                {t('components.ai.chatNotice')}
              </p>
            ) : null}
            <MenuItem
              label={t('figma-engineer.EngineerMenu.985b5e0f2c')}
              icon={ENGINEER_ASSETS.gear}
              iconWidth={32}
              iconHeight={32}
              active={active === 'settings'}
              onClick={() => onNavigate('settings')}
            />
          </nav>
          <div className="relative w-full" style={{ marginTop: eu(28), height: eu(4) }}>
            <FigmaIcon
              src={ENGINEER_ASSETS.menuLine}
              alt=""
              width={461}
              height={4}
              style={{ width: '100%', height: eu(4) }}
            />
          </div>
          {lunch ? (
            <div
              className="relative flex items-center"
              style={{ marginTop: eu(24), gap: eu(20), paddingLeft: eu(24) }}
            >
              <FigmaIcon
                src={ENGINEER_ASSETS.lunch}
                alt=""
                width={32}
                height={32}
                style={{ width: eu(32), height: eu(32) }}
              />
              <p
                className="font-murs tracking-[-0.03em] text-figma-ink"
                style={{ fontSize: eu(28) }}
              >
                {t('figma-engineer.EngineerMenu.69a29fbff8')}
              </p>
              <p
                className="font-semibold tracking-[-0.03em] text-figma-dim"
                style={{ fontSize: eu(20), position: 'relative', top: 2 }}
              >
                {formatPlanWindow(lunch.startAt, lunch.endAt)}
              </p>
            </div>
          ) : null}
          <div
            className="relative mt-auto flex flex-col"
            style={{ gap: eu(20), paddingTop: eu(28) }}
          >
            <motion.button
              type="button"
              disabled={breakPending}
              onClick={onBreak}
              whileTap={{ scale: 0.98 }}
              className="flex w-full items-center justify-center border border-figma-ink bg-white disabled:opacity-60"
              style={{
                height: eu(80),
                maxWidth: eu(372),
                gap: eu(16),
                borderRadius: eu(20),
              }}
            >
              <FigmaIcon
                src={ENGINEER_ASSETS.pause}
                alt=""
                width={32}
                height={32}
                style={{ width: eu(32), height: eu(32) }}
              />
              <span
                className="font-murs tracking-[-0.03em] text-figma-ink"
                style={{ fontSize: eu(28) }}
              >
                {breakActive
                  ? t('figma-engineer.EngineerMenu.df34119b0e')
                  : t('figma-engineer.EngineerMenu.c982686d5c')}
              </span>
            </motion.button>
            <motion.button
              type="button"
              onClick={onSupport}
              whileTap={{ scale: 0.98 }}
              className="flex items-center justify-center self-start bg-figma-bee font-semibold tracking-[-0.03em] text-figma-ink"
              style={{
                height: eu(80),
                paddingLeft: eu(32),
                paddingRight: eu(32),
                borderRadius: eu(20),
                fontSize: eu(28),
              }}
            >
              {t('figma-engineer.EngineerMenu.dbe91db5dc')}
            </motion.button>
            <button
              type="button"
              onClick={onSignOut}
              className="self-start bg-white font-semibold text-figma-muted"
              style={{
                fontSize: eu(20),
                borderRadius: eu(999),
                padding: `${eu(10)} ${eu(22)}`,
              }}
            >
              {t('figma-engineer.EngineerMenu.5690c2e63b')}
            </button>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="absolute inset-0 z-40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={motionOn ? { duration: 0.2 } : { duration: 0 }}
        >
          <button
            type="button"
            aria-label={t('figma-engineer.EngineerMenu.980d22e392')}
            tabIndex={-1}
            onClick={onClose}
            className="absolute inset-0 z-0 bg-black/60 backdrop-blur-[10px]"
          />
          <motion.aside
            ref={dialog}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-label={t('figma-engineer.EngineerMenu.e88b3ec189')}
            initial={motionOn ? { x: '-100%' } : false}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={motionOn ? { duration: 0.34, ease } : { duration: 0 }}
            className="absolute inset-y-0 left-0 z-10 flex h-full flex-col overflow-hidden bg-white"
            style={{
              width: eu(501),
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              borderTopRightRadius: eu(26),
              borderBottomRightRadius: eu(26),
            }}
          >
            <img
              alt=""
              src={ENGINEER_ASSETS.menuBlobs}
              className="pointer-events-none absolute bottom-0 left-0 z-0 w-full max-w-none"
            />
            <div className="relative z-10 shrink-0 bg-figma-ink" style={{ height: eu(445) }} />
            <div
              className="relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto"
              style={{ padding: `${eu(24)} ${eu(20)} ${eu(28)}` }}
            >
              <p
                className="relative break-words font-murs tracking-[0.02em] text-figma-ink"
                style={{ fontSize: eu(32) }}
              >
                {name}
              </p>
              <p
                className="relative break-all font-semibold tracking-[-0.02em] text-figma-muted"
                style={{ marginTop: eu(8), fontSize: eu(24) }}
              >
                {email}
              </p>
              {token ? (
                <div className="mt-4">
                  <MonthlyPoints token={token} />
                </div>
              ) : null}
              <nav className="relative flex flex-col" style={{ marginTop: eu(28), gap: eu(20) }}>
                <MenuItem
                  label={t('figma-engineer.EngineerMenu.be15b21d03')}
                  icon={ENGINEER_ASSETS.house}
                  iconWidth={32}
                  iconHeight={32}
                  active={active === 'day'}
                  onClick={() => onNavigate('day')}
                />
                <MenuItem
                  label={t('figma-engineer.EngineerMenu.b798a37544')}
                  icon={ENGINEER_ASSETS.assistant}
                  iconWidth={30}
                  iconHeight={33}
                  active={active === 'assistant'}
                  onClick={() => onNavigate('assistant')}
                  dot={chatUnread && active !== 'assistant'}
                />
                {chatUnread && active !== 'assistant' && chatNotice ? (
                  <p className="font-semibold" style={{ marginLeft: eu(76), fontSize: eu(16), color: '#8a6a00' }}>
                    {t('components.ai.chatNotice')}
                  </p>
                ) : null}
                <MenuItem
                  label={t('figma-engineer.EngineerMenu.985b5e0f2c')}
                  icon={ENGINEER_ASSETS.gear}
                  iconWidth={32}
                  iconHeight={32}
                  active={active === 'settings'}
                  onClick={() => onNavigate('settings')}
                />
              </nav>
              <div className="relative w-full" style={{ marginTop: eu(28), height: eu(4) }}>
                <FigmaIcon
                  src={ENGINEER_ASSETS.menuLine}
                  alt=""
                  width={461}
                  height={4}
                  style={{ width: '100%', height: eu(4) }}
                />
              </div>
              {lunch ? (
                <div
                  className="relative flex items-center"
                  style={{ marginTop: eu(24), gap: eu(20), paddingLeft: eu(24) }}
                >
                  <FigmaIcon
                    src={ENGINEER_ASSETS.lunch}
                    alt=""
                    width={32}
                    height={32}
                    style={{ width: eu(32), height: eu(32) }}
                  />
                  <p
                    className="font-murs tracking-[-0.03em] text-figma-ink"
                    style={{ fontSize: eu(28) }}
                  >
                    {t('figma-engineer.EngineerMenu.69a29fbff8')}
                  </p>
                  <p
                    className="font-semibold tracking-[-0.03em] text-figma-dim"
                    style={{ fontSize: eu(20), position: 'relative', top: 2 }}
                  >
                    {formatPlanWindow(lunch.startAt, lunch.endAt)}
                  </p>
                </div>
              ) : null}
              <div
                className="relative mt-auto flex flex-col"
                style={{ gap: eu(20), paddingTop: eu(28) }}
              >
                <motion.button
                  type="button"
                  disabled={breakPending}
                  onClick={onBreak}
                  whileTap={{ scale: 0.98 }}
                  className="flex w-full items-center justify-center border border-figma-ink bg-white disabled:opacity-60"
                  style={{
                    height: eu(80),
                    maxWidth: eu(372),
                    gap: eu(16),
                    borderRadius: eu(20),
                  }}
                >
                  <FigmaIcon
                    src={ENGINEER_ASSETS.pause}
                    alt=""
                    width={32}
                    height={32}
                    style={{ width: eu(32), height: eu(32) }}
                  />
                  <span
                    className="font-murs tracking-[-0.03em] text-figma-ink"
                    style={{ fontSize: eu(28) }}
                  >
                    {breakActive
                      ? t('figma-engineer.EngineerMenu.df34119b0e')
                      : t('figma-engineer.EngineerMenu.c982686d5c')}
                  </span>
                </motion.button>
                <motion.button
                  type="button"
                  onClick={onSupport}
                  whileTap={{ scale: 0.98 }}
                  className="flex items-center justify-center self-start bg-figma-bee font-semibold tracking-[-0.03em] text-figma-ink"
                  style={{
                    height: eu(80),
                    paddingLeft: eu(32),
                    paddingRight: eu(32),
                    borderRadius: eu(20),
                    fontSize: eu(28),
                  }}
                >
                  {t('figma-engineer.EngineerMenu.dbe91db5dc')}
                </motion.button>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="self-start bg-white font-semibold text-figma-muted"
                  style={{
                    fontSize: eu(20),
                    borderRadius: eu(999),
                    padding: `${eu(10)} ${eu(22)}`,
                  }}
                >
                  {t('figma-engineer.EngineerMenu.5690c2e63b')}
                </button>
              </div>
            </div>
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function MenuItem({
  label,
  icon,
  iconWidth,
  iconHeight,
  active,
  onClick,
  disabled = false,
  dot = false,
}: {
  label: string;
  icon: string;
  iconWidth: number;
  iconHeight: number;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  dot?: boolean;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      disabled={disabled}
      title={disabled ? t('common.offlineContour') : undefined}
      onClick={onClick}
      className={`flex w-full items-center disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'bg-figma-track' : ''}`}
      style={{
        gap: eu(20),
        borderRadius: eu(14),
        padding: `${eu(20)} ${eu(24)}`,
      }}
    >
      <span className="flex items-center justify-center" style={{ width: eu(32), height: eu(32) }}>
        <FigmaIcon
          src={icon}
          alt=""
          width={iconWidth}
          height={iconHeight}
          style={{ width: eu(iconWidth), height: eu(iconHeight) }}
        />
      </span>
      <span
        className="font-semibold tracking-[-0.02em] text-figma-ink"
        style={{ fontSize: eu(26) }}
      >
        {label}
      </span>
      {dot ? (
        <span
          aria-hidden
          className="ml-auto shrink-0 rounded-full bg-figma-bee"
          style={{ width: eu(12), height: eu(12) }}
        />
      ) : null}
    </button>
  );
}
