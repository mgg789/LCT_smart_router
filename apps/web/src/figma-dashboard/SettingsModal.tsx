import { AnimatePresence, motion } from 'framer-motion';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon } from './primitives';

const fade = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

/**
 * Dispatcher account sheet from the avatar menu.
 * Router lunch/traffic flags stay on the Политики tab.
 */
export function SettingsModal({
  open,
  motionOn,
  dateLabel,
  sourceLabel,
  policyTitle,
  onClose,
}: {
  open: boolean;
  motionOn: boolean;
  dateLabel: string;
  sourceLabel: string;
  policyTitle: string;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="absolute inset-0 z-[100] flex items-center justify-center"
          initial={motionOn ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          exit={motionOn ? { opacity: 0 } : undefined}
          transition={{ duration: 0.2 }}
        >
          <button type="button" className="absolute inset-0 bg-figma-ink/40" aria-label="Закрыть настройки" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="figma-settings-title"
            className="relative flex w-[560px] flex-col rounded-[20px] bg-white px-[30px] pb-[24px] pt-[28px]"
            initial={motionOn ? { opacity: 0, y: 12, scale: 0.98 } : false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={motionOn ? { opacity: 0, y: 8, scale: 0.98 } : undefined}
            transition={fade}
          >
            <div className="flex items-center justify-between">
              <h2
                id="figma-settings-title"
                className="figma-text figma-nowrap font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink"
              >
                Настройки
              </h2>
              <button
                type="button"
                aria-label="Закрыть"
                onClick={onClose}
                className="flex size-[36px] items-center justify-center transition-transform duration-150 hover:scale-110"
              >
                <span className="-rotate-45">
                  <FigmaIcon src={FIGMA_ASSETS.toastCloseInk} alt="" width={20} height={20} />
                </span>
              </button>
            </div>
            <dl className="mt-[24px] flex flex-col gap-[12px]">
              <SettingsRow label="Рабочий день" value={dateLabel} />
              <SettingsRow label="Источник" value={sourceLabel} />
              <SettingsRow label="Политика" value={policyTitle} />
            </dl>
            <p className="mt-[20px] font-medium text-[14px] leading-[20px] text-figma-muted">
              Обеды и пробки переключаются в панели «Политики».
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-[24px] flex h-[56px] w-full items-center justify-center rounded-[20px] bg-figma-ink font-medium text-[18px] text-white transition-transform duration-150 hover:scale-[1.01]"
            >
              Закрыть
            </button>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-[56px] items-center justify-between rounded-[20px] bg-figma-soft px-[18px]">
      <dt className="font-medium text-[16px] text-figma-muted">{label}</dt>
      <dd className="figma-nowrap font-semibold text-[16px] text-figma-ink">{value}</dd>
    </div>
  );
}
