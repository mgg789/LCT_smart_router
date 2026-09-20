import { motion } from 'framer-motion';
import { useEffect, useId, useRef, useState } from 'react';
import { FIGMA_ASSETS } from './assets';
import {
  DANGER_ACTIONS,
  type DangerActionId,
  isManualConfirmInput,
  phraseMatches,
} from './confirmPhrase';
import { ModalLayer, ModalScrim } from './modalLayer';
import { FigmaIcon } from './primitives';

const fade = { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const };

/**
 * Phrase-gated confirm for destructive dispatcher actions.
 * The field rejects paste/drop and accepts only typed keystrokes.
 */
export function ConfirmDangerModal({
  actionId,
  motionOn,
  onCancel,
  onConfirm,
}: {
  actionId: DangerActionId | null;
  motionOn: boolean;
  onCancel: () => void;
  onConfirm: (id: DangerActionId) => void;
}) {
  const liveAction = actionId ? DANGER_ACTIONS[actionId] : null;
  const heldAction = useRef(liveAction);
  if (liveAction) heldAction.current = liveAction;
  const action = liveAction ?? heldAction.current;
  const titleId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    setTyped('');
    if (!actionId) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [actionId]);

  const ready = action ? phraseMatches(typed, action.word) : false;

  return (
    <ModalLayer open={actionId !== null} motionOn={motionOn} zClass="z-[110]">
      {action ? (
        <>
          <ModalScrim label="Закрыть подтверждение" onClose={onCancel} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative flex w-[560px] flex-col rounded-[20px] bg-white px-[30px] pb-[24px] pt-[28px]"
            initial={motionOn ? { opacity: 0, y: 12, scale: 0.98 } : false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={motionOn ? { opacity: 0, y: 8, scale: 0.98 } : undefined}
            transition={fade}
          >
            <div className="flex items-start justify-between gap-[16px]">
              <h2
                id={titleId}
                className="figma-text font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink"
              >
                {action.title}
              </h2>
              <button
                type="button"
                aria-label="Закрыть"
                onClick={onCancel}
                className="flex size-[36px] shrink-0 items-center justify-center transition-transform duration-150 hover:scale-110"
              >
                <span className="-rotate-45">
                  <FigmaIcon src={FIGMA_ASSETS.toastCloseInk} alt="" width={20} height={20} />
                </span>
              </button>
            </div>
            <p className="mt-[20px] font-medium text-[16px] leading-[22px] text-figma-dim">
              {action.warning}
            </p>
            <p className="mt-[22px] font-medium text-[16px] text-figma-ink">
              Введите слово{' '}
              <span className="rounded-[8px] bg-figma-soft px-[8px] py-[2px] font-semibold tracking-[0.6px]">
                {action.word}
              </span>{' '}
              в поле ниже.
            </p>
            <label htmlFor={inputId} className="sr-only">
              Слово подтверждения
            </label>
            <input
              id={inputId}
              ref={inputRef}
              value={typed}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              name="confirm-phrase"
              placeholder="Введите слово вручную"
              className="mt-[12px] h-[56px] w-full rounded-[20px] border border-figma-ink/15 bg-white px-[18px] font-medium text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint focus:border-figma-ink"
              onPaste={(event) => event.preventDefault()}
              onDrop={(event) => event.preventDefault()}
              onBeforeInput={(event) => {
                const inputType =
                  'inputType' in event.nativeEvent
                    ? String(event.nativeEvent.inputType)
                    : 'insertText';
                if (!isManualConfirmInput(inputType)) event.preventDefault();
              }}
              onChange={(event) => setTyped(event.target.value)}
            />
            <div className="mt-[24px] flex gap-[12px]">
              <button
                type="button"
                onClick={onCancel}
                className="flex h-[56px] flex-1 items-center justify-center rounded-[20px] bg-figma-track font-medium text-[18px] text-figma-ink transition-transform duration-150 hover:scale-[1.01]"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={!ready}
                onClick={() => onConfirm(action.id)}
                className={`flex h-[56px] flex-1 items-center justify-center rounded-[20px] font-medium text-[18px] transition-transform duration-150 ${
                  ready
                    ? action.tone === 'bee'
                      ? 'bg-figma-bee text-figma-ink hover:scale-[1.01]'
                      : 'bg-figma-danger text-white hover:scale-[1.01]'
                    : 'bg-figma-track text-figma-hint'
                }`}
              >
                {action.confirmLabel}
              </button>
            </div>
          </motion.div>
        </>
      ) : null}
    </ModalLayer>
  );
}
