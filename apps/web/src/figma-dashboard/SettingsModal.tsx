import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';
import { FIGMA_ASSETS } from './assets';
import { type DispatcherSettings, readDispatcherSettings, validateDispatcherSettings } from './dispatcherSettings';
import { FigmaIcon } from './primitives';

const fade = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };
const FIELD =
  'mt-[8px] h-[56px] w-full rounded-[20px] border border-figma-ink/15 bg-white px-[18px] font-medium text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint focus:border-figma-ink';

/**
 * Dispatcher settings: shift clocks, 0–15 min lateness, 2GIS/Yandex token.
 * Hours and the token stay in localStorage; lateness can also update Router.
 */
export function SettingsModal({
  open,
  motionOn,
  latenessMin,
  submitting,
  onClose,
  onSave,
}: {
  open: boolean;
  motionOn: boolean;
  latenessMin: number;
  submitting: boolean;
  onClose: () => void;
  onSave: (settings: DispatcherSettings) => void;
}) {
  const [draft, setDraft] = useState<DispatcherSettings>(() => readDispatcherSettings(window.localStorage));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const stored = readDispatcherSettings(window.localStorage);
    setDraft({ ...stored, latenessMin });
    setError(null);
  }, [latenessMin, open]);

  const setField = <K extends keyof DispatcherSettings>(key: K, value: DispatcherSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

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
          <button
            type="button"
            className="absolute inset-0 bg-figma-ink/40"
            aria-label="Закрыть настройки"
            disabled={submitting}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="figma-settings-title"
            className="relative flex max-h-[980px] w-[560px] flex-col overflow-hidden rounded-[20px] bg-white px-[30px] pb-[24px] pt-[28px]"
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
                disabled={submitting}
                onClick={onClose}
                className="flex size-[36px] items-center justify-center transition-transform duration-150 hover:scale-110 disabled:opacity-50"
              >
                <span className="-rotate-45">
                  <FigmaIcon src={FIGMA_ASSETS.toastCloseInk} alt="" width={20} height={20} />
                </span>
              </button>
            </div>

            <form
              className="mt-[8px] min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]"
              onSubmit={(event) => {
                event.preventDefault();
                const problem = validateDispatcherSettings(draft);
                if (problem) {
                  setError(problem);
                  return;
                }
                setError(null);
                onSave(draft);
              }}
            >
              <div className="grid grid-cols-2 gap-[16px]">
                <Field label="Начало дня" htmlFor="settings-shift-start">
                  <input
                    id="settings-shift-start"
                    type="time"
                    value={draft.shiftStart}
                    onChange={(event) => setField('shiftStart', event.target.value)}
                    className={FIELD}
                  />
                </Field>
                <Field label="Конец дня" htmlFor="settings-shift-end">
                  <input
                    id="settings-shift-end"
                    type="time"
                    value={draft.shiftEnd}
                    onChange={(event) => setField('shiftEnd', event.target.value)}
                    className={FIELD}
                  />
                </Field>
              </div>

              <Field label="Допустимое опоздание, мин" htmlFor="settings-lateness">
                <input
                  id="settings-lateness"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={15}
                  step={1}
                  value={draft.latenessMin}
                  onChange={(event) => {
                    const next = event.target.value === '' ? 0 : Number(event.target.value);
                    setField('latenessMin', next);
                  }}
                  className={FIELD}
                />
              </Field>

              <p className="mt-[20px] font-semibold text-[16px] text-figma-ink">API карт</p>
              <div className="mt-[8px] flex rounded-[20px] bg-figma-track p-[4px]">
                <ProviderChip
                  active={draft.mapProvider === '2gis'}
                  onClick={() => setField('mapProvider', '2gis')}
                >
                  2ГИС
                </ProviderChip>
                <ProviderChip
                  active={draft.mapProvider === 'yandex'}
                  onClick={() => setField('mapProvider', 'yandex')}
                >
                  Яндекс
                </ProviderChip>
              </div>

              <Field
                label={draft.mapProvider === 'yandex' ? 'Токен Яндекс' : 'Токен 2ГИС'}
                htmlFor="settings-map-token"
              >
                <input
                  id="settings-map-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.mapToken}
                  placeholder="Ключ API"
                  onChange={(event) => setField('mapToken', event.target.value.trim())}
                  className={FIELD}
                />
              </Field>

              {error ? (
                <p role="alert" className="mt-[16px] font-medium text-[15px] text-figma-danger">
                  {error}
                </p>
              ) : (
                <p className="mt-[16px] font-medium text-[14px] leading-[20px] text-figma-muted">
                  Часы смены и токен хранятся в этом браузере. Опоздание в живом контуре уходит в
                  допуск окна Router (0–15 мин).
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className={`mt-[20px] flex h-[56px] w-full items-center justify-center rounded-[20px] font-medium text-[18px] transition-transform duration-150 ${
                  submitting ? 'bg-figma-track text-figma-hint' : 'bg-figma-bee text-figma-ink hover:scale-[1.01]'
                }`}
              >
                {submitting ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </form>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <label className="mt-[20px] block font-semibold text-[16px] text-figma-ink" htmlFor={htmlFor}>
      {label}
      {children}
    </label>
  );
}

function ProviderChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-[48px] flex-1 items-center justify-center rounded-[16px] font-semibold text-[16px] transition-colors duration-150 ${
        active ? 'bg-white text-figma-ink shadow-[0_4px_12px_rgba(39,41,48,0.08)]' : 'text-figma-muted'
      }`}
    >
      {children}
    </button>
  );
}
