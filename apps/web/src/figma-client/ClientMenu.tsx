import { AnimatePresence, motion } from 'framer-motion';
import { useRef } from 'react';
import { useModalFocus } from '../components/useModalFocus';
import { isNavixOffline } from '../domain/mapAvailability';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { eu } from '../figma-engineer/engineerScale';
import { t } from '../i18n';
import { CLIENT_ASSETS } from './assets';
import type { ClientScreenId } from './clientPreview';

const ease = [0.22, 1, 0.36, 1] as const;

/**
 * Left drawer from Figma MAIN MENU 115:843 — email, requests / support,
 * yellow «Новая заявка». Flush to the phone's left and bottom corners.
 */
export function ClientMenu({
  open,
  motionOn,
  email,
  active,
  onClose,
  docked,
  onNavigate,
  onNewRequest,
  onSignOut,
}: {
  open: boolean;
  motionOn: boolean;
  email: string | null;
  active: ClientScreenId;
  onClose: () => void;
  /** Docked in the desk's rail: always open, no backdrop, no way to close. */
  docked?: boolean;
  onNavigate: (id: ClientScreenId) => void;
  onNewRequest: () => void;
  /** The engineer's menu has always had this; the customer's had no way out at all. */
  onSignOut: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  useModalFocus(dialog, open && !docked, onClose);
  if (docked) {
    return (
      <aside
        aria-label={t('figma-client.ClientMenu.269f519580')}
        className="phone-desk-menu flex h-full w-full flex-col overflow-y-auto bg-white"
      >
        <div
          className="relative z-10 flex shrink-0 flex-col items-center justify-center bg-figma-ink"
          style={{ height: eu(445), gap: eu(20) }}
        >
          <FigmaIcon
            src={CLIENT_ASSETS.logo}
            alt=""
            width={170}
            height={170}
            className="brightness-0 invert"
            style={{ width: eu(140), height: eu(140) }}
          />
        </div>
        <div
          className="relative z-10 flex min-h-0 flex-1 flex-col bg-white"
          style={{ padding: `${eu(24)} ${eu(20)} ${eu(28)}` }}
        >
          {email ? (
            <p
              className="relative break-all font-semibold tracking-[-0.02em] text-figma-muted"
              style={{ fontSize: eu(24) }}
            >
              {email}
            </p>
          ) : null}
          <nav className="relative flex flex-col" style={{ marginTop: eu(28), gap: eu(20) }}>
            <MenuItem
              label={t('figma-client.ClientMenu.39f6d85e6e')}
              icon={CLIENT_ASSETS.list}
              iconWidth={28}
              iconHeight={21}
              active={active === 'list'}
              onClick={() => onNavigate('list')}
            />
            <MenuItem
              label={t('figma-client.ClientMenu.f0012086d5')}
              icon={CLIENT_ASSETS.support}
              iconWidth={30}
              iconHeight={33}
              active={active === 'support'}
              disabled={isNavixOffline()}
              onClick={() => onNavigate('support')}
            />
          </nav>
          <div
            className="relative mt-auto flex flex-col bg-white"
            style={{ gap: eu(20), paddingTop: eu(28) }}
          >
            <motion.button
              type="button"
              onClick={onNewRequest}
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
              {t('figma-client.ClientMenu.ee5790e7f4')}
            </motion.button>
            <button
              type="button"
              onClick={onSignOut}
              className="self-start bg-white font-semibold text-figma-muted"
              style={{ fontSize: eu(20), borderRadius: eu(999), padding: `${eu(10)} ${eu(22)}` }}
            >
              {t('figma-client.ClientMenu.5690c2e63b')}
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
            aria-label={t('figma-client.ClientMenu.980d22e392')}
            tabIndex={-1}
            onClick={onClose}
            className="absolute inset-0 z-0 bg-black/60 backdrop-blur-[10px]"
          />
          <motion.aside
            ref={dialog}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            aria-label={t('figma-client.ClientMenu.269f519580')}
            initial={motionOn ? { x: '-100%' } : false}
            animate={{ x: 0 }}
            exit={{ x: '-100%' }}
            transition={motionOn ? { duration: 0.34, ease } : { duration: 0 }}
            className="absolute inset-y-0 left-0 z-10 flex h-full flex-col overflow-hidden bg-white"
            style={{
              width: eu(501),
              borderTopRightRadius: eu(26),
              borderBottomRightRadius: eu(26),
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
            }}
          >
            <div
              className="relative z-10 flex shrink-0 flex-col items-center justify-center bg-figma-ink"
              style={{ height: eu(445), gap: eu(20) }}
            >
              <FigmaIcon
                src={CLIENT_ASSETS.logo}
                alt=""
                width={170}
                height={170}
                className="brightness-0 invert"
                style={{ width: eu(140), height: eu(140) }}
              />
            </div>
            <div
              className="relative z-10 flex min-h-0 flex-1 flex-col bg-white"
              style={{ padding: `${eu(24)} ${eu(20)} ${eu(28)}` }}
            >
              {email ? (
                <p
                  className="relative break-all font-semibold tracking-[-0.02em] text-figma-muted"
                  style={{ fontSize: eu(24) }}
                >
                  {email}
                </p>
              ) : null}
              <nav className="relative flex flex-col" style={{ marginTop: eu(28), gap: eu(20) }}>
                <MenuItem
                  label={t('figma-client.ClientMenu.39f6d85e6e')}
                  icon={CLIENT_ASSETS.list}
                  iconWidth={28}
                  iconHeight={21}
                  active={active === 'list'}
                  onClick={() => onNavigate('list')}
                />
                <MenuItem
                  label={t('figma-client.ClientMenu.f0012086d5')}
                  icon={CLIENT_ASSETS.support}
                  iconWidth={30}
                  iconHeight={33}
                  active={active === 'support'}
                  disabled={isNavixOffline()}
                  onClick={() => onNavigate('support')}
                />
              </nav>
              <div
                className="relative mt-auto flex flex-col bg-white"
                style={{ gap: eu(20), paddingTop: eu(28) }}
              >
                <motion.button
                  type="button"
                  onClick={onNewRequest}
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
                  {t('figma-client.ClientMenu.ee5790e7f4')}
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
                  {t('figma-client.ClientMenu.5690c2e63b')}
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
  disabled = false,
  onClick,
}: {
  label: string;
  icon: string;
  iconWidth: number;
  iconHeight: number;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      aria-disabled={disabled}
      disabled={disabled}
      title={
        disabled
          ? isNavixOffline()
            ? t('common.offlineContour')
            : t('figma-client.ClientMenu.72c299e0d6')
          : undefined
      }
      onClick={onClick}
      className={`flex w-full items-center ${active ? 'bg-figma-track' : ''} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
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
