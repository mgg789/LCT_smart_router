import { AnimatePresence, motion } from 'framer-motion';
import { FigmaIcon } from '../figma-dashboard/primitives';
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
  open,
  motionOn,
  name,
  email,
  active,
  lunch,
  breakActive,
  breakPending,
  onClose,
  onNavigate,
  onBreak,
  onSupport,
  onSignOut,
}: {
  open: boolean;
  motionOn: boolean;
  name: string;
  email: string;
  active: EngineerMenuId;
  lunch: EngineerLunchItem | null;
  breakActive: boolean;
  breakPending: boolean;
  onClose: () => void;
  onNavigate: (id: EngineerMenuId) => void;
  onBreak: () => void;
  onSupport: () => void;
  onSignOut: () => void;
}) {
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
            aria-label="Закрыть меню"
            onClick={onClose}
            className="absolute inset-0 z-0 bg-black/60 backdrop-blur-[10px]"
          />
          <motion.aside
            role="dialog"
            aria-label="Меню инженера"
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
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-0 left-0 z-[1] bg-white"
              style={{ width: eu(220), height: eu(180) }}
            />
            <div className="relative z-10 shrink-0 bg-figma-ink" style={{ height: eu(445) }} />
            <div
              className="relative z-10 flex min-h-0 flex-1 flex-col"
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
              <nav className="relative flex flex-col" style={{ marginTop: eu(28), gap: eu(20) }}>
                <MenuItem
                  label="Мой день"
                  icon={ENGINEER_ASSETS.house}
                  iconWidth={32}
                  iconHeight={32}
                  active={active === 'day'}
                  onClick={() => onNavigate('day')}
                />
                <MenuItem
                  label="Помощник"
                  icon={ENGINEER_ASSETS.assistant}
                  iconWidth={30}
                  iconHeight={33}
                  active={active === 'assistant'}
                  onClick={() => onNavigate('assistant')}
                />
                <MenuItem
                  label="Настройки"
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
                    Обед
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
                    {breakActive ? 'Завершить перерыв' : 'Тех. перерыв'}
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
                  Написать в поддержку
                </motion.button>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="self-start font-semibold text-figma-muted"
                  style={{ fontSize: eu(20) }}
                >
                  Выйти
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
}: {
  label: string;
  icon: string;
  iconWidth: number;
  iconHeight: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={`flex w-full items-center ${active ? 'bg-figma-track' : ''}`}
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
    </button>
  );
}
